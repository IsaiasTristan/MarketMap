"use client";
/**
 * Dispersion map (brief §8.4) — one dot per subsector. x = how split analyst
 * revisions are INSIDE the subsector, as a percentile of its own available
 * history (at most ~2.7 years on this grid, not a full 5 years)
 * (measured on RAW winsorized revisions, never within-subsector z-scores, which
 * collapse to a line). y = the subsector's revision breadth (pp). Left = names
 * move together, so trade the basket (Tier 1); right = analysts are separating
 * winners from losers, so pair stocks inside it (Tier 2). Bubble area tracks
 * name count. Renders inside the shared ChartFrame; clicking a dot loads that
 * subsector into the Tier-2 panel.
 */
import type { PairDispersionPayload } from "@/server/services/pairs/pairs-read.service";
import { signColor } from "@/components/analysis/research/primitives";
import { ChartFrame, type ChartPoint } from "@/components/analysis/ui/ChartFrame";

/** Two-sided robust bound: max(|3rd pct|, |97th pct|), symmetric about 0. */
function robustBound(vals: number[], floor: number): number {
  if (vals.length === 0) return floor;
  const s = [...vals].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0;
  return Math.max(floor, Math.abs(q(0.03)), Math.abs(q(0.97)));
}

export function DispersionMap({
  data,
  selected,
  onSelect,
  height = 240,
}: {
  data: PairDispersionPayload;
  selected?: string | null;
  onSelect?: (subsector: string) => void;
  height?: number;
}) {
  const groups = data.groups.filter((g) => g.e1Breadth !== null && g.dispersionPctile5y !== null);
  if (groups.length === 0) {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12 }}>No group dispersion yet.</div>;
  }
  const yMax = robustBound(groups.map((g) => g.e1Breadth ?? 0), 20);
  const clipped = groups.filter((g) => Math.abs(g.e1Breadth ?? 0) > yMax).length;
  const maxN = Math.max(...groups.map((g) => g.nameCount));
  const r = (n: number) => 2.5 + 6 * Math.sqrt(n / maxN);

  const points: ChartPoint[] = groups.map((g) => {
    const isSel = selected === g.key;
    return {
      id: g.key,
      x: g.dispersionPctile5y ?? 0,
      y: g.e1Breadth ?? 0,
      r: r(g.nameCount) + (isSel ? 2 : 0),
      fill: signColor(g.e1Breadth),
      fillOpacity: isSel ? 0.9 : 0.5,
      stroke: isSel ? "var(--color-accent)" : signColor(g.e1Breadth),
      strokeWidth: isSel ? 1.6 : 0.8,
      label: g.key,
      labelScore: g.nameCount,
      labelForced: isSel,
      onClick: onSelect ? () => onSelect(g.key) : undefined,
      def: {
        id: g.key,
        label: `${g.key} (${g.nameCount} names)`,
        short_def:
          "One subsector. Right = analysts are separating winners from losers (pick stocks, Tier 2); left = they treat the group alike (trade the basket, Tier 1). Up = the group is being raised.",
        arithmetic: `dispersion ${g.dispersionPctile5y?.toFixed(0)}%ile · breadth ${g.e1Breadth === null ? "—" : `${g.e1Breadth > 0 ? "+" : ""}${g.e1Breadth.toFixed(1)}pp`}`,
      },
    };
  });

  return (
    <ChartFrame
      height={height}
      xDomain={[0, 100]}
      yDomain={[-yMax, yMax]}
      xTitle="REVISION DISPERSION, PERCENTILE vs OWN HISTORY (≤2.7 YRS) →"
      yTitle="REVISION BREADTH (pp)"
      xFmt={(v) => `P${v.toFixed(0)}`}
      yFmt={(v) => `${v > 0 ? "+" : ""}${v.toFixed(0)}`}
      xTicks={[0, 20, 40, 60, 80, 100]}
      zones={[
        { x0: 0, x1: 33, fill: "rgba(74,154,240,0.07)", label: "MOVE TOGETHER → BASKET (T1)", labelColor: "var(--color-info)", labelCorner: "tl" },
        { x0: 67, x1: 100, fill: "rgba(255,140,26,0.07)", label: "SPLIT → PAIR (T2)", labelColor: "var(--color-accent)", labelCorner: "tr" },
      ]}
      points={points}
      maxLabels={20}
      footer={`${onSelect ? "Click a subsector for its Tier 2 single-stock pair. " : ""}Left = trade the basket · right = pick stocks. Bubble area ∝ name count.${clipped > 0 ? ` ${clipped} pinned to the edge (open arrowhead) — clamped into view, not dropped.` : ""}`}
    />
  );
}
