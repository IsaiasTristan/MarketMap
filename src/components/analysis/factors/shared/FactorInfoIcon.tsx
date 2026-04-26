"use client";
/**
 * FactorInfoIcon — small round "i" badge that surfaces a long methodology
 * tooltip on hover via the native `title` attribute. Matches the badge
 * styling used by `LogModeMethodology` so info affordances on the per-stock
 * detail panel stay visually consistent.
 *
 * Use when the on-screen label has been intentionally shortened (e.g. a
 * Bloomberg-style section title) and supporting detail belongs in a hover.
 */
import type React from "react";

interface FactorInfoIconProps {
  /** Tooltip text. Multi-line allowed. */
  tip: string;
  /** Accessibility label for screen readers. Defaults to "More information". */
  ariaLabel?: string;
  /** Optional inline-style override for one-off positioning tweaks. */
  style?: React.CSSProperties;
}

const baseStyle: React.CSSProperties = {
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

export function FactorInfoIcon({
  tip,
  ariaLabel = "More information",
  style,
}: FactorInfoIconProps) {
  return (
    <span
      title={tip}
      aria-label={ariaLabel}
      role="img"
      style={style ? { ...baseStyle, ...style } : baseStyle}
    >
      i
    </span>
  );
}
