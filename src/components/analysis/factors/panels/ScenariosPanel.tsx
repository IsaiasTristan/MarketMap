"use client";
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { useAnalysisStore } from "@/store/analysis";
import type { ScenarioDefinition, ScenarioResult, SensitivityEntry } from "@/types/factors";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ReferenceLine, ResponsiveContainer, Cell } from "recharts";

interface ScenarioRunResponse {
  result: ScenarioResult;
  sensitivity: SensitivityEntry[];
}

export function ScenariosPanel() {
  const { activePortfolioId, factorModel, factorWindow } = useAnalysisStore();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const { data: scenarios } = useQuery<ScenarioDefinition[]>({
    queryKey: ["factor-scenarios"],
    queryFn: () => fetch("/api/analysis/factors/scenarios").then((r) => r.json()),
  });

  const runMutation = useMutation<ScenarioRunResponse, Error, string>({
    mutationFn: async (key: string) => {
      const res = await fetch("/api/analysis/factors/scenarios/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          portfolioId: activePortfolioId,
          model: factorModel,
          window: factorWindow,
          scenarioKey: key,
        }),
      });
      if (!res.ok) throw new Error("Failed to run scenario");
      return res.json();
    },
  });

  function handleRun(key: string) {
    setSelectedKey(key);
    runMutation.mutate(key);
  }

  const pnl = runMutation.data?.result?.estimatedPortPnl ?? 0;
  const factorImpacts =
    runMutation.data?.result?.byFactor.map((f) => ({
      label: f.label,
      impact: f.contribution * 100,
    })) ?? [];

  const sensitivity = runMutation.data?.sensitivity ?? [];

  const synthetic = scenarios?.filter((s) => !s.isHistorical) ?? [];
  const historical = scenarios?.filter((s) => s.isHistorical) ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ChartCard
        title="Factor Stress Scenarios"
        subtitle="Select a scenario to estimate portfolio P&L impact from factor shocks."
      >
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          {/* Scenario list */}
          <div style={{ minWidth: 220, flex: "0 0 220px" }}>
            {synthetic.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>
                  Synthetic
                </div>
                {synthetic.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => handleRun(s.key)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "7px 10px",
                      marginBottom: 3,
                      borderRadius: 6,
                      border: `1px solid ${selectedKey === s.key ? "var(--color-accent)" : "var(--bg-border)"}`,
                      background: selectedKey === s.key ? "rgba(99,102,241,0.08)" : "transparent",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {s.label}
                  </button>
                ))}
              </>
            )}
            {historical.length > 0 && (
              <>
                <div style={{ fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6, marginTop: 12 }}>
                  Historical
                </div>
                {historical.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => handleRun(s.key)}
                    style={{
                      display: "block",
                      width: "100%",
                      textAlign: "left",
                      padding: "7px 10px",
                      marginBottom: 3,
                      borderRadius: 6,
                      border: `1px solid ${selectedKey === s.key ? "var(--color-accent)" : "var(--bg-border)"}`,
                      background: selectedKey === s.key ? "rgba(99,102,241,0.08)" : "transparent",
                      color: "var(--text-secondary)",
                      fontSize: 12,
                      cursor: "pointer",
                    }}
                  >
                    {s.label}
                    {s.historicalWindow && (
                      <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>
                        {s.historicalWindow.start.slice(0, 7)} → {s.historicalWindow.end.slice(0, 7)}
                      </div>
                    )}
                  </button>
                ))}
              </>
            )}
          </div>

          {/* Results */}
          <div style={{ flex: 1, minWidth: 280 }}>
            {runMutation.isPending && (
              <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 24 }}>Running scenario…</div>
            )}
            {runMutation.data && !runMutation.isPending && (
              <>
                <div style={{ marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 4 }}>
                    Estimated Portfolio P&amp;L
                  </div>
                  <div
                    style={{
                      fontSize: 32,
                      fontWeight: 700,
                      fontFamily: "var(--font-jetbrains-mono, monospace)",
                      color: pnl >= 0 ? "var(--color-positive)" : "var(--color-negative)",
                    }}
                  >
                    {pnl >= 0 ? "+" : ""}
                    {(pnl * 100).toFixed(2)}%
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    Linear approximation: ΔP ≈ Σ β_f × Δf
                  </div>
                </div>

                {factorImpacts.length > 0 && (
                  <div style={{ height: 180 }}>
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={factorImpacts} layout="vertical" margin={{ left: 60, right: 20 }}>
                        <XAxis
                          type="number"
                          tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                          tickFormatter={(v) => `${v.toFixed(1)}%`}
                          axisLine={false}
                          tickLine={false}
                        />
                        <YAxis
                          type="category"
                          dataKey="label"
                          tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                          axisLine={false}
                          tickLine={false}
                          width={56}
                        />
                        <ReferenceLine x={0} stroke="var(--bg-border)" />
                        <Tooltip
                          contentStyle={{ background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", borderRadius: 8, fontSize: 11 }}
                          formatter={(v: number) => [`${v.toFixed(3)}%`, "Impact"]}
                        />
                        <Bar dataKey="impact" radius={[0, 3, 3, 0]}>
                          {factorImpacts.map((entry, i) => (
                            <Cell key={i} fill={entry.impact >= 0 ? "#22c55e" : "#ef4444"} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </>
            )}
            {!runMutation.data && !runMutation.isPending && (
              <div style={{ color: "var(--text-muted)", fontSize: 13, padding: 24 }}>
                Select a scenario to see estimated impact.
              </div>
            )}
          </div>
        </div>
      </ChartCard>

      {/* Sensitivity table */}
      {sensitivity.length > 0 && (
        <ChartCard title="Factor Sensitivity Table" subtitle="Estimated P&L impact of ±1σ and ±2σ factor shocks (annualized σ)">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Factor", "Beta", "1σ Shock", "−1σ Impact", "+1σ Impact", "−2σ Impact", "+2σ Impact"].map((h) => (
                    <th key={h} style={{ padding: "6px 10px", fontSize: 10, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: "1px solid var(--bg-border)", textAlign: "right" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sensitivity.map((s) => (
                  <tr key={s.code}>
                    <td style={{ padding: "7px 10px", color: "var(--text-primary)", fontWeight: 500, borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      {s.label}
                    </td>
                    {[s.beta, s.shock1Sig, s.impactNeg1Sig, s.impact1Sig, s.impactNeg2Sig, s.impact2Sig].map((v, i) => (
                      <td key={i} style={{ padding: "7px 10px", textAlign: "right", fontFamily: "var(--font-jetbrains-mono, monospace)", borderBottom: "1px solid rgba(255,255,255,0.03)", color: i >= 2 ? (v >= 0 ? "var(--color-positive)" : "var(--color-negative)") : "var(--text-secondary)" }}>
                        {i === 1 ? `${(v * 100).toFixed(1)}%` : i >= 2 ? `${(v * 100).toFixed(2)}%` : v.toFixed(3)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </ChartCard>
      )}
    </div>
  );
}
