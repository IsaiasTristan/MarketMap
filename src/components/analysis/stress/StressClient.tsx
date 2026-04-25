"use client";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { Card, CardLabel } from "@/components/analysis/ui/Card";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import type { ScenarioResult } from "@/server/services/stress.service";

function fmt$(n: number) {
  const abs = Math.abs(n);
  const sign = n >= 0 ? "+" : "-";
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function ScenarioCard({ scenario }: { scenario: ScenarioResult }) {
  const isNeg = scenario.estimatedPnlDollar < 0;
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: `1px solid ${isNeg ? "rgba(239,68,68,0.3)" : "var(--bg-border)"}`,
        borderRadius: 2,
        padding: 16,
      }}
    >
      <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)", marginBottom: 4 }}>
        {scenario.name}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 12 }}>
        {scenario.start} — {scenario.end}
      </div>
      <div style={{ display: "flex", gap: 20 }}>
        <div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>Est. P&L</div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "var(--font-mono, monospace)",
              color: isNeg ? "var(--color-negative)" : "var(--color-positive)",
            }}
          >
            {fmt$(scenario.estimatedPnlDollar)}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase" }}>Est. %</div>
          <div
            style={{
              fontSize: 20,
              fontWeight: 700,
              fontFamily: "var(--font-mono, monospace)",
              color: isNeg ? "var(--color-negative)" : "var(--color-positive)",
            }}
          >
            {scenario.estimatedPnlPct >= 0 ? "+" : ""}
            {(scenario.estimatedPnlPct * 100).toFixed(1)}%
          </div>
        </div>
      </div>
      <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
        Top hit: {scenario.worstPositions[0]?.ticker ?? "—"} ({fmt$(scenario.worstPositions[0]?.estimatedPnl ?? 0)})
      </div>
    </div>
  );
}

export function StressClient() {
  const { activePortfolioId } = useAnalysisStore();
  const [spxChange, setSpxChange] = useState("-20");
  const [rateBps, setRateBps] = useState("100");
  const [shockResult, setShockResult] = useState<{ estimatedPnlDollar: number; estimatedPnlPct: number } | null>(null);

  const { data: historical, isLoading } = useQuery<ScenarioResult[]>({
    queryKey: ["stress-historical", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/stress/historical?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  const { data: corrStress } = useQuery<{
    normalVar95: number;
    stressedVar95: number;
    diversificationBenefit: number;
    totalValue: number;
  }>({
    queryKey: ["stress-correlation", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/stress/correlation?portfolioId=${activePortfolioId}`).then(
        (r) => r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  const customMut = useMutation({
    mutationFn: (body: Record<string, number>) =>
      fetch(`/api/analysis/stress/custom?portfolioId=${activePortfolioId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => r.json()),
    onSuccess: (d) => setShockResult(d),
  });

  const runCustom = () => {
    customMut.mutate({
      spxChange: parseFloat(spxChange) / 100,
      rateChangeBps: parseFloat(rateBps),
    });
  };

  if (!activePortfolioId) {
    return (
      <div style={{ textAlign: "center", paddingTop: 80 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)" }}>
          Select a portfolio to run stress tests.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Stress Testing
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          How would I survive a market crisis?
        </p>
      </div>

      {/* Historical scenarios */}
      <ChartCard title="Historical Scenario Library" subtitle="Estimated P&L using beta-scaled market returns">
        {isLoading ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
            {[0, 1, 2, 3, 4].map((i) => <SkeletonCard key={i} height={120} />)}
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
            {(historical ?? []).map((s) => <ScenarioCard key={s.key} scenario={s} />)}
          </div>
        )}
      </ChartCard>

      {/* Custom shock builder */}
      <ChartCard title="Custom Scenario Builder">
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
          <div>
            <CardLabel>S&P 500 Change (%)</CardLabel>
            <input
              type="number"
              value={spxChange}
              onChange={(e) => setSpxChange(e.target.value)}
              placeholder="-20"
              style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--bg-border)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 }}
            />
          </div>
          <div>
            <CardLabel>Interest Rate Change (bps)</CardLabel>
            <input
              type="number"
              value={rateBps}
              onChange={(e) => setRateBps(e.target.value)}
              placeholder="100"
              style={{ width: "100%", padding: "6px 10px", borderRadius: 6, border: "1px solid var(--bg-border)", background: "var(--bg-elevated)", color: "var(--text-primary)", fontSize: 13 }}
            />
          </div>
          <div>
            <CardLabel>Result</CardLabel>
            {shockResult ? (
              <div style={{ fontSize: 20, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", color: shockResult.estimatedPnlDollar < 0 ? "var(--color-negative)" : "var(--color-positive)" }}>
                {fmt$(shockResult.estimatedPnlDollar)}
              </div>
            ) : (
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Run scenario to see result</div>
            )}
          </div>
          <button
            onClick={runCustom}
            disabled={customMut.isPending}
            style={{ padding: "8px 20px", borderRadius: 6, border: "none", background: "var(--color-accent)", color: "#fff", cursor: "pointer", fontSize: 13, fontWeight: 600 }}
          >
            {customMut.isPending ? "Running…" : "Run Scenario"}
          </button>
        </div>
      </ChartCard>

      {/* Correlation stress */}
      {corrStress && (
        <ChartCard title="Correlation Stress Test" subtitle="What if all pairwise correlations = 1 (worst-case crisis)?">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {[
              { label: "Normal VaR 95%", value: fmt$(corrStress.normalVar95), color: "var(--color-warning)" },
              { label: "Stressed VaR 95% (ρ=1)", value: fmt$(corrStress.stressedVar95), color: "var(--color-negative)" },
              { label: "Diversification Benefit", value: fmt$(corrStress.diversificationBenefit), color: "var(--color-info)" },
            ].map((m) => (
              <div key={m.label} style={{ background: "var(--bg-elevated)", borderRadius: 2, padding: 16 }}>
                <CardLabel>{m.label}</CardLabel>
                <div style={{ fontSize: 22, fontWeight: 700, fontFamily: "var(--font-mono, monospace)", color: m.color }}>
                  {m.value}
                </div>
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: "var(--text-muted)" }}>
            The diversification benefit ({fmt$(corrStress.diversificationBenefit)}) represents the VaR reduction your portfolio gains from assets not moving in lockstep. In a crisis, this benefit often disappears.
          </div>
        </ChartCard>
      )}
    </div>
  );
}
