"use client";

import { useMemo } from "react";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { MicroBar } from "@/components/analysis/ui/MicroBar";
import { MACRO14_DISPLAY_ORDER, getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorExposureSnapshot, AttributionResult, FactorCode } from "@/types/factors";

interface PortfolioFactorSummaryProps {
  exposure: FactorExposureSnapshot | null | undefined;
  attribution: AttributionResult | null | undefined;
  loading?: boolean;
}

export function PortfolioFactorSummary({
  exposure,
  attribution,
  loading,
}: PortfolioFactorSummaryProps) {
  const period1D = attribution?.periods?.find((p) => p.label === "1D");

  const returnByCode = useMemo(() => {
    const map = new Map<string, number>();
    if (period1D) {
      for (const f of period1D.byFactor) {
        map.set(f.code, f.pct);
      }
    }
    return map;
  }, [period1D]);

  const maxBeta = useMemo(() => {
    if (!exposure) return 1;
    return Math.max(
      0.01,
      ...exposure.factors.map((f) => Math.abs(f.beta)),
    );
  }, [exposure]);

  // Factor rows ordered by largest absolute beta first (the biggest exposures
  // sit at the top), restricted to the MACRO14 set the table renders.
  const sortedFactors = useMemo(() => {
    if (!exposure) return [];
    const macro14 = new Set<string>(MACRO14_DISPLAY_ORDER);
    return exposure.factors
      .filter((f) => macro14.has(f.code))
      .slice()
      .sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta));
  }, [exposure]);

  const headlines = useMemo(() => {
    if (!exposure) return null;
    const eq = exposure.factors.find((f) => f.code === "EQ");
    const largest = [...exposure.factors].sort(
      (a, b) => Math.abs(b.beta) - Math.abs(a.beta),
    )[0];
    return {
      netMarketBeta: eq?.beta ?? 0,
      largestFactor: largest?.label ?? "—",
      factorRiskShare: exposure.systematicShare,
    };
  }, [exposure]);

  const idioRisk = exposure?.idiosyncraticShare ?? 0;
  const idioReturn = period1D
    ? period1D.totalReturn - period1D.factorReturn - period1D.alpha
    : 0;
  const idioReturnPct =
    period1D && Math.abs(period1D.totalReturn) > 1e-9
      ? idioReturn / Math.abs(period1D.totalReturn)
      : 0;

  const colStyle: React.CSSProperties = {
    fontSize: 9,
    fontWeight: 700,
    color: "var(--text-muted)",
    background: "var(--bg-surface)",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
    padding: "4px 8px",
    borderBottom: "1px solid var(--bg-border)",
    whiteSpace: "nowrap",
  };

  const cellStyle: React.CSSProperties = {
    padding: "2px 8px",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    verticalAlign: "middle",
  };

  const metaLine = exposure
    ? `MACRO14 · ${exposure.window}D window · 1D return`
    : "MACRO14 · 1D return attribution";

  const metaStyle: React.CSSProperties = {
    padding: "5px 10px",
    fontSize: 10,
    color: "var(--text-muted)",
    borderBottom: "1px solid var(--bg-border)",
    background: "var(--bg-base)",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  };

  if (loading) {
    return (
      <ChartCard title="Portfolio Factor Summary" compact fillHeight>
        <div style={metaStyle}>{metaLine}</div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            color: "var(--text-secondary)",
            fontSize: 12,
          }}
        >
          Loading factor summary…
        </div>
      </ChartCard>
    );
  }

  if (!exposure) {
    return (
      <ChartCard title="Portfolio Factor Summary" compact fillHeight>
        <div style={metaStyle}>{metaLine}</div>
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            color: "var(--text-muted)",
            fontSize: 12,
            textAlign: "center",
          }}
        >
          Factor data unavailable — insufficient portfolio history.
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard title="Portfolio Factor Summary" compact fillHeight>
      <div style={metaStyle}>{metaLine}</div>

      {headlines && (
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            borderBottom: "1px solid var(--bg-border)",
          }}
        >
          {[
            { label: "Net market β", value: headlines.netMarketBeta.toFixed(2) },
            { label: "Largest bet", value: headlines.largestFactor },
            {
              label: "Factor risk",
              value: `${(headlines.factorRiskShare * 100).toFixed(0)}%`,
            },
          ].map((chip, i) => (
            <div
              key={chip.label}
              style={{
                flex: 1,
                padding: "4px 8px",
                borderLeft: i > 0 ? "1px solid var(--bg-border)" : "none",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  fontSize: 9,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  whiteSpace: "nowrap",
                }}
              >
                {chip.label}
              </div>
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--text-primary)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={chip.value}
              >
                {chip.value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...colStyle, textAlign: "left" }}>Factor</th>
              <th style={{ ...colStyle, textAlign: "left" }}>Beta</th>
              <th style={{ ...colStyle, textAlign: "left" }}>% of Variance</th>
              <th style={{ ...colStyle, textAlign: "left" }}>1-D Return</th>
            </tr>
          </thead>
          <tbody>
            {sortedFactors.map((f) => {
              const def = getFactorDef(f.code as FactorCode);
              const retPct = returnByCode.get(f.code) ?? 0;
              return (
                <tr key={f.code}>
                  <td style={cellStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <div
                        style={{
                          width: 3,
                          height: 12,
                          background: def.color,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          color: "var(--text-primary)",
                          fontWeight: 500,
                          whiteSpace: "nowrap",
                        }}
                        title={def.label}
                      >
                        {def.shortLabel}
                      </span>
                    </div>
                  </td>
                  <td style={cellStyle}>
                    <MicroBar value={f.beta} maxAbs={maxBeta} compact />
                  </td>
                  <td style={cellStyle}>
                    <MicroBar value={f.pctRiskContrib} maxAbs={1} asPct compact />
                  </td>
                  <td style={cellStyle}>
                    <MicroBar value={retPct} maxAbs={1} asPct compact />
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: "1px solid var(--bg-border)" }}>
              <td style={{ ...cellStyle, fontStyle: "italic", color: "var(--text-secondary)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div
                    style={{
                      width: 3,
                      height: 12,
                      background: "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  />
                  <span title="Idiosyncratic (Stock-specific)">Idiosyncratic</span>
                </div>
              </td>
              <td style={cellStyle}>
                <span style={{ color: "var(--text-muted)", fontSize: 10 }}>—</span>
              </td>
              <td style={cellStyle}>
                <MicroBar value={idioRisk} maxAbs={1} asPct compact />
              </td>
              <td style={cellStyle}>
                <MicroBar value={idioReturnPct} maxAbs={1} asPct compact />
              </td>
            </tr>
            <tr style={{ borderTop: "1px solid var(--bg-border)" }}>
              <td
                style={{
                  ...cellStyle,
                  fontWeight: 700,
                  color: "var(--text-primary)",
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                }}
              >
                Portfolio Average
              </td>
              <td style={cellStyle}>
                <span style={{ color: "var(--text-muted)", fontSize: 10 }}>—</span>
              </td>
              <td style={cellStyle}>
                <span
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    fontFamily: "var(--font-mono, monospace)",
                    color: "var(--text-primary)",
                  }}
                >
                  100.0%
                </span>
              </td>
              <td style={cellStyle}>
                {period1D ? (
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      fontFamily: "var(--font-mono, monospace)",
                      color:
                        period1D.totalReturn >= 0
                          ? "var(--color-positive)"
                          : "var(--color-negative)",
                    }}
                  >
                    {`${period1D.totalReturn >= 0 ? "+" : ""}${(
                      period1D.totalReturn * 100
                    ).toFixed(2)}%`}
                  </span>
                ) : (
                  <span style={{ color: "var(--text-muted)", fontSize: 10 }}>—</span>
                )}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
