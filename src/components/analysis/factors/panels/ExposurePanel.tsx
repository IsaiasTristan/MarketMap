"use client";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { MethodologyTooltip } from "../shared/MethodologyTooltip";
import { FactorBadge } from "../shared/FactorBadge";
import type { FactorExposureSnapshot, FactorCode } from "@/types/factors";
import type { AttributionResult } from "@/types/factors";
import type { FactorPeriod } from "@/store/analysis";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";

interface ExposurePanelProps {
  exposure: FactorExposureSnapshot | null | undefined;
  attribution: AttributionResult | null | undefined;
  selectedPeriod: FactorPeriod;
}

function SignedVal({ v, digits = 3 }: { v: number; digits?: number }) {
  const pos = v >= 0;
  return (
    <span
      style={{
        fontFamily: "var(--font-mono, monospace)",
        color: pos ? "var(--color-positive)" : "var(--color-negative)",
        fontWeight: 600,
        fontSize: 12,
      }}
    >
      {pos ? "+" : ""}
      {v.toFixed(digits)}
    </span>
  );
}

function TStatBadge({ t }: { t: number }) {
  const significant = Math.abs(t) >= 2;
  return (
    <span
      style={{
        fontSize: 11,
        fontFamily: "var(--font-mono, monospace)",
        color: significant ? "var(--color-positive)" : "var(--text-muted)",
        background: significant ? "rgba(34,197,94,0.08)" : "transparent",
        padding: "1px 6px",
        borderRadius: 3,
      }}
    >
      {t >= 0 ? "+" : ""}
      {t.toFixed(1)}
    </span>
  );
}

function MicroBar({ pct }: { pct: number }) {
  const abs = Math.min(1, Math.abs(pct));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <div
        style={{
          position: "relative",
          width: 80,
          height: 6,
          background: "var(--bg-elevated)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            height: "100%",
            width: `${abs * 100}%`,
            background: pct > 0 ? "var(--chart-1)" : "#ef4444",
            borderRadius: 3,
          }}
        />
      </div>
      <span style={{ fontSize: 10, fontFamily: "var(--font-mono, monospace)", color: "var(--text-muted)", minWidth: 36 }}>
        {(pct * 100).toFixed(1)}%
      </span>
    </div>
  );
}

export function ExposurePanel({ exposure, attribution, selectedPeriod }: ExposurePanelProps) {
  if (!exposure) return null;

  const periodData = attribution?.periods?.find((p) => p.label === selectedPeriod);

  const colStyle: React.CSSProperties = {
    fontSize: 11,
    fontWeight: 600,
    color: "var(--text-muted)",
    textTransform: "uppercase",
    letterSpacing: "0.07em",
    padding: "8px 12px",
    borderBottom: "1px solid var(--bg-border)",
    whiteSpace: "nowrap",
  };

  const cellStyle: React.CSSProperties = {
    padding: "10px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    verticalAlign: "middle",
  };

  return (
    <ChartCard
      title="Factor Exposure"
      subtitle={`${exposure.model} · ${exposure.window}D window · R² = ${(exposure.rSquared * 100).toFixed(0)}%${exposure.regularized ? " · ⚠ ridge-regularized" : ""}`}
    >
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              <th style={colStyle}>Factor</th>
              <th style={{ ...colStyle, textAlign: "right" }}>
                Beta
                <MethodologyTooltip metricKey="factor_beta" />
              </th>
              <th style={{ ...colStyle, textAlign: "right" }}>
                t-Stat
                <MethodologyTooltip metricKey="t_stat" />
              </th>
              <th style={{ ...colStyle, textAlign: "right" }}>
                Holdings-Implied
                <MethodologyTooltip metricKey="holdings_implied" />
              </th>
              <th style={{ ...colStyle, textAlign: "left" }}>
                % Risk Contrib
                <MethodologyTooltip metricKey="pct_risk_contrib" />
              </th>
              <th style={{ ...colStyle, textAlign: "left" }}>
                % Return ({selectedPeriod})
                <MethodologyTooltip metricKey="pct_return_contrib" />
              </th>
            </tr>
          </thead>
          <tbody>
            {exposure.factors.map((f) => {
              const periodEntry = periodData?.byFactor.find((b) => b.code === f.code);
              const def = getFactorDef(f.code as FactorCode);
              return (
                <tr key={f.code} style={{ transition: "background 0.1s" }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "rgba(255,255,255,0.02)"; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = "transparent"; }}
                >
                  <td style={cellStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ width: 3, height: 18, background: def.color, borderRadius: 2, flexShrink: 0 }} />
                      <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{f.label}</span>
                    </div>
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <SignedVal v={f.beta} />
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <TStatBadge t={f.tStat} />
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    {f.holdingsImplied !== null ? (
                      <span style={{ fontSize: 11, color: "var(--text-secondary)", fontFamily: "var(--font-mono, monospace)" }}>
                        {f.holdingsImplied >= 0 ? "+" : ""}
                        {f.holdingsImplied.toFixed(2)}
                      </span>
                    ) : (
                      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>
                    )}
                  </td>
                  <td style={cellStyle}>
                    <MicroBar pct={f.pctRiskContrib} />
                  </td>
                  <td style={cellStyle}>
                    <MicroBar pct={periodEntry?.pct ?? f.pctReturnContrib} />
                  </td>
                </tr>
              );
            })}
            {/* Alpha row */}
            <tr style={{ borderTop: "1px solid var(--bg-border)" }}>
              <td style={{ ...cellStyle, color: "var(--text-secondary)", fontWeight: 600, fontSize: 12 }}>
                Alpha (Residual)
              </td>
              <td style={{ ...cellStyle, textAlign: "right" }}>
                <SignedVal v={exposure.alphaAnnualized} />
                <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 4 }}>ann.</span>
              </td>
              <td style={{ ...cellStyle, textAlign: "right" }}>
                <TStatBadge t={exposure.alphaTStat} />
              </td>
              <td colSpan={3} style={{ ...cellStyle, fontSize: 11, color: "var(--text-muted)" }}>
                n = {exposure.n} obs · Adj. R² = {(exposure.adjRSquared * 100).toFixed(0)}%
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
