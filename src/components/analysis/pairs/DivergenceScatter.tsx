"use client";
/**
 * Divergence 2x2 (brief §8.3) — x = 4-week change in the signal gap (pp,
 * genuinely two-sided), y = long-leg minus short-leg return over 1 month (%).
 * The shaded bottom-right is the research zone: the signal has WIDENED but the
 * price ratio has NOT moved yet. Colour encodes the calibrated unpriced-gap
 * sign; a ring marks pairs new to the top decile this week. Renders inside the
 * shared ChartFrame so it carries real axes, titles, quadrant labels, labelled
 * points and non-clipped hover popovers with each pair's own arithmetic.
 */
import type { PairRowPayload } from "@/server/services/pairs/pairs-read.service";
import { ChartFrame, type ChartPoint } from "@/components/analysis/ui/ChartFrame";
import { pairCode } from "@/lib/pairs/labels";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";

/** Dot colour by flag state (not x-position, which the axis already conveys):
 *  priced red · factor bet amber · unpriced green · thin/none neutral grey. */
function flagFill(flags: string[], thinGap: boolean): string {
  if (flags.includes("PRICED")) return "var(--color-negative)";
  if (flags.includes("FACTOR_BET")) return "var(--color-accent)";
  if (flags.includes("UNPRICED")) return "var(--color-positive)";
  if (thinGap || flags.includes("THIN_GAP")) return "var(--text-muted)";
  return "var(--text-secondary)";
}

/**
 * Two-sided robust bound: max(|3rd pct|, |97th pct|). Symmetric so 0 stays
 * centred, and a lone fat-tail outlier (a -509% pair) cannot blow up the axis.
 */
function robustBound(vals: number[], floor: number): number {
  if (vals.length === 0) return floor;
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  return Math.max(floor, Math.abs(q(0.03)), Math.abs(q(0.97)));
}

const pp = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}pp`);
const pct = (v: number | null) => (v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);

export function DivergenceScatter({
  pairs,
  onSelect,
  height = 240,
  hideThinGaps = false,
}: {
  pairs: PairRowPayload[];
  onSelect?: (r: PairRowPayload) => void;
  height?: number;
  /** When true, drop thin-gap pairs so this scatter honors the same control as
   *  the rank table (one filter governs both surfaces). */
  hideThinGaps?: boolean;
}) {
  const pts = pairs.filter(
    (p) => p.e1Gap4wChange !== null && p.relReturn1m !== null && (!hideThinGaps || !p.thinGap),
  );
  if (pts.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12 }}>No pairs to plot.</div>;
  }
  const xMax = robustBound(pts.map((p) => p.e1Gap4wChange ?? 0), 8);
  const yMax = robustBound(pts.map((p) => p.relReturn1m ?? 0), 0.05);
  const clipped = pts.filter((p) => Math.abs(p.e1Gap4wChange ?? 0) > xMax || Math.abs(p.relReturn1m ?? 0) > yMax).length;

  // Label the most extreme unpriced setups; placeLabels drops any without room.
  const ranked = [...pts].sort((a, b) => Math.abs(b.unpricedGap ?? 0) - Math.abs(a.unpricedGap ?? 0));
  const labelSet = new Set(ranked.slice(0, 10).map((p) => `${p.longKey}|${p.shortKey}`));

  const points: ChartPoint[] = pts.map((p) => {
    const key = `${p.longKey}|${p.shortKey}`;
    const isNew = p.flags.includes("NEW");
    return {
      id: key,
      x: p.e1Gap4wChange ?? 0,
      y: p.relReturn1m ?? 0,
      r: 3,
      fill: flagFill(p.flags, p.thinGap),
      ring: isNew,
      label: labelSet.has(key) ? pairCode(p.longKey, p.shortKey) : undefined,
      labelScore: Math.abs(p.unpricedGap ?? 0),
      labelForced: isNew,
      onClick: onSelect ? () => onSelect(p) : undefined,
      def: {
        id: key,
        label: `${p.longKey} ▸ ${p.shortKey}`,
        short_def:
          "One pair. Right = the signal gap widened over the last 4 weeks; down = the long has not yet outrun the short. Bottom-right is the research zone.",
        arithmetic: `Δ4w signal gap ${pp(p.e1Gap4wChange)} · rel return 1m ${pct(p.relReturn1m)} · unpriced gap ${p.unpricedGap === null ? "—" : p.unpricedGap.toFixed(2)}σ`,
      },
    };
  });

  return (
    <ChartFrame
      height={height}
      xDomain={[-xMax, xMax]}
      yDomain={[-yMax, yMax]}
      xTitle="CHANGE IN SIGNAL GAP, 4 WKS (pp) → WIDENING"
      yTitle="LONG − SHORT RETURN, 1M (%)"
      xFmt={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
      yFmt={(v) => `${v > 0 ? "+" : ""}${(v * 100).toFixed(0)}%`}
      zones={[{ x0: 0, x1: xMax, y0: -yMax, y1: 0, fill: "rgba(47,143,69,0.10)", label: "RESEARCH ZONE", labelColor: "var(--color-positive)", labelCorner: "br" }]}
      quadrantLabels={[
        { x: -xMax * 0.5, y: yMax * 0.9, text: "PRICE MOVED, NO SIGNAL", color: "var(--text-muted)", anchor: "middle" },
        { x: xMax * 0.5, y: yMax * 0.9, text: "ALREADY PRICED", color: "var(--text-muted)", anchor: "middle" },
        { x: -xMax * 0.5, y: -yMax * 0.92, text: "NARROWING", color: "var(--text-muted)", anchor: "middle" },
      ]}
      points={points}
      maxLabels={10}
      footer={`${pts.length} pairs${hideThinGaps ? " (thin gaps hidden)" : ""}.${clipped > 0 ? ` ${clipped} pinned to the edge (open arrowhead) — clamped, not dropped.` : ""} Colour = flag state (red priced · amber factor bet · green unpriced · grey thin/none) · ring = new to top decile · click to open. Arrow threshold ${PAIR_THRESHOLDS.gapMoveArrowPp}pp.`}
    />
  );
}
