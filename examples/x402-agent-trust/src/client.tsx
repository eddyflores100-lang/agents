import { useCallback, useState } from "react";
import { createRoot } from "react-dom/client";
import { Button, Badge, Surface, Text, PoweredByCloudflare } from "@cloudflare/kumo";
import { ShieldCheckIcon, WarningCircleIcon, CheckCircleIcon } from "@phosphor-icons/react";
import { useAgent } from "agents/react";
import "./styles.css";

interface TrustStep {
  step: string;
  ok: boolean;
  detail: string;
}

interface TrustFlowResult {
  spent: boolean;
  verdict_id?: string;
  band?: string;
  steps: TrustStep[];
}

function StepRow({ step }: { step: TrustStep }) {
  return (
    <li className="flex items-start gap-3 py-2 border-b border-kumo-border last:border-0">
      {step.ok ? (
        <CheckCircleIcon weight="fill" className="w-5 h-5 shrink-0 text-kumo-success" />
      ) : (
        <WarningCircleIcon weight="fill" className="w-5 h-5 shrink-0 text-kumo-danger" />
      )}
      <div className="min-w-0">
        <div className="font-medium text-sm">{step.step}</div>
        <div className="text-sm text-kumo-subtle break-words">{step.detail}</div>
      </div>
    </li>
  );
}

function App() {
  const [status, setStatus] = useState<"connecting" | "connected" | "disconnected">("connecting");
  const [result, setResult] = useState<TrustFlowResult | null>(null);
  const [loading, setLoading] = useState(false);

  const agent = useAgent({ agent: "trust-agent", onOpen: () => setStatus("connected"), onClose: () => setStatus("disconnected") });

  const run = useCallback(async () => {
    setLoading(true);
    setResult(null);
    try {
      const res = (await agent.call("verifyAndPay", [])) as TrustFlowResult;
      setResult(res);
    } catch (e) {
      setResult({ spent: false, steps: [{ step: "error", ok: false, detail: String(e) }] });
    } finally {
      setLoading(false);
    }
  }, [agent]);

  return (
    <main className="max-w-2xl mx-auto p-6 space-y-4">
      <header className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldCheckIcon weight="fill" className="w-6 h-6 text-kumo-success" />
          <Text variant="title">x402 Agent Trust — verify before you pay</Text>
        </div>
        <Badge>{status}</Badge>
      </header>

      <Surface className="p-4 space-y-3">
        <Text>
          The agent wants a paid resource. On <code>402</code> it resolves the seller's ATC
          card, verifies it against a UTA verifier (itself x402-paid, fail-closed), and only
          settles the payment if the seller's trust band meets policy. Any verification
          failure aborts before money moves.
        </Text>
        <Button onClick={run} disabled={loading || status !== "connected"}>
          {loading ? "Verifying…" : "Verify & Pay"}
        </Button>
      </Surface>

      {result && (
        <Surface className="p-4">
          <div className="flex items-center gap-2 mb-2">
            <Badge variant={result.spent ? "success" : "danger"}>
              {result.spent ? "paid after verified trust" : "aborted — no spend (fail-closed)"}
            </Badge>
            {result.band && <Badge>band {result.band}</Badge>}
          </div>
          <ul>
            {result.steps.map((s) => (
              <StepRow key={s.step} step={s} />
            ))}
          </ul>
        </Surface>
      )}

      <footer className="flex justify-center pt-2">
        <PoweredByCloudflare />
      </footer>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
