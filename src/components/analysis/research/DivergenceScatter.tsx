"use client";
/**
 * IDEA QUEUE — divergence scatter. x = 4w revision composite z, y = 4w
 * peer-relative price z. The gap score is the distance from the diagonal:
 * bottom-right = revisions up, price hasn't moved (UNPRICED UPGRADES → LONG);
 * top-left = the mirror short. Click a point to filter the table to that name.
 * recharts ScatterChart (house pattern); quadrant labels are absolutely-
 * positioned HTML so they match terminal typography.
 */
import {
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { fmtZ } from "./researchUi";

export interface ScatterPoint {
  ticker: string;
  revZ: number; // composite4wZ
  pxZ: number; // px4wZ
  gap: number;
  side: string | null;
}

const tickStyle = { fontSize: 9, fill: "var(--color-accent)" };

function PointTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScatterPoint }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div
      style={{
        background: "var(--bg-base)",
        border: "1px solid var(--chrome-border)",
        padding: "5px 8px",
        fontSize: 10,
        color: "var(--text-primary)",
      }}
    >
      <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{p.ticker}</span>
      {"  REV Z "}
      {fmtZ(p.revZ, 1)}
      {" · PX Z "}
      {fmtZ(p.pxZ, 1)}
      {" · GAP "}
      <span style={{ fontWeight: 700 }}>{fmtZ(p.gap, 1)}</span>
    </div>
  );
}

const quadLabel: React.CSSProperties = {
  position: "absolute",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: 0.6,
  color: "var(--text-muted)",
  pointerEvents: "none",
};

export function DivergenceScatter({
  points,
  selected,
  onPick,
}: {
  points: ScatterPoint[];
  selected: string | null;
  onPick: (ticker: string | null) => void;
}) {
  const longs = points.filter((p) => p.side === "LONG");
  const shorts = points.filter((p) => p.side === "SHORT");
  const watch = points.filter((p) => p.side !== "LONG" && p.side !== "SHORT");
  const sel = selected ? points.filter((p) => p.ticker === selected) : [];
  const pick = (p: unknown) => {
    const t = (p as { payload?: ScatterPoint })?.payload?.ticker ?? (p as ScatterPoint)?.ticker;
    if (t) onPick(t === selected ? null : t);
  };

  return (
    <div style={{ position: "relative", height: 260, background: "var(--bg-surface)" }}>
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 12, right: 16, bottom: 4, left: -18 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" />
          <XAxis type="number" dataKey="revZ" tick={tickStyle} axisLine={{ stroke: "var(--color-accent)" }} tickLine={false} />
          <YAxis type="number" dataKey="pxZ" tick={tickStyle} axisLine={{ stroke: "var(--color-accent)" }} tickLine={false} />
          <ReferenceLine x={0} stroke="#464646" />
          <ReferenceLine y={0} stroke="#464646" />
          <Tooltip content={<PointTooltip />} cursor={{ strokeDasharray: "3 3", stroke: "#464646" }} />
          <Scatter data={watch} fill="#6a6a6a" fillOpacity={0.6} onClick={pick} cursor="pointer" isAnimationActive={false} />
          <Scatter data={longs} fill="var(--color-positive)" fillOpacity={0.85} onClick={pick} cursor="pointer" isAnimationActive={false} />
          <Scatter data={shorts} fill="var(--color-negative)" fillOpacity={0.85} onClick={pick} cursor="pointer" isAnimationActive={false} />
          {sel.length > 0 && (
            <Scatter data={sel} fill="var(--color-accent)" shape="diamond" isAnimationActive={false} onClick={pick} cursor="pointer" />
          )}
        </ScatterChart>
      </ResponsiveContainer>
      <span style={{ ...quadLabel, right: 12, bottom: 26, color: "var(--color-positive)" }}>UNPRICED UPGRADES → LONG</span>
      <span style={{ ...quadLabel, left: 42, top: 10, color: "var(--color-negative)" }}>UNPRICED DOWNGRADES → SHORT</span>
      <span style={{ ...quadLabel, right: 12, top: 10 }}>PRICED / CHASED</span>
      <span style={{ ...quadLabel, left: 42, bottom: 26 }}>WASHED OUT</span>
    </div>
  );
}
