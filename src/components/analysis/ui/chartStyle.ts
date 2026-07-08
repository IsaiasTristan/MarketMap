import type { CSSProperties } from "react";

/** Recharts default tooltip — Bloomberg flat panel */
export const bbTooltipStyle: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--chrome-border)",
  borderRadius: 0,
  fontSize: 11,
  color: "#fff",
};

// ── Shared axis theme — Bloomberg amber ──────────────────────────────────────
// House style: axis tick labels, axis titles, axis lines and chart titles all
// render in the accent amber (#fa8000). Import these instead of hardcoding
// per-chart tick fills so the terminal look stays consistent everywhere.

/** `tick={bbAxisTick}` — amber tick labels. */
export const bbAxisTick = { fontSize: 10, fill: "var(--color-accent)" } as const;

/** For recharts `<XAxis label={{ ...bbAxisLabel, value }}>` — amber axis title. */
export const bbAxisLabel = { fill: "var(--color-accent)", fontSize: 11 } as const;

/** `axisLine={bbAxisLine}` / `tickLine={bbAxisLine}` — amber axis line. */
export const bbAxisLine = { stroke: "var(--color-accent)" } as const;

/** Style object for a centered amber chart title (`<div style={bbChartTitle}>`). */
export const bbChartTitle: CSSProperties = {
  color: "var(--color-accent)",
  textAlign: "center",
  fontSize: 11,
  fontWeight: 600,
  letterSpacing: "0.04em",
};

/** Plain `<text>` style for hand-rolled SVG axis labels. */
export const bbSvgAxisText = { fill: "var(--color-accent)", fontSize: 10 } as const;
