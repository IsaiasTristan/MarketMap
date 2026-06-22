"use client";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { MethodologyTooltip } from "../shared/MethodologyTooltip";
import { Segmented } from "../shared/Segmented";
import { CoverageWarning } from "./CoverageWarning";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { RISK_WINDOW_PRESETS } from "@/lib/factors/definitions/risk-window-presets";
import { useAnalysisStore, type FactorRiskWindow } from "@/store/analysis";
import type { RiskDecomposition, FactorCode } from "@/types/factors";
import { PieChart, Pie, Cell, Tooltip, Legend, ResponsiveContainer } from "recharts";

interface RiskPanelProps {
  risk: RiskDecomposition | null | undefined;
}

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: 10,
  fontWeight: 600,
};

export function RiskPanel({ risk }: RiskPanelProps) {
  const { factorRiskWindow, setFactorRiskWindow } = useAnalysisStore();

  // Header row — Risk Window segmented control + coverage chip. Rendered
  // even when the regression failed for the selected window so the user can
  // pivot back to a shorter window without leaving the tab.
  const header = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        flexWrap: "wrap",
      }}
    >
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={labelStyle}>Risk Window</span>
        <Segmented<string>
          value={String(factorRiskWindow)}
          onChange={(v) => setFactorRiskWindow(Number(v) as FactorRiskWindow)}
          options={RISK_WINDOW_PRESETS.map((p) => ({
            value: String(p.value),
            label: p.label,
            title: `${p.sub} trailing window (${p.value} trading days)`,
          }))}
        />
      </div>
      <CoverageWarning coverage={risk?.windowCoverage} failed={!risk} />
    </div>
  );

  if (!risk) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {header}
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--bg-border)",
            padding: "16px 18px",
            fontSize: 12,
            color: "var(--text-secondary)",
            lineHeight: 1.5,
          }}
        >
          Not enough aligned data to estimate factor risk over the selected window.
          Try a shorter Risk Window above, or refresh the factor pipeline.
        </div>
      </div>
    );
  }

  const pieData = [
    { name: "Systematic", value: risk.systematicShare * 100 },
    { name: "Idiosyncratic", value: risk.idiosyncraticShare * 100 },
  ];
  const PIE_COLORS = ["var(--chart-1)", "var(--chart-4)"];

  const factorRows = risk.factors.filter((f) => Math.abs(f.pctVarianceContrib) > 0.001);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {header}

      {/* Summary cards row */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          {
            label: "Total Vol (ann.)",
            value: `${(risk.totalVolatility * 100).toFixed(1)}%`,
            tooltip: "Annual portfolio volatility: σ_p = √(β'Σβ + σ²_idio).",
          },
          {
            label: "Systematic Vol",
            value: `${(risk.systematicVolatility * 100).toFixed(1)}%`,
            tooltip: "√(β'Σβ) — the part driven by factor tilts.",
          },
          {
            label: "Idiosyncratic Vol",
            value: `${(risk.idiosyncraticVolatility * 100).toFixed(1)}%`,
            tooltip: "√(σ²_idio) — stock-specific risk not captured by factors.",
          },
        ].map(({ label, value, tooltip }) => (
          <div
            key={label}
            style={{
              background: "var(--bg-surface)",
              border: "1px solid var(--bg-border)",
              borderRadius: 0,
              padding: "14px 16px",
            }}
          >
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 6 }}>
              {label}
            </div>
            <div
              style={{
                fontSize: 26,
                fontWeight: 700,
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--text-primary)",
              }}
            >
              {value}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 3 }}>{tooltip}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", gap: 16 }}>
        {/* Pie chart */}
        <ChartCard title="Risk Split">
          <ResponsiveContainer width="100%" height={160}>
            <PieChart>
              <Pie data={pieData} cx="50%" cy="50%" innerRadius={40} outerRadius={70} dataKey="value">
                {pieData.map((_, i) => (
                  <Cell key={i} fill={PIE_COLORS[i]!} />
                ))}
              </Pie>
              <Tooltip
                contentStyle={bbTooltipStyle}
                formatter={(v) => [`${Number(v ?? 0).toFixed(1)}%`]}
              />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* Factor risk table */}
        <ChartCard title="Factor Risk Contributions" subtitle="Euler decomposition of portfolio variance by factor">
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr>
                  {["Factor", "Beta", "Marg. CR", "Risk Contrib", "% Variance"].map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: "6px 10px",
                        fontSize: 12,
                        fontWeight: 700,
                        color: "var(--text-primary)",
                        background: "var(--bg-surface)",
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                        borderBottom: "1px solid var(--bg-border)",
                        textAlign: "right",
                      }}
                    >
                      {h}
                      {h === "Marg. CR" && <MethodologyTooltip metricKey="marginal_cr" />}
                      {h === "% Variance" && <MethodologyTooltip metricKey="pct_risk_contrib" />}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {factorRows.map((f) => {
                  const def = getFactorDef(f.code as FactorCode);
                  return (
                    <tr key={f.code}>
                      <td style={{ padding: "7px 10px", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <div style={{ width: 3, height: 14, background: def.color, borderRadius: 2, flexShrink: 0 }} />
                          <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{f.label}</span>
                        </div>
                      </td>
                      {[f.beta, f.marginalCR, f.riskContrib, f.pctVarianceContrib].map((v, i) => (
                        <td
                          key={i}
                          style={{
                            padding: "7px 10px",
                            textAlign: "right",
                            fontFamily: "var(--font-mono, monospace)",
                            borderBottom: "1px solid rgba(255,255,255,0.03)",
                            fontSize: 12,
                            color:
                              i >= 2
                                ? v > 0
                                  ? "var(--color-positive)"
                                  : v < 0
                                    ? "var(--color-negative)"
                                    : "var(--text-muted)"
                                : "var(--text-secondary)",
                          }}
                        >
                          {i === 3 ? `${(v * 100).toFixed(1)}%` : v.toFixed(4)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </ChartCard>
      </div>
    </div>
  );
}
