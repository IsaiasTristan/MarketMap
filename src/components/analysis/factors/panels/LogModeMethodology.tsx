"use client";
/**
 * LogModeMethodology — small inline info badge that lives next to the
 * "Total Excess Return" headline on per-stock and portfolio attribution
 * panels. Hover for a full methodology breakdown (log identity, geometric
 * conversion, what happened to the legacy arithmetic Σ y_simple sum, and
 * the residual gap).
 *
 * Why this exists:
 *   The per-stock detail panel and the portfolio AttributionClient default
 *   to log-return attribution (Path B). The headline displays
 *   `exp(Σ y_log) − 1` so it ties to compounded realised excess for the
 *   visible window. Quants will still want to see the original arithmetic
 *   Σ y_simple value to verify nothing is hidden — this badge surfaces it
 *   on hover without adding visual noise to the primary view.
 *
 * Inputs are all optional / nullable; the badge degrades gracefully when
 * a series is missing (e.g. strict-drop log fallback).
 */
import type React from "react";

interface LogModeMethodologyProps {
  /** Σ y_log over the post-burn-in / visible window. */
  sumLog: number;
  /** exp(sumLog) − 1 — the geometric headline value. */
  geometric: number;
  /**
   * Σ y_simple over the same window (arithmetic sum of daily simple
   * excess). Optional: absent if the simple series isn't in scope.
   */
  arithmeticSimple?: number | null;
  /**
   * Identity residual gap from the daily decomposition, e.g.
   *   Σy − [Σ(β·x) + Σα + Σε]
   * Used to flag numerical noise vs. genuine bugs. Optional.
   */
  identityGap?: number | null;
  /** Number of post-burn-in observations summed. Optional. */
  obsCount?: number | null;
}

const badgeStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 14,
  height: 14,
  marginLeft: 6,
  borderRadius: "50%",
  border: "1px solid rgba(255,255,255,0.30)",
  background: "rgba(255,255,255,0.04)",
  color: "var(--text-secondary)",
  fontSize: 9,
  fontWeight: 700,
  fontFamily: "var(--font-mono, monospace)",
  cursor: "help",
  userSelect: "none",
  verticalAlign: "middle",
};

function fmtPct(value: number | null | undefined, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return "n/a";
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(digits)}%`;
}

export function LogModeMethodology({
  sumLog,
  geometric,
  arithmeticSimple = null,
  identityGap = null,
  obsCount = null,
}: LogModeMethodologyProps) {
  const obsLine = obsCount != null ? `Window: ${obsCount} obs (post burn-in).\n` : "";
  const identityLine =
    identityGap != null && Number.isFinite(identityGap)
      ? `Daily identity residual: Σy − [Σ(β·x) + Σα + Σε] = ${(identityGap * 100).toFixed(4)}% (numerical noise; should be ≤ 1e-6).\n\n`
      : "";
  const arithLine =
    arithmeticSimple != null && Number.isFinite(arithmeticSimple)
      ? `Legacy arithmetic Σ y_simple over the same window = ${fmtPct(arithmeticSimple)}.\n` +
        `This is the unweighted sum of daily simple excess returns. It is NOT a compounded total return — ` +
        `the daily identity holds, but multi-period sums do not reconcile to realised compounded performance. ` +
        `That is why the headline is now driven by exp(Σ y_log) − 1 instead.\n\n`
      : "";

  const tip =
    `Attribution methodology — log returns (Path B).\n\n` +
    obsLine +
    `Per-stock excess in log space:\n` +
    `  y_log_t = ln(1 + r_stock_t) − ln(1 + r_f_t)\n\n` +
    `Daily identity:\n` +
    `  y_log_t = Σ_i β_t,i · ln(1 + f_i,t) + α_t + ε_t\n\n` +
    `Cumulative identity (post burn-in):\n` +
    `  Σ y_log = Σ(β·x_log) + Σα + Σε = ${fmtPct(sumLog)}\n\n` +
    `Geometric reconciliation (headline):\n` +
    `  exp(Σ y_log) − 1 = ${fmtPct(geometric)}  ← compounded realised excess for the visible window\n\n` +
    identityLine +
    arithLine +
    `Note: per-factor bars are additive in LOG space only. exp(component) − 1 for an individual factor ` +
    `does NOT sum to the geometric total; only the inner Σ exponentiates cleanly.`;

  return (
    <span title={tip} aria-label="Log attribution methodology" style={badgeStyle}>
      i
    </span>
  );
}
