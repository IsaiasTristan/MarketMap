"use client";
/**
 * CorrelationMatrixTable — generic, label-driven Bloomberg-style correlation
 * heatmap. Extracted from the factor `CorrelationsView` table so the Sector /
 * Sub-Theme price-performance heatmaps share the same visual language:
 *   - Vertical column headers, sticky row labels in amber.
 *   - Diagonal: solid amber chip with black "1.00".
 *   - Off-diagonal: diverging red–gray–green ramp (`heatSignedBloomberg`),
 *     saturated at |0.7| so mid-range correlations still show variation.
 *   - Footer: ramp legend + caller-supplied meta line.
 */
import { heatSignedBloomberg } from "@/domain/calculations/heatmap";
import {
  BB_GRID_FONT_SIZE,
  BB_GRID_FONT_STACK,
  BB_GRID_HEADER_FONT_WEIGHT,
  pickTextColor,
} from "../shared/bloomberg-grid";

function cellBackground(v: number): string {
  const clamped = Math.max(-0.7, Math.min(0.7, v));
  return heatSignedBloomberg(clamped, 0.7);
}

const SIGN = (v: number): string => (v >= 0 ? "+" : "");

export interface CorrelationMatrixTableProps {
  labels: string[];
  matrix: number[][];
  /** Optional per-row accent spine colours (same order as `labels`). */
  rowAccents?: string[];
  /** Uppercase amber meta line shown at the right of the legend footer. */
  metaLine?: string;
  /** Width (px) of the sticky left label column. */
  labelColWidth?: number;
}

export function CorrelationMatrixTable({
  labels,
  matrix,
  rowAccents,
  metaLine,
  labelColWidth = 220,
}: CorrelationMatrixTableProps) {
  if (labels.length === 0) {
    return (
      <div
        style={{
          padding: 16,
          color: "var(--text-secondary)",
          fontSize: 12,
          fontFamily: "var(--font-mono, monospace)",
        }}
      >
        NOT ENOUGH DATA TO COMPUTE CORRELATIONS.
      </div>
    );
  }

  return (
    <>
      <div style={{ background: "var(--bg-base)", padding: 0, overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "separate",
            borderSpacing: 1,
            background: "#000",
            fontFamily: BB_GRID_FONT_STACK,
            fontVariantNumeric: "tabular-nums",
            fontSize: BB_GRID_FONT_SIZE,
            width: "100%",
            tableLayout: "fixed",
          }}
        >
          <colgroup>
            <col style={{ width: labelColWidth }} />
            {labels.map((l) => (
              <col key={l} />
            ))}
          </colgroup>

          <thead>
            <tr style={{ height: 160 }}>
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
              {labels.map((l) => (
                <th
                  key={l}
                  title={l}
                  style={{
                    background: "var(--bg-base)",
                    color: "var(--color-accent)",
                    fontSize: BB_GRID_FONT_SIZE,
                    fontWeight: BB_GRID_HEADER_FONT_WEIGHT,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                    whiteSpace: "nowrap",
                    writingMode: "vertical-rl",
                    transform: "rotate(180deg)",
                    borderBottom: "1px solid var(--bg-border)",
                    verticalAlign: "bottom",
                    padding: "6px 0",
                    height: 160,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {l}
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {labels.map((rowLabel, r) => (
              <tr key={rowLabel} style={{ height: 22 }}>
                <td
                  title={rowLabel}
                  style={{
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                    background: "var(--bg-base)",
                    color: "var(--color-accent)",
                    fontSize: BB_GRID_FONT_SIZE,
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
                    {rowAccents?.[r] && (
                      <span
                        aria-hidden
                        style={{
                          width: 3,
                          height: 14,
                          background: rowAccents[r],
                          flexShrink: 0,
                        }}
                      />
                    )}
                    <span
                      style={{
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {rowLabel}
                    </span>
                  </div>
                </td>

                {labels.map((colLabel, c) => {
                  const v = matrix[r]?.[c] ?? 0;
                  const isDiag = r === c;
                  const bg = isDiag ? "var(--bb-amber-bg)" : cellBackground(v);
                  const textColor = isDiag ? "#000" : pickTextColor(bg);
                  const fontWeight = isDiag ? 700 : Math.abs(v) >= 0.4 ? 600 : 500;
                  return (
                    <td
                      key={colLabel}
                      title={`${rowLabel} × ${colLabel} = ${v.toFixed(3)}`}
                      style={{
                        background: bg,
                        color: textColor,
                        fontWeight,
                        textAlign: "center",
                        padding: "0 4px",
                        fontSize: BB_GRID_FONT_SIZE,
                        fontVariantNumeric: "tabular-nums",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {isDiag ? "1.00" : `${SIGN(v)}${v.toFixed(2)}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
        {metaLine && <div style={{ color: "var(--color-accent)" }}>{metaLine}</div>}
      </div>
    </>
  );
}
