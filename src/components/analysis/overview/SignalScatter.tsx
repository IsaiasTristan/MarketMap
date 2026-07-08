"use client";
/**
 * SIGNAL SCATTER — a generalized two-axis holdings plane, reused for the three
 * Overview signal charts (Revisions × 13F Flows, Revisions × Inflection,
 * Inflection × 13F Flows). x/y each bind to one metric on ScatterPointDto;
 * dot area = position weight (clamped); color = the book-level verdict LABEL
 * (confirm / against / quiet), consistent across all three charts. A name is
 * plotted only if it carries BOTH of this chart's axes — names missing a leg
 * are footnoted, never plotted at fabricated zeros. Every plotted dot is tagged
 * with its ticker (white). Recharts house pattern (adapted from the research
 * DivergenceScatter).
 */
import {
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import type { ScatterPointDto } from "@/server/services/signal-brief.service";
import { bbAxisTick, bbAxisLine, bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import { SignalMetricTip } from "./SignalMetricTip";
import type { SignalMetricId } from "@/lib/analysis/signal-brief/metric-registry";

/** Metric fields on a point that can bind to an axis. */
export type AxisKey = "gapScore" | "netflowBps" | "inflection";

export interface AxisSpec {
  key: AxisKey;
  /** Short caption shown in the footer legend. */
  label: string;
  /** Metric-tip id for the footer caption (optional). */
  tipId?: SignalMetricId;
  /** Tick + tooltip number formatter. */
  format?: (v: number) => string;
}

const VERDICT_COLOR: Record<ScatterPointDto["verdict"], string> = {
  confirm: "var(--color-positive)",
  against: "var(--color-negative)",
  quiet: "#6a6a6a",
};

/** Weight → bubble size input, clamped so a 40% position can't swallow the chart. */
function sizeOf(weight: number): number {
  return Math.min(Math.max(weight * 100, 0.5), 12);
}

const fmtDefault = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1));

function AxisTooltip({
  active,
  payload,
  x,
  y,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterPointDto & { size: number } }>;
  x: AxisSpec;
  y: AxisSpec;
}) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const xv = p[x.key];
  const yv = p[y.key];
  const fx = x.format ?? fmtDefault;
  const fy = y.format ?? fmtDefault;
  return (
    <div style={{ ...bbTooltipStyle, padding: "5px 8px", fontSize: 10 }}>
      <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{p.ticker}</span>
      {p.isShort ? " (S)" : ""}
      {"  WGT "}
      {(p.weight * 100).toFixed(1)}%
      {" · "}
      {x.label} <span style={{ fontWeight: 700 }}>{xv == null ? "—" : fx(xv)}</span>
      {" · "}
      {y.label} <span style={{ fontWeight: 700 }}>{yv == null ? "—" : fy(yv)}</span>
    </div>
  );
}

const quadLabel: React.CSSProperties = {
  position: "absolute",
  fontSize: 8,
  fontWeight: 700,
  letterSpacing: 0.5,
  color: "var(--text-muted)",
  pointerEvents: "none",
};

export function SignalScatter({
  points,
  x,
  y,
  quadrants,
}: {
  points: ScatterPointDto[];
  x: AxisSpec;
  y: AxisSpec;
  /** Optional corner annotations {tl,tr,bl,br}. */
  quadrants?: { tl?: string; tr?: string; bl?: string; br?: string };
}) {
  const plotted = points
    .filter((p) => p[x.key] != null && p[y.key] != null)
    .map((p) => ({ ...p, size: sizeOf(p.weight) }));
  const missing = points.filter((p) => p[x.key] == null || p[y.key] == null).map((p) => p.ticker);

  const quiet = plotted.filter((p) => p.verdict === "quiet");
  const confirm = plotted.filter((p) => p.verdict === "confirm");
  const against = plotted.filter((p) => p.verdict === "against");

  const label = (
    <LabelList
      dataKey="ticker"
      position="right"
      offset={4}
      style={{ fill: "#fff", fontSize: 8, fontWeight: 600 }}
    />
  );

  return (
    <div>
      <div style={{ position: "relative", height: 240, background: "var(--bg-surface)" }}>
        {plotted.length === 0 ? (
          <div style={{ padding: 16, fontSize: 10, color: "var(--text-muted)" }}>
            No holdings carry both legs yet — coverage accrues with the weekly snapshots.
          </div>
        ) : (
          <>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 12, right: 20, bottom: 4, left: -8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" />
                <XAxis
                  type="number"
                  dataKey={x.key}
                  tick={bbAxisTick}
                  axisLine={bbAxisLine}
                  tickLine={false}
                  tickFormatter={x.format}
                />
                <YAxis
                  type="number"
                  dataKey={y.key}
                  tick={bbAxisTick}
                  axisLine={bbAxisLine}
                  tickLine={false}
                  width={40}
                  tickFormatter={y.format}
                />
                <ZAxis type="number" dataKey="size" range={[25, 300]} />
                <ReferenceLine x={0} stroke="#464646" />
                <ReferenceLine y={0} stroke="#464646" />
                <Tooltip
                  content={<AxisTooltip x={x} y={y} />}
                  cursor={{ strokeDasharray: "3 3", stroke: "#464646" }}
                />
                <Scatter data={quiet} fill="#6a6a6a" fillOpacity={0.6} isAnimationActive={false}>
                  {label}
                </Scatter>
                <Scatter data={confirm} fill={VERDICT_COLOR.confirm} fillOpacity={0.85} isAnimationActive={false}>
                  {label}
                </Scatter>
                <Scatter data={against} fill={VERDICT_COLOR.against} fillOpacity={0.85} isAnimationActive={false}>
                  {label}
                </Scatter>
              </ScatterChart>
            </ResponsiveContainer>
            {quadrants?.tr && <span style={{ ...quadLabel, right: 10, top: 8, color: "var(--color-positive)" }}>{quadrants.tr}</span>}
            {quadrants?.tl && <span style={{ ...quadLabel, left: 44, top: 8 }}>{quadrants.tl}</span>}
            {quadrants?.br && <span style={{ ...quadLabel, right: 10, bottom: 8 }}>{quadrants.br}</span>}
            {quadrants?.bl && <span style={{ ...quadLabel, left: 44, bottom: 8, color: "var(--color-negative)" }}>{quadrants.bl}</span>}
          </>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 12,
          flexWrap: "wrap",
          padding: "4px 8px",
          fontSize: 9,
          color: "var(--text-muted)",
        }}
      >
        <span>x: {x.tipId ? <SignalMetricTip id={x.tipId}>{x.label}</SignalMetricTip> : x.label}</span>
        <span>y: {y.tipId ? <SignalMetricTip id={y.tipId}>{y.label}</SignalMetricTip> : y.label}</span>
        <span>
          <span style={{ color: VERDICT_COLOR.confirm }}>● confirm</span>{" "}
          <span style={{ color: VERDICT_COLOR.against }}>● against</span>{" "}
          <span style={{ color: "#6a6a6a" }}>● quiet</span>
        </span>
      </div>
      {missing.length > 0 && (
        <div style={{ padding: "2px 8px 6px", fontSize: 9, color: "var(--text-muted)" }}>
          no coverage on these axes: {missing.join(", ")}
        </div>
      )}
    </div>
  );
}
