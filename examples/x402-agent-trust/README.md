# x402 Agent Trust — verify before you pay

An agent wants a paid resource. It receives a `402`, resolves the seller's
**Agent Trust Card (ATC/1.0)**, verifies the card against a **UTA** verifier —
itself paid with x402, fail-closed — and only then settles the payment. If
verification fails for any reason, no payment is ever built or sent.

## What it demonstrates

- **Trust gate inside a payment flow** — `runTrustFlow()` probes the paid
  resource, fetches the seller's card, and inserts a verification step between
  `402` and settlement
- **x402-paid verification** — the verify call pays the verifier 0.01 USDC via
  the same `x402Client` that pays the resource (`wrapFetchWithPayment`)
- **Fail-closed policy** — verifier unreachable, HTTP error, non-JSON, missing
  band, or band below `MIN_TRUST_BAND` all abort the flow with the reason
  recorded; no spend is ever honored because verification was unavailable
- **Band policy** — verdicts carry a trust band (`B0`–`B3`, `A1`, ordered);
  the buyer enforces `band >= MIN_TRUST_BAND`
- **`@callable`** — the `TrustAgent` agent exposes `verifyAndPay` over the
  Agents SDK; a plain `GET /run-flow` trigger is included for testing without
  a WebSocket client

## Running

Copy the environment file and fill in your keys:

```sh
cp .env.example .env
```

You need:

- `SERVER_ADDRESS` — an Ethereum address to receive payments (Base Sepolia testnet)
- `CLIENT_TEST_PK` — a private key for signing payments (test key only, get test USDC from https://faucet.circle.com/)

Then:

```sh
npm install
npm start
```

Press **Verify & Pay** to run the full flow, or trigger it without the UI:

```sh
curl http://localhost:5173/run-flow
```

## How it works

```
Agent (buyer)                          Seller                      UTA verifier
     │ 1. GET /protected-route ──────────►│
     │◄──────────────────────── 402 + accepts
     │ 2. GET /agent-card.json ──────────►│
     │◄──────────────────────── ATC card
     │ 3. POST /v1/trust/verify ─────────────────────────────────────►│
     │◄─ verdict { verified, band, verdict_id } (x402-paid) ──────────│
     │ 4. band >= MIN_TRUST_BAND ?                                    │
     │      no  → ABORT (fail-closed, no payment built)               │
     │      yes → 5. settle x402 payment ─►│
     │◄──────────────────────── 200 + receipt
```

### The trust gate (buyer side)

```typescript
const verdict = await verifySellerTrust(fetchWithPay, card, minBand);
if (!verdict.allow) {
  return { spent: false, steps }; // fail-closed: abort before payment
}
const paid = await fetchWithPay(paidUrl, {}); // only now settle
```

### The sample card

`src/sample-card.json` is a published conformance vector card (issued by the
MarketNow Sentinel CA, `did:marketnow:ca`). Whether the live verifier allows
or denies it depends on its pinned trust anchors and the card's status at
verification time — **both outcomes demonstrate the boundary working**: an
allow settles the payment; a deny aborts it with the recorded reason. To see
the allow path with production semantics, point `UTA_VERIFY_URL` at your own
verifier instance or replace the card with one issued to your agent.

## Protocol references

- ATC/1.0 spec: https://github.com/alicelabs-llc/MARKETNOW/blob/master/docs/atc-spec/SPEC.md
- UTA Trust API (live, x402-native): https://github.com/alicelabs-llc/universal-trust-adapter
- ERC-8004 ↔ ATC/1.0 crosswalk (identity + verification composition): https://github.com/alicelabs-llc/universal-trust-adapter/blob/main/docs/crosswalks/erc-8004-atc-v1.md
- x402 protocol: https://x402.org
