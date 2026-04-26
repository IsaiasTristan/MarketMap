"use client";
/**
 * CorrelationsView — Bloomberg Terminal-style factor × factor correlation
 * matrix for the factor set in the currently selected model. Sits behind the
 * third pill in the top-level Portfolio | Per-stock | Correlations toggle.
 *
 * UI conventions (matched to the rest of the analysis shell — see
 * `src/app/(analysis)/analysis.css`):
 *   - Pure black canvas (`--bg-base`), flat panels, no border-radius.
 *   - Column / row labels: amber (`--color-accent`), uppercase, monospace.
 *   - Diagonal: solid amber chip (`--bb-amber-bg`) with black "1.00".
 *   - Off-diagonal: diverging red–gray–green ramp (`heatSignedBloomberg`) so
 *     correlation cells share their visual language with the market-map
 *     heatmap and per-stock factor grid.
 *   - Compact 22 px row height, single-pixel black gridlines bleeding through
 *     `border-spacing` to keep the dense terminal feel.
 *   - Footer: amber meta-line ({N} factors · symmetric · window · as-of).
 */
import { useQuery } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { MODEL_PRESETS } from "@/lib/factors/definitions/model-presets";
import { SkeletonCard } from "@/components/analysis/ui/Skeleton";
import { heatSignedBloomberg } from "@/domain/calculations/heatmap";
import type { FactorMarketContext, FactorCode } from "@/types/factors";

/**
 * Background colour for an off-diagonal correlation cell. Uses the
 * project-wide diverging ramp (gray at ρ≈0). We saturate at |0.7|
 * (a visually meaningful regime correlation) so the lower magnitudes still
 * show variation instead of all collapsing to near-black.
 */
function cellBackground(v: number): string {
  const clamped = Math.max(-0.7, Math.min(0.7, v));
  return heatSignedBloomberg(clamped, 0.7);
}

const SIGN = (v: number): string => (v >= 0 ? "+" : "");

export function CorrelationsView() {
  const { factorModel, factorWindow } = useAnalysisStore();
  const corrWindow = Math.max(60, Math.min(504, factorWindow));

  const { data, isLoading } = useQuery<FactorMarketContext>({
    queryKey: ["factor-correlations", factorModel, corrWindow],
    queryFn: () =>
      fetch(`/api/analysis/factors/market?model=${factorModel}&corrWindow=${corrWindow}`).then(
        (r) => r.json(),
      ),
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <SkeletonCard height={460} />;

  if (!data || !data.stats || data.stats.length === 0) {
    return (
      <div
        style={{
          padding: 24,
          background: "var(--bg-surface)",
          border: "1px solid var(--bg-border)",
          color: "var(--text-secondary)",
          fontSize: 12,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        NO FACTOR RETURN DATA AVAILABLE — RUN THE FACTOR INGEST PIPELINE FIRST.
      </div>
    );
  }

  const codes = data.stats.map((s) => s.code) as FactorCode[];
  const preset = MODEL_PRESETS[factorModel];

  return (
    <ChartCard
      title="Factor Correlation Matrix"
      subtitle={
        `${preset?.label ?? factorModel} · Pearson correlations · last ${data.correlationWindow} trading days ` +
        `(matches regression window used for risk decomposition Σ) · as of ${data.asOfDate}`
      }
    >
      <div
        style={{
          background: "var(--bg-base)",
          padding: 0,
          overflowX: "auto",
        }}
      >
        <table
          style={{
            borderCollapse: "separate",
            borderSpacing: 1,
            background: "#000",
            fontFamily: "var(--font-mono, monospace)",
            fontVariantNumeric: "tabular-nums",
            fontSize: 11,
            width: "100%",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: 180 }} />
            {codes.map((code) => (
              <col key={code} />
            ))}
          </colgroup>

          <thead>
            <tr style={{ height: 120 }}>
              {/* Top-left empty corner */}
              <th
                style={{
                  background: "var(--bg-base)",
                  borderBottom: "1px solid var(--bg-border)",
                  borderRight: "1px solid var(--bg-border)",
                  position: "sticky",
                  left: 0,
                  zIndex: 3,
                }}
              />
              {codes.map((code) => {
                const def = getFactorDef(code);
                return (
                  <th
                    key={code}
                    title={def.label}
                    style={{
                      background: "var(--bg-base)",
                      color: "var(--color-accent)",
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                      writingMode: "vertical-rl",
                      transform: "rotate(180deg)",
                      borderBottom: "1px solid var(--bg-border)",
                      verticalAlign: "bottom",
                      padding: "6px 0",
                      height: 120,
                    }}
                  >
                    {def.label}
                  </th>
                );
              })}
            </tr>
          </thead>

          <tbody>
            {codes.map((rowCode, r) => {
              const rowDef = getFactorDef(rowCode);
              return (
                <tr key={rowCode} style={{ height: 22 }}>
                  {/* Row label — amber, with the factor's accent spine */}
                  <td
                    title={rowDef.label}
                    style={{
                      position: "sticky",
                      left: 0,
                      zIndex: 1,
                      background: "var(--bg-base)",
                      color: "var(--color-accent)",
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: "0.04em",
                      textTransform: "uppercase",
                      borderRight: "1px solid var(--bg-border)",
                      padding: "0 8px 0 6px",
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <span
                        aria-hidden
                        style={{
                          width: 3,
                          height: 14,
                          background: rowDef.color,
                          flexShrink: 0,
                        }}
                      />
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {rowDef.label}
                      </span>
                    </div>
                  </td>

                  {codes.map((colCode, c) => {
                    const v = data.correlationMatrix[r]?.[c] ?? 0;
                    const colDef = getFactorDef(colCode);
                    const isDiag = r === c;
                    // White text once the heat has saturated enough, dim gray
                    // before that so weak correlations don't shout.
                    const textColor = isDiag
                      ? "#000"
                      : Math.abs(v) >= 0.4
                        ? "#ffffff"
                        : "#9aa0a6";
                    const fontWeight = isDiag ? 700 : Math.abs(v) >= 0.4 ? 600 : 400;
                    return (
                      <td
                        key={colCode}
                        title={`${rowDef.label} × ${colDef.label} = ${v.toFixed(3)}`}
                        style={{
                          background: isDiag ? "var(--bb-amber-bg)" : cellBackground(v),
                          color: textColor,
                          fontWeight,
                          textAlign: "center",
                          padding: "0 4px",
                          fontSize: 11,
                          fontVariantNumeric: "tabular-nums",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {isDiag ? "1.00" : `${SIGN(v)}${v.toFixed(2)}`}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Bloomberg-style meta footer: ramp legend on the left, factor count
          and as-of stamp on the right, all uppercase amber/monospace. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 14,
          padding: "8px 4px 2px",
          fontSize: 10,
          fontFamily: "var(--font-mono, monospace)",
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 80,
              height: 10,
              background: `linear-gradient(to right, ${cellBackground(-0.7)}, ${cellBackground(0)}, ${cellBackground(0.7)})`,
            }}
          />
          <span style={{ color: "#ff3232" }}>−1.00</span>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span style={{ color: "#8a8a8a" }}>0.00</span>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span style={{ color: "#00c800" }}>+1.00</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span
            aria-hidden
            style={{
              display: "inline-block",
              width: 12,
              height: 10,
              background: "var(--bb-amber-bg)",
            }}
          />
          <span>Diagonal</span>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ color: "var(--color-accent)" }}>
          {codes.length} FACTORS · SYMMETRIC · {data.correlationWindow}D WINDOW · AS OF {data.asOfDate}
        </div>
      </div>

      <MulticollinearityFooter
        codes={codes}
        data={data}
      />
    </ChartCard>
  );
}

function vifColor(vif: number): string {
  if (!Number.isFinite(vif)) return "#ef4444";
  if (vif >= 10) return "#ef4444";
  if (vif >= 5) return "#f59e0b";
  return "var(--text-secondary)";
}

function conditionColor(kappa: number): string {
  if (!Number.isFinite(kappa)) return "#ef4444";
  if (kappa >= 100) return "#ef4444";
  if (kappa >= 30) return "#f59e0b";
  return "var(--color-accent)";
}

function MulticollinearityFooter({
  codes,
  data,
}: {
  codes: FactorCode[];
  data: FactorMarketContext;
}) {
  const mc = data.multicollinearity;
  if (!mc) return null;

  const monoSmall: React.CSSProperties = {
    fontSize: 10,
    fontFamily: "var(--font-mono, monospace)",
    fontVariantNumeric: "tabular-nums",
  };

  return (
    <div
      style={{
        marginTop: 10,
        padding: "8px 10px",
        background: "var(--bg-base)",
        border: "1px solid var(--bg-border)",
        ...monoSmall,
        color: "var(--text-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            color: "var(--color-accent)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
          title="Multicollinearity diagnostics on the same window as the correlations above. VIF_j = (R⁻¹)_jj. κ = √(λmax/λmin) of the correlation matrix. Red = severe (VIF≥10 or κ≥100), amber = moderate (VIF≥5 or κ≥30)."
        >
          Multicollinearity
        </div>
        <div>
          κ ={" "}
          <span style={{ color: conditionColor(mc.conditionNumber) }}>
            {Number.isFinite(mc.conditionNumber)
              ? mc.conditionNumber.toFixed(1)
              : "∞"}
          </span>
          <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>
            (flag ≥ 30)
          </span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(codes.length, 7)}, 1fr)`,
          gap: 4,
          marginBottom: 8,
        }}
      >
        {codes.map((c, i) => {
          const vif = mc.vif[i] ?? 0;
          const def = getFactorDef(c);
          return (
            <div
              key={c}
              title={`${def.label} · VIF = ${
                Number.isFinite(vif) ? vif.toFixed(2) : "∞"
              } · 1 = uncorrelated, 5 = moderate, 10 = severe`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 6,
                padding: "2px 6px",
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text-muted)",
                }}
              >
                {def.shortLabel}
              </span>
              <span style={{ color: vifColor(vif), fontWeight: 600 }}>
                {Number.isFinite(vif) ? vif.toFixed(1) : "∞"}
              </span>
            </div>
          );
        })}
      </div>

      <div
        style={{
          color: "var(--text-muted)",
          textTransform: "uppercase",
          letterSpacing: "0.06em",
        }}
      >
        Pairs |ρ| ≥ {mc.flagThreshold.toFixed(2)} —{" "}
        {mc.highPairs.length === 0 ? (
          <span style={{ color: "var(--color-accent)" }}>none</span>
        ) : (
          mc.highPairs.slice(0, 5).map((p, idx) => {
            const a = getFactorDef(codes[p.i]!).shortLabel;
            const b = getFactorDef(codes[p.j]!).shortLabel;
            return (
              <span key={`${p.i}-${p.j}`} style={{ color: "var(--text-secondary)" }}>
                {idx > 0 ? " · " : " "}
                {a}↔{b} ({p.rho >= 0 ? "+" : ""}
                {p.rho.toFixed(2)})
              </span>
            );
          })
        )}
        {mc.highPairs.length > 5 && (
          <span style={{ color: "var(--text-muted)" }}>
            {" "}
            · +{mc.highPairs.length - 5} more
          </span>
        )}
      </div>
    </div>
  );
}
