"use client";
import { useQuery } from "@tanstack/react-query";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorMarketContext, FactorCode } from "@/types/factors";
import { divergingHeatColor, heatSignedBloomberg } from "@/domain/calculations/heatmap";

const HORIZONS = ["return1D", "return5D", "return1M", "return3M", "return6M", "return1Y"] as const;
const HORIZON_LABELS: Record<string, string> = {
  return1D: "1D",
  return5D: "5D",
  return1M: "1M",
  return3M: "3M",
  return6M: "6M",
  return1Y: "1Y",
};

const RETURN_HEAT_SPAN = 0.15;

function returnCellBackground(v: number | null): string {
  if (v === null) return "var(--bg-elevated)";
  const clamped = Math.max(-RETURN_HEAT_SPAN, Math.min(RETURN_HEAT_SPAN, v));
  return heatSignedBloomberg(clamped, RETURN_HEAT_SPAN);
}

function correlationCellBackground(v: number): string {
  if (v >= 0.999) return "var(--bb-amber-bg)";
  return divergingHeatColor(v, -1, 1);
}

export function MarketContextPanel() {
  const { data: context, isLoading } = useQuery<FactorMarketContext>({
    queryKey: ["factor-market-context"],
    queryFn: () => fetch("/api/analysis/factors/market").then((r) => r.json()),
    staleTime: 5 * 60_000,
  });

  if (isLoading) {
    return (
      <div
        style={{
          height: 200,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--text-muted)",
          fontSize: 13,
        }}
      >
        Loading factor market data…
      </div>
    );
  }

  if (!context) return null;

  const codes = context.stats.map((s) => s.code);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ChartCard
        title="Factor Returns Heatmap"
        subtitle={`Factor performance across horizons · as of ${context.asOfDate}`}
      >
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th
                  style={{
                    padding: "6px 12px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textAlign: "left",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    borderBottom: "1px solid var(--bg-border)",
                  }}
                >
                  Factor
                </th>
                {HORIZONS.map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "6px 10px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      textAlign: "center",
                      textTransform: "uppercase",
                      letterSpacing: "0.07em",
                      borderBottom: "1px solid var(--bg-border)",
                    }}
                  >
                    {HORIZON_LABELS[h]}
                  </th>
                ))}
                <th
                  style={{
                    padding: "6px 10px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textAlign: "right",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    borderBottom: "1px solid var(--bg-border)",
                  }}
                >
                  Ann. Vol
                </th>
                <th
                  style={{
                    padding: "6px 10px",
                    fontSize: 10,
                    fontWeight: 600,
                    color: "var(--text-muted)",
                    textAlign: "right",
                    textTransform: "uppercase",
                    letterSpacing: "0.07em",
                    borderBottom: "1px solid var(--bg-border)",
                  }}
                >
                  Sharpe
                </th>
              </tr>
            </thead>
            <tbody>
              {context.stats.map((stat) => {
                const def = getFactorDef(stat.code as FactorCode);
                return (
                  <tr key={stat.code}>
                    <td style={{ padding: "8px 12px", borderBottom: "1px solid rgba(255,255,255,0.03)" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <div style={{ width: 3, height: 14, background: def.color, borderRadius: 2 }} />
                        <span style={{ color: "var(--text-primary)", fontWeight: 500 }}>{def.label}</span>
                      </div>
                    </td>
                    {HORIZONS.map((h) => {
                      const v = stat[h as keyof typeof stat] as number | null;
                      const bg = returnCellBackground(v);
                      const strong = v !== null && Math.abs(v) >= RETURN_HEAT_SPAN * 0.35;
                      return (
                        <td
                          key={h}
                          style={{
                            padding: "6px 10px",
                            textAlign: "center",
                            borderBottom: "1px solid rgba(255,255,255,0.03)",
                            background: bg,
                            fontFamily: "var(--font-mono, monospace)",
                            fontSize: 11,
                            color:
                              v === null
                                ? "var(--text-muted)"
                                : strong
                                  ? "#fff"
                                  : "var(--text-secondary)",
                          }}
                        >
                          {v === null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`}
                        </td>
                      );
                    })}
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 11,
                        color: "var(--text-secondary)",
                        borderBottom: "1px solid rgba(255,255,255,0.03)",
                      }}
                    >
                      {stat.annualizedVol !== null ? `${(stat.annualizedVol * 100).toFixed(1)}%` : "—"}
                    </td>
                    <td
                      style={{
                        padding: "8px 10px",
                        textAlign: "right",
                        fontFamily: "var(--font-mono, monospace)",
                        fontSize: 11,
                        borderBottom: "1px solid rgba(255,255,255,0.03)",
                        color:
                          stat.sharpeRatio !== null && stat.sharpeRatio > 0
                            ? "var(--color-positive)"
                            : "var(--color-negative)",
                      }}
                    >
                      {stat.sharpeRatio !== null ? stat.sharpeRatio.toFixed(2) : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </ChartCard>

      <ChartCard
        title="Factor Correlation Matrix"
        subtitle={`${context.correlationWindow}D rolling Pearson correlations`}
      >
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
            <thead>
              <tr>
                <th style={{ padding: "5px 8px", color: "transparent" }}>—</th>
                {codes.map((code) => (
                  <th
                    key={code}
                    style={{
                      padding: "5px 8px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      textAlign: "center",
                    }}
                  >
                    {getFactorDef(code as FactorCode).shortLabel}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {codes.map((rowCode, r) => (
                <tr key={rowCode}>
                  <td
                    style={{
                      padding: "5px 8px",
                      fontSize: 10,
                      fontWeight: 600,
                      color: "var(--text-muted)",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {getFactorDef(rowCode as FactorCode).shortLabel}
                  </td>
                  {codes.map((_, c) => {
                    const v = context.correlationMatrix[r]?.[c] ?? 0;
                    const isDiag = v >= 0.999;
                    const bg = correlationCellBackground(v);
                    return (
                      <td
                        key={c}
                        style={{
                          padding: "5px 10px",
                          textAlign: "center",
                          background: bg,
                          fontFamily: "var(--font-mono, monospace)",
                          color: isDiag ? "#000" : Math.abs(v) > 0.45 ? "#fff" : "var(--text-secondary)",
                          fontWeight: isDiag ? 700 : 400,
                        }}
                        title={`${getFactorDef(rowCode as FactorCode).shortLabel} × ${getFactorDef(codes[c]! as FactorCode).shortLabel} = ${v.toFixed(3)}`}
                      >
                        {isDiag ? "1.00" : v.toFixed(2)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  );
}
