"use client";
/**
 * Waterfall — generic Bloomberg-style decomposition strip used to spell out
 * a Total value and how it is built up from N components plus an optional
 * residual (alpha for return decomposition, idiosyncratic for risk).
 *
 * The bars share a single span (max |component|) so visual lengths are
 * comparable. Negative components shoot left of a centred zero line; positive
 * components shoot right. The Total row is rendered above the components in
 * a high-contrast band with a sign-coloured number.
 */
import type { ReactNode } from "react";

export interface WaterfallSegment {
  /** Stable key. */
  key: string;
  /** Human-readable label (full academic factor name). */
  label: string;
  /** Component value in the same units as `total` (decimal, e.g. 0.04 = 4%). */
  value: number;
  /** Coloured spine on the left of the row. */
  color?: string;
  /** Optional secondary line (e.g. "β = +0.42 · t = 3.1"). */
  sub?: string;
}

interface WaterfallProps {
  /** Section title (e.g. "Total Return Decomposition"). */
  title: string;
  /** Optional subtitle line (e.g. window/methodology note). */
  subtitle?: string;
  /** Headline total value, in the same decimal units as segment values. */
  total: number;
  /**
   * The "totalLabel" shown next to the headline number — typically
   * "Total Return" or "Total Variance".
   */
  totalLabel: string;
  /**
   * Segments contributing to the total, in display order. Leave the residual
   * out of this list and pass it as `residual` so it is rendered visually
   * differently (dashed border, muted color).
   */
  segments: WaterfallSegment[];
  /**
   * Residual segment (Alpha for return, Idiosyncratic for risk). Optional.
   */
  residual?: WaterfallSegment;
  /**
   * Number formatter for displayed values. Defaults to a percentage with
   * one decimal place.
   */
  formatValue?: (v: number) => string;
  /** Optional right-aligned annotation rendered next to the headline total. */
  totalAnnotation?: ReactNode;
}

const fmtPct = (v: number): string =>
  `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

export function Waterfall({
  title,
  subtitle,
  total,
  totalLabel,
  segments,
  residual,
  formatValue = fmtPct,
  totalAnnotation,
}: WaterfallProps) {
  const all = residual ? [...segments, residual] : segments;
  // Symmetric span for bar widths — uses max(|component|, |total|) so a tiny
  // residual segment isn't overpowered by a giant total bar that clips.
  const span = Math.max(
    1e-9,
    ...all.map((s) => Math.abs(s.value)),
    Math.abs(total),
  );

  const totalPositive = total >= 0;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
      }}
    >
      {/* Headline total row */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 14,
          padding: "10px 14px",
          borderBottom: "1px solid var(--bg-border)",
          background: "rgba(255,255,255,0.015)",
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              fontWeight: 600,
            }}
          >
            {title}
          </div>
          {subtitle && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
              {subtitle}
            </div>
          )}
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end" }}>
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            {totalLabel}
          </div>
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              fontFamily: "var(--font-mono, monospace)",
              color: totalPositive ? "var(--color-positive)" : "var(--color-negative)",
              lineHeight: 1.1,
            }}
          >
            {formatValue(total)}
          </div>
          {totalAnnotation && (
            <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
              {totalAnnotation}
            </div>
          )}
        </div>
      </div>

      {/* Component bars */}
      <div style={{ padding: "6px 14px 10px" }}>
        {all.map((s) => {
          const isResidual = residual && s.key === residual.key;
          const ratio = Math.min(1, Math.abs(s.value) / span);
          const positive = s.value >= 0;
          return (
            <div
              key={s.key}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1.4fr) 110px minmax(180px, 2fr)",
                alignItems: "center",
                columnGap: 10,
                padding: "5px 0",
                borderBottom: "1px solid rgba(255,255,255,0.025)",
              }}
            >
              {/* Label */}
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <div
                  style={{
                    width: 3,
                    height: 16,
                    background: s.color ?? "var(--text-muted)",
                    borderRadius: 2,
                    flexShrink: 0,
                    opacity: isResidual ? 0.5 : 1,
                  }}
                />
                <div style={{ minWidth: 0, overflow: "hidden" }}>
                  <div
                    style={{
                      fontSize: 11,
                      color: isResidual ? "var(--text-secondary)" : "var(--text-primary)",
                      fontWeight: isResidual ? 500 : 500,
                      fontStyle: isResidual ? "italic" : "normal",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={s.label}
                  >
                    {s.label}
                  </div>
                  {s.sub && (
                    <div
                      style={{
                        fontSize: 9,
                        color: "var(--text-muted)",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {s.sub}
                    </div>
                  )}
                </div>
              </div>

              {/* Numeric value */}
              <div
                style={{
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: 11,
                  fontWeight: 600,
                  color: positive ? "var(--color-positive)" : "var(--color-negative)",
                  textAlign: "right",
                }}
              >
                {formatValue(s.value)}
              </div>

              {/* Bar */}
              <div
                style={{
                  position: "relative",
                  height: 9,
                  background: "var(--bg-elevated)",
                  borderRadius: 2,
                  overflow: "hidden",
                  border: isResidual ? "1px dashed rgba(255,255,255,0.18)" : "none",
                }}
              >
                <div
                  style={{
                    position: "absolute",
                    left: positive ? "50%" : `${50 - ratio * 50}%`,
                    top: 0,
                    height: "100%",
                    width: `${ratio * 50}%`,
                    background: positive ? "var(--color-positive)" : "var(--color-negative)",
                    opacity: isResidual ? 0.55 : 0.95,
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    left: "50%",
                    top: 0,
                    width: 1,
                    height: "100%",
                    background: "rgba(255,255,255,0.2)",
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
