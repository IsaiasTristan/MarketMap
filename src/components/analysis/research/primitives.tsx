"use client";
/**
 * Engine 1 rebuild — the drawing primitives the three screens share.
 *
 * All inline SVG / CSS: the queue renders 50 rows x (sparkline + centered bar
 * + decile strip) per page and the universe heatmap is ~80 cells, so a chart
 * library per cell is not affordable. Every component here is presentational
 * — it receives numbers that already exist on a RevisionScreenRow and draws
 * them. No screen may compute a signal client-side.
 */
import type { CSSProperties } from "react";
import { MetricTip } from "./MetricTip";
import type { RevMetricId } from "@/lib/revision/metric-registry";
import { engineTagSign } from "@/lib/revision/screen-format";

const POSITIVE = "#2f8f45";
const NEGATIVE = "#a83a3f";

/** Sign color for a signed number; muted when there is nothing to show. */
export function signColor(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v) || v === 0) return "var(--text-muted)";
  return v > 0 ? "var(--color-positive)" : "var(--color-negative)";
}

// ── Sparkline ────────────────────────────────────────────────────────────────

/**
 * Score trajectory. Clamped rather than auto-scaled so a row's line is
 * comparable to every other row's at a glance; `clamp` is in z units.
 */
export function Sparkline({
  values,
  w = 90,
  h = 18,
  color,
  zero = true,
  clamp = 2.6,
}: {
  values: Array<number | null>;
  w?: number;
  h?: number;
  color?: string;
  zero?: boolean;
  clamp?: number;
}) {
  const finite = values.map((v) => (v === null || !Number.isFinite(v) ? null : v));
  const n = finite.length;
  if (n === 0) return <span style={{ display: "inline-block", width: w, height: h }} />;

  const y = (v: number) => h / 2 - (Math.max(-clamp, Math.min(clamp, v)) / clamp) * (h / 2 - 1);
  const x = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);

  // Nulls break the line rather than interpolating across a missing week.
  const segments: string[] = [];
  let run: string[] = [];
  finite.forEach((v, i) => {
    if (v === null) {
      if (run.length > 1) segments.push(run.join(" "));
      run = [];
      return;
    }
    run.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (run.length > 1) segments.push(run.join(" "));

  const last = [...finite].reverse().find((v) => v !== null) ?? null;
  const stroke = color ?? (last !== null && last < 0 ? NEGATIVE : POSITIVE);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true" style={{ display: "block" }}>
      {zero && <line x1={0} y1={h / 2} x2={w} y2={h / 2} stroke="#2a2a2e" strokeWidth={1} />}
      {segments.map((pts, i) => (
        <polyline key={i} fill="none" stroke={stroke} strokeWidth={1.4} points={pts} />
      ))}
      {last !== null && segments.length > 0 && (
        <circle cx={x(n - 1)} cy={y(last)} r={1.6} fill={stroke} />
      )}
    </svg>
  );
}

// ── Centered bar ─────────────────────────────────────────────────────────────

/** Score column: zero axis at center, bar grows right for positive, left for negative. */
export function CenteredBar({
  value,
  range = 3,
  w = 80,
  h = 10,
}: {
  value: number | null;
  range?: number;
  w?: number;
  h?: number;
}) {
  const half = w / 2;
  const v = value === null || !Number.isFinite(value) ? 0 : value;
  const len = Math.min(half, (Math.abs(v) / range) * half);
  const style: CSSProperties = {
    position: "absolute",
    top: (h - 4) / 2,
    height: 4,
    width: len,
    background: v >= 0 ? "var(--color-positive)" : "var(--color-negative)",
    [v >= 0 ? "left" : "right"]: half,
  };
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: w,
        height: h,
        verticalAlign: "middle",
        background: "var(--bg-surface)",
      }}
    >
      <span style={{ position: "absolute", left: half, top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
      {value !== null && Number.isFinite(value) && <span style={style} />}
    </span>
  );
}

// ── Decile strip ─────────────────────────────────────────────────────────────

/**
 * Six blocks, oldest left, filled where the name sat in the target decile.
 * Reads as a persistence bar: six filled = a six-week run at the top.
 */
export function DecileStrip({
  decileHist,
  target = 10,
  cells = 6,
}: {
  decileHist: number[];
  target?: 1 | 10;
  cells?: number;
}) {
  const hist = decileHist.slice(-cells);
  const padded = [...Array(Math.max(0, cells - hist.length)).fill(0), ...hist] as number[];
  const fill = target === 10 ? "var(--color-positive)" : "var(--color-negative)";
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
      {padded.map((d, i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 10,
            display: "inline-block",
            boxSizing: "border-box",
            background: d === target ? fill : "var(--bg-surface)",
            border: d === target ? "1px solid transparent" : "1px solid var(--chrome-border)",
          }}
        />
      ))}
    </span>
  );
}

// ── Tags ─────────────────────────────────────────────────────────────────────

/** Chip tone for an Engine 2/3/4 tag, off the shared sign convention. */
export function engineTagTone(tag: string | null): "positive" | "negative" | "muted" {
  const s = engineTagSign(tag);
  return s === 1 ? "positive" : s === -1 ? "negative" : "muted";
}

/** Outlined tag chip used for the E2/E3/E4 columns and the NEW marker. */
export function Tag({
  label,
  tone = "muted",
  title,
}: {
  label: string;
  tone?: "positive" | "negative" | "muted" | "warning";
  title?: string;
}) {
  const color =
    tone === "positive"
      ? "var(--color-positive)"
      : tone === "negative"
        ? "var(--color-negative)"
        : tone === "warning"
          ? "var(--color-accent)"
          : "var(--text-muted)";
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: 0.5,
        color,
        border: `1px solid ${color}`,
        padding: "0 3px",
        lineHeight: "12px",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

// ── Status chips ─────────────────────────────────────────────────────────────

export interface StatusChipsProps {
  /** The signal the queue ranks on, e.g. "ptRevOrthZ". */
  rankSignal: string;
  horizonWeeks: number;
  meanIC: number | null;
  hacT: number | null;
  naiveT: number | null;
  effectiveWeeks: number | null;
  headlineMinWeeks: number;
  headlineReady: boolean;
  /** Mean week-over-week Jaccard of the top 25. */
  overlap: number | null;
  gridWeeks: number;
}

function Chip({
  metricId,
  label,
  value,
  tone,
  sub,
}: {
  metricId: RevMetricId;
  label: string;
  value: string;
  tone?: "positive" | "negative" | "warning";
  sub?: string;
}) {
  const color =
    tone === "positive"
      ? "var(--color-positive)"
      : tone === "negative"
        ? "var(--color-negative)"
        : tone === "warning"
          ? "var(--color-accent)"
          : "var(--text-primary)";
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 5, whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 9, letterSpacing: 0.5, color: "var(--text-muted)", textTransform: "uppercase" }}>
        <MetricTip id={metricId}>{label}</MetricTip>
      </span>
      <span className="bb-num" style={{ fontSize: 11, fontWeight: 700, color }}>
        {value}
      </span>
      {sub && <span style={{ fontSize: 9, color: "var(--text-muted)" }}>{sub}</span>}
    </span>
  );
}

/**
 * The header strip on all three screens. Replaces the old red banner: it
 * states what the rank is, how well it has measured, and — below
 * `headlineMinWeeks` independent weeks — says ACCRUING instead of printing a
 * headline the sample cannot support.
 */
export function StatusChips(props: StatusChipsProps) {
  const {
    rankSignal,
    horizonWeeks,
    meanIC,
    hacT,
    naiveT,
    effectiveWeeks,
    headlineMinWeeks,
    headlineReady,
    overlap,
    gridWeeks,
  } = props;

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 18,
        padding: "5px 10px",
        border: "1px solid var(--chrome-border)",
        background: "var(--bg-surface)",
      }}
    >
      <Chip
        metricId="ptRevOrthZ"
        label="rank signal"
        value={rankSignal}
        sub={`${gridWeeks}w grid · t+1 entry`}
      />
      {headlineReady ? (
        <>
          <Chip
            metricId="rollingIc"
            label={`IC ${horizonWeeks}w`}
            value={meanIC === null ? "—" : meanIC.toFixed(4)}
            tone={meanIC !== null && meanIC > 0 ? "positive" : meanIC !== null && meanIC < 0 ? "negative" : undefined}
          />
          <Chip
            metricId="hacT"
            label="t-stat"
            value={hacT === null ? "—" : hacT.toFixed(2)}
            tone={hacT !== null && Math.abs(hacT) >= 2 ? "positive" : "warning"}
            sub={naiveT === null ? undefined : `naive ${naiveT.toFixed(2)}`}
          />
          <Chip
            metricId="effectiveWindow"
            label="eff. weeks"
            value={effectiveWeeks === null ? "—" : String(effectiveWeeks)}
          />
        </>
      ) : (
        <Chip
          metricId="effectiveWindow"
          label="headline"
          value="ACCRUING"
          tone="warning"
          sub={`${effectiveWeeks ?? 0} of ${headlineMinWeeks} eff. weeks`}
        />
      )}
      <Chip
        metricId="queueOverlap"
        label="top-25 overlap w/w"
        value={overlap === null ? "—" : `${(overlap * 100).toFixed(0)}%`}
      />
    </div>
  );
}
