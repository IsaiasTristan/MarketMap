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
    fontSize: 11,
    fontWeight: 700,
    color: "var(--text-primary)",
    background: "var(--bg-surface)",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    padding: "8px 12px",
    borderBottom: "1px solid var(--bg-border)",
    whiteSpace: "nowrap",
  };

  const cellStyle: React.CSSProperties = {
    padding: "8px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.03)",
    verticalAlign: "middle",
  };

  if (loading) {
    return (
      <ChartCard title="Portfolio Factor Summary" subtitle="MACRO14 · 1D return attribution">
        <div
          style={{
            padding: 32,
            textAlign: "center",
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
      <ChartCard title="Portfolio Factor Summary" subtitle="MACRO14 · 1D return attribution">
        <div
          style={{
            padding: 24,
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          Factor data unavailable — insufficient portfolio history.
        </div>
      </ChartCard>
    );
  }

  return (
    <ChartCard
      title="Portfolio Factor Summary"
      subtitle={`MACRO14 · ${exposure.window}D window · 1D return`}
    >
      {headlines && (
        <div
          style={{
            display: "flex",
            gap: 12,
            marginBottom: 12,
            flexWrap: "wrap",
          }}
        >
          {[
            { label: "Net market β", value: headlines.netMarketBeta.toFixed(2) },
            { label: "Largest factor bet", value: headlines.largestFactor },
            {
              label: "Factor risk share",
              value: `${(headlines.factorRiskShare * 100).toFixed(0)}%`,
            },
          ].map((chip) => (
            <div
              key={chip.label}
              style={{
                padding: "6px 12px",
                background: "var(--bg-elevated)",
                border: "1px solid var(--bg-border)",
                borderRadius: 0,
                minWidth: 120,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {chip.label}
              </div>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 700,
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--text-primary)",
                }}
              >
                {chip.value}
              </div>
            </div>
          ))}
        </div>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              <th style={colStyle}>Factor</th>
              <th style={{ ...colStyle, textAlign: "left" }}>Exposure (β)</th>
              <th style={{ ...colStyle, textAlign: "left" }}>Risk %</th>
              <th style={{ ...colStyle, textAlign: "left" }}>Return (1D)</th>
            </tr>
          </thead>
          <tbody>
            {MACRO14_DISPLAY_ORDER.map((code) => {
              const f = exposure.factors.find((x) => x.code === code);
              if (!f) return null;
              const def = getFactorDef(code as FactorCode);
              const retPct = returnByCode.get(code) ?? 0;
              return (
                <tr key={code}>
                  <td style={cellStyle}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div
                        style={{
                          width: 3,
                          height: 16,
                          background: def.color,
                          flexShrink: 0,
                        }}
                      />
                      <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>
                        {def.label}
                      </span>
                    </div>
                  </td>
                  <td style={cellStyle}>
                    <MicroBar value={f.beta} maxAbs={maxBeta} />
                  </td>
                  <td style={cellStyle}>
                    <MicroBar value={f.pctRiskContrib} maxAbs={1} asPct />
                  </td>
                  <td style={cellStyle}>
                    <MicroBar value={retPct} maxAbs={1} asPct />
                  </td>
                </tr>
              );
            })}
            <tr style={{ borderTop: "1px solid var(--bg-border)" }}>
              <td style={{ ...cellStyle, fontStyle: "italic", color: "var(--text-secondary)" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div
                    style={{
                      width: 3,
                      height: 16,
                      background: "var(--text-muted)",
                      flexShrink: 0,
                    }}
                  />
                  Idiosyncratic (Stock-specific)
                </div>
              </td>
              <td style={cellStyle}>
                <span style={{ color: "var(--text-muted)", fontSize: 11 }}>—</span>
              </td>
              <td style={cellStyle}>
                <MicroBar value={idioRisk} maxAbs={1} asPct />
              </td>
              <td style={cellStyle}>
                <MicroBar value={idioReturnPct} maxAbs={1} asPct />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </ChartCard>
  );
}
