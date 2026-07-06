"use client";
/**
 * HOLDINGS — REVISIONS × 13F FLOWS. Every current holding on a plane:
 * x = revision gap (unpriced analyst-revision move), y = 13F net flow bps
 * (latest filed quarter). Dot area = position weight (clamped); color = the
 * verdict LABEL (confirm / against / quiet — agreement is never a number).
 * Gray is the expected majority on a normal day. Names missing a leg are
 * footnoted, never plotted at fabricated zeros. Adapted from the research
 * DivergenceScatter (recharts house pattern; HTML quadrant labels).
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
  ZAxis,
} from "recharts";
import type { ScatterPointDto } from "@/server/services/signal-brief.service";
import { SignalMetricTip } from "./SignalMetricTip";

const tickStyle = { fontSize: 9, fill: "var(--text-muted)" };

const VERDICT_COLOR: Record<ScatterPointDto["verdict"], string> = {
  confirm: "var(--color-positive)",
  against: "var(--color-negative)",
  quiet: "#6a6a6a",
};

/** Weight → bubble size input, clamped so a 40% position can't swallow the chart. */
function sizeOf(weight: number): number {
  return Math.min(Math.max(weight * 100, 0.5), 12);
}

function PointTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ScatterPointDto & { size: number } }>;
}) {
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
      {p.isShort ? " (S)" : ""}
      {"  WGT "}
      {(p.weight * 100).toFixed(1)}%
      {" · GAP "}
      <span style={{ fontWeight: 700 }}>
        {p.gapScore >= 0 ? "+" : ""}
        {p.gapScore.toFixed(1)}
      </span>
      {" · FLOW "}
      <span style={{ fontWeight: 700 }}>
        {p.netflowBps >= 0 ? "+" : ""}
        {p.netflowBps.toFixed(0)}bps
      </span>
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

export function RevisionsFlowScatter({
  points,
  noCoverage,
  flowQuarterLabel,
  gapSuffix,
}: {
  points: ScatterPointDto[];
  noCoverage: string[];
  /** e.g. "Q1'26" — stamped into the y-axis label. */
  flowQuarterLabel: string | null;
  /** Accruing-window suffix for the x label (empty when the payload doesn't expose it). */
  gapSuffix: string;
}) {
  const sized = points.map((p) => ({ ...p, size: sizeOf(p.weight) }));
  const quiet = sized.filter((p) => p.verdict === "quiet");
  const confirm = sized.filter((p) => p.verdict === "confirm");
  const against = sized.filter((p) => p.verdict === "against");

  return (
    <div>
      <div style={{ position: "relative", height: 260, background: "var(--bg-surface)" }}>
        {points.length === 0 ? (
          <div style={{ padding: 20, fontSize: 11, color: "var(--text-muted)" }}>
            No holdings carry both signal legs yet — coverage accrues with the weekly research
            snapshot and the next 13F aggregate.
          </div>
        ) : (
          <>
            <ResponsiveContainer>
              <ScatterChart margin={{ top: 12, right: 16, bottom: 4, left: -12 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" />
                <XAxis
                  type="number"
                  dataKey="gapScore"
                  tick={tickStyle}
                  axisLine={{ stroke: "var(--chrome-border)" }}
                  tickLine={false}
                />
                <YAxis
                  type="number"
                  dataKey="netflowBps"
                  tick={tickStyle}
                  axisLine={{ stroke: "var(--chrome-border)" }}
                  tickLine={false}
                />
                <ZAxis type="number" dataKey="size" range={[25, 320]} />
                <ReferenceLine x={0} stroke="#464646" />
                <ReferenceLine y={0} stroke="#464646" />
                <Tooltip
                  content={<PointTooltip />}
                  cursor={{ strokeDasharray: "3 3", stroke: "#464646" }}
                />
                <Scatter data={quiet} fill="#6a6a6a" fillOpacity={0.6} isAnimationActive={false} />
                <Scatter
                  data={confirm}
                  fill={VERDICT_COLOR.confirm}
                  fillOpacity={0.85}
                  isAnimationActive={false}
                />
                <Scatter
                  data={against}
                  fill={VERDICT_COLOR.against}
                  fillOpacity={0.85}
                  isAnimationActive={false}
                />
              </ScatterChart>
            </ResponsiveContainer>
            <span style={{ ...quadLabel, right: 12, top: 10, color: "var(--color-positive)" }}>
              CONFIRMED
            </span>
            <span style={{ ...quadLabel, left: 48, bottom: 26, color: "var(--color-negative)" }}>
              BOTH AGAINST — REVIEW
            </span>
            <span style={{ ...quadLabel, right: 12, bottom: 26 }}>
              REVISIONS UP, FUNDS NOT IN YET
            </span>
            <span style={{ ...quadLabel, left: 48, top: 10 }}>REVISIONS SOFT, FUNDS BUYING</span>
          </>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 14,
          flexWrap: "wrap",
          padding: "4px 8px",
          fontSize: 9,
          color: "var(--text-muted)",
        }}
      >
        <span>
          x: <SignalMetricTip id="revisionGap">revision gap — 4w{gapSuffix}</SignalMetricTip>
        </span>
        <span>
          y:{" "}
          <SignalMetricTip id="netFlowBps">
            13F net flow bps{flowQuarterLabel ? ` — ${flowQuarterLabel}` : ""}
          </SignalMetricTip>
        </span>
        <span>
          dot: <SignalMetricTip id="positionWeight">weight</SignalMetricTip>
        </span>
        <span>
          <SignalMetricTip id="verdictConfirm">
            <span style={{ color: VERDICT_COLOR.confirm }}>● confirm</span>
          </SignalMetricTip>{" "}
          <SignalMetricTip id="verdictAgainst">
            <span style={{ color: VERDICT_COLOR.against }}>● against</span>
          </SignalMetricTip>{" "}
          <SignalMetricTip id="verdictQuiet">
            <span style={{ color: "#6a6a6a" }}>● quiet</span>
          </SignalMetricTip>
        </span>
      </div>
      {noCoverage.length > 0 && (
        <div style={{ padding: "2px 8px 6px", fontSize: 9, color: "var(--text-muted)" }}>
          no signal coverage: {noCoverage.join(", ")}
        </div>
      )}
    </div>
  );
}
