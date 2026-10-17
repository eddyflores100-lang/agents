import { Hono } from "hono";
import { Agent, callable, routeAgentRequest } from "agents";
import { wrapFetchWithPayment } from "@x402/fetch";
import { paymentMiddleware, x402ResourceServer } from "@x402/hono";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { registerExactEvmScheme as registerClientEvmScheme } from "@x402/evm/exact/client";
import { registerExactEvmScheme as registerServerEvmScheme } from "@x402/evm/exact/server";
import { toClientEvmSigner } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";
import sampleCard from "./sample-card.json";

// The seller's published ATC card. In a real deployment this lives at the
// seller's agentURI (e.g. https://seller.example/agent-card.json).
const SAMPLE_CARD = sampleCard;

// Trust policy: the minimum band the buyer accepts before spending.
// Bands are ordered B0 < B1 < B2 < B3 < A1 (higher is more trusted).
const BAND_RANK: Record<string, number> = { B0: 0, B1: 1, B2: 2, B3: 3, A1: 4 };

function bandRank(band: string | undefined | null): number {
  if (!band) return -1;
  return BAND_RANK[String(band).toUpperCase()] ?? -1;
}

export interface TrustStep {
  step: string;
  ok: boolean;
  detail: string;
}

export interface TrustFlowResult {
  spent: boolean;
  verdict_id?: string;
  band?: string;
  steps: TrustStep[];
}

type PayingFetch = ReturnType<typeof wrapFetchWithPayment>;

/**
 * Verify the seller's ATC card against a UTA verifier BEFORE paying.
 *
 * Fail-closed invariant: if the verifier is unreachable, returns an HTTP
 * error, non-JSON, omits the trust band, or returns a band below the
 * policy threshold — the flow aborts and NO payment is ever built or sent.
 */
export async function verifySellerTrust(
  payingFetch: PayingFetch,
  card: unknown,
  minBand: string
): Promise<{ allow: boolean; reason: string; verdict_id?: string; band?: string }> {
  const verifyUrl =
    process.env.UTA_VERIFY_URL ??
    "https://uta-trust-api.eddyflores100.workers.dev/v1/trust/verify";

  let res: Response;
  try {
    // The verify call itself is x402-native: it pays the verifier per call
    // (0.01 USDC) with the same client that would pay the resource.
    res = await payingFetch(verifyUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ card })
    } as RequestInit);
  } catch (e) {
    return { allow: false, reason: `verifier unreachable (${(e as Error).message})` };
  }

  let verdict: Record<string, unknown>;
  try {
    verdict = (await res.json()) as Record<string, unknown>;
  } catch {
    return { allow: false, reason: `verifier returned non-JSON (HTTP ${res.status})` };
  }
  if (!res.ok) {
    return { allow: false, reason: `verifier HTTP ${res.status}` };
  }

  const verified = (verdict.verified ?? verdict.valid) as boolean | undefined;
  const risk = verdict.risk as Record<string, unknown> | undefined;
  const band = (verdict.band ?? risk?.band ?? null) as string | null;
  const verdictId = (verdict.verdict_id ?? verdict.verdictId ?? null) as string | null;

  if (verified === false) {
    return { allow: false, reason: "card did not verify", verdict_id: verdictId ?? undefined };
  }
  if (band === null || band === undefined) {
    // No band while a band is required — deny, never guess.
    return { allow: false, reason: "missing trust band in verdict", verdict_id: verdictId ?? undefined };
  }
  if (bandRank(band) < bandRank(minBand)) {
    return {
      allow: false,
      reason: `trust band ${band} below policy minimum ${minBand}`,
      verdict_id: verdictId ?? undefined
    };
  }
  return { allow: true, reason: `band ${band} meets policy minimum ${minBand}`, verdict_id: verdictId ?? undefined, band };
}

/**
 * The full buyer-side flow: probe → 402 → verify seller → settle.
 * Each step is recorded so the UI can show exactly what happened.
 */
export async function runTrustFlow(payingFetch: PayingFetch, paidUrl: string): Promise<TrustFlowResult> {
  const minBand = process.env.MIN_TRUST_BAND ?? "B1";
  const steps: TrustStep[] = [];

  // 1. Probe the paid resource with a plain fetch — expect 402.
  const probe = await fetch(paidUrl);
  steps.push({
    step: "1. GET paid resource",
    ok: probe.status === 402,
    detail: `HTTP ${probe.status}${probe.status === 402 ? " — payment required (expected)" : " — unexpected"}`
  });
  if (probe.status !== 402) {
    return { spent: false, steps };
  }

  // 2. Resolve the seller's ATC card (here: served by the same demo worker).
  const cardUrl = new URL("/agent-card.json", paidUrl).toString();
  const cardRes = await fetch(cardUrl);
  const card = (await cardRes.json()) as unknown;
  steps.push({
    step: "2. GET seller ATC card",
    ok: cardRes.ok,
    detail: `${cardRes.ok ? "card loaded" : `HTTP ${cardRes.status}`} from ${cardUrl}`
  });

  // 3. VERIFY before spend — x402-paid, fail-closed.
  const verdict = await verifySellerTrust(payingFetch, card, minBand);
  steps.push({
    step: `3. UTA verify (policy: band >= ${minBand})`,
    ok: verdict.allow,
    detail: verdict.reason + (verdict.verdict_id ? ` [verdict ${verdict.verdict_id}]` : "")
  });
  if (!verdict.allow) {
    steps.push({ step: "4. spend decision", ok: false, detail: "ABORT — no payment built or sent (fail-closed)" });
    return { spent: false, verdict_id: verdict.verdict_id, band: verdict.band, steps };
  }

  // 4. Trust gate passed — let the x402 client settle the payment.
  steps.push({ step: "4. spend decision", ok: true, detail: "ALLOW — settling x402 payment" });
  const paid = await payingFetch(paidUrl, {});
  const body = (await paid.text()).slice(0, 300);
  steps.push({ step: "5. settled", ok: paid.ok, detail: `HTTP ${paid.status}: ${body}` });

  return { spent: paid.ok, verdict_id: verdict.verdict_id, band: verdict.band, steps };
}

export class TrustAgent extends Agent<Env> {
  fetchWithPay?: PayingFetch;

  onStart() {
    const pk = process.env.CLIENT_TEST_PK;
    if (!pk) {
      console.warn(
        "CLIENT_TEST_PK not set — copy .env.example to .env and add a test private key"
      );
      return;
    }

    const account = privateKeyToAccount(pk as `0x${string}`);
    console.log("Agent will verify-then-pay from:", account.address);

    const client = new x402Client();
    registerClientEvmScheme(client, { signer: toClientEvmSigner(account) });
    this.fetchWithPay = wrapFetchWithPayment(fetch, client);
  }

  private ready(): PayingFetch | null {
    return this.fetchWithPay ?? null;
  }

  @callable()
  async verifyAndPay(): Promise<TrustFlowResult> {
    const fetcher = this.ready();
    if (!fetcher) {
      return {
        spent: false,
        steps: [{ step: "0. agent setup", ok: false, detail: "CLIENT_TEST_PK not configured — copy .env.example to .env" }]
      };
    }
    return runTrustFlow(fetcher, "http://localhost:5173/protected-route");
  }
}

const app = new Hono<{ Bindings: Env }>();

const facilitatorClient = new HTTPFacilitatorClient({
  url: "https://x402.org/facilitator"
});
const resourceServer = new x402ResourceServer(facilitatorClient);
registerServerEvmScheme(resourceServer);

// The seller's card endpoint — where buyers resolve the ATC card before paying.
app.get("/agent-card.json", (c) => c.json(SAMPLE_CARD));

// The paid resource — the seller's route behind the x402 paywall.
app.use(
  paymentMiddleware(
    {
      "GET /protected-route": {
        accepts: [
          {
            scheme: "exact",
            price: "$0.01",
            network: "eip155:84532",
            payTo: process.env.SERVER_ADDRESS as `0x${string}`
          }
        ],
        description: "Access to premium content",
        mimeType: "application/json"
      }
    },
    resourceServer
  )
);

app.get("/protected-route", (c) => {
  return c.json({
    message: "This content is behind a paywall. Thanks for paying!"
  });
});

// Plain-HTTP trigger for the flow (no WebSocket client needed):
// curl http://localhost:5173/run-flow
app.get("/run-flow", async (c) => {
  const pk = process.env.CLIENT_TEST_PK;
  if (!pk) {
    return c.json({ error: "CLIENT_TEST_PK not configured — copy .env.example to .env" }, 500);
  }
  const account = privateKeyToAccount(pk as `0x${string}`);
  const client = new x402Client();
  registerClientEvmScheme(client, { signer: toClientEvmSigner(account) });
  const fetchWithPay = wrapFetchWithPayment(fetch, client);
  const result = await runTrustFlow(fetchWithPay, "http://localhost:5173/protected-route");
  return c.json(result);
});

app.all("/agents/*", async (c) => {
  const res = await routeAgentRequest(c.req.raw, c.env);
  return res || c.json({ error: "Not found" }, 404);
});

export default app;
