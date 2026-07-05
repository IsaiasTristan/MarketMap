"use client";
/**
 * Engine 1 — shared terminal-styled primitives for the research tabs:
 * bracketed setup chips, side chips, streak block strips, stat strips,
 * grp│idio split bars, insufficient-history placeholders, and effective-window
 * tags. All definitions render through MetricTip (registry-sourced) — no
 * inline metric copy here.
 */
import type { CSSProperties, ReactNode } from "react";
import { heatSignedBloomberg } from "@/components/analysis/ui/heat";
import { MetricTip } from "./MetricTip";
import type { RevMetricId } from "@/lib/revision/metric-registry";

// ── formatters ───────────────────────────────────────────────────────────────

/** Null-tolerant heat color for decision cells; muted gray when no value. */
export function heatZ(v: number | null | undefined, span: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "var(--text-muted)";
  return heatSignedBloomberg(v, span);
}

export function fmtZ(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;
}

export function fmtPctSigned(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}%`;
}

// ── chips ────────────────────────────────────────────────────────────────────

const TAG_TONES: Record<string, { color: string; tip: RevMetricId }> = {
  UNPR: { color: "var(--color-accent)", tip: "setupUnpr" },
  STRK: { color: "var(--color-positive)", tip: "setupStrk" },
  ER: { color: "#ffd24a", tip: "setupEr" },
  DOMINO: { color: "#5aa0ff", tip: "setupDomino" },
};

/** Bracketed terminal tag chip, e.g. [UNPR]. Definition on hover via the registry. */
export function TagChip({ tag }: { tag: string }) {
  const tone = TAG_TONES[tag] ?? { color: "var(--text-muted)", tip: null };
  const chip = (
    <span
      style={{
        display: "inline-block",
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: tone.color,
        border: `1px solid ${tone.color}`,
        borderRadius: 0,
        padding: "0 3px",
        lineHeight: "12px",
        marginRight: 3,
        whiteSpace: "nowrap",
      }}
    >
      {tag}
    </span>
  );
  if (!tone.tip) return chip;
  return (
    <MetricTip id={tone.tip} style={{ borderBottom: "none" }}>
      {chip}
    </MetricTip>
  );
}

/** Filled side chip: L (long) / S (short) / W (watch). */
export function SideChip({ side }: { side: string | null | undefined }) {
  const key = side === "LONG" ? "L" : side === "SHORT" ? "S" : "W";
  const bg = key === "L" ? "var(--color-positive)" : key === "S" ? "var(--color-negative)" : "#464646";
  return (
    <span
      style={{
        display: "inline-block",
        fontSize: 8,
        fontWeight: 700,
        color: "#000",
        background: bg,
        padding: "0 5px",
        lineHeight: "12px",
      }}
    >
      {key}
    </span>
  );
}

// ── streak strip ─────────────────────────────────────────────────────────────

/**
 * Six-cell streak block strip: one cell per week (oldest left), green =
 * positive composite, red = negative, empty = flat/no data. `Lᴮ` marks the
 * Leg-B-only source while Leg A accrues.
 */
export function StreakStrip({
  history,
  source,
}: {
  history: Array<-1 | 0 | 1>;
  source?: string | null;
}) {
  const cells = [...Array(Math.max(0, 6 - history.length)).fill(0), ...history.slice(-6)] as Array<-1 | 0 | 1>;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
      {cells.map((v, i) => (
        <span
          key={i}
          style={{
            width: 8,
            height: 10,
            display: "inline-block",
            background: v > 0 ? "var(--color-positive)" : v < 0 ? "var(--color-negative)" : "var(--bg-surface)",
            border: v === 0 ? "1px solid var(--chrome-border)" : "1px solid transparent",
            boxSizing: "border-box",
          }}
        />
      ))}
      {source === "LEG_B" && (
        <MetricTip id="streakSource" style={{ borderBottom: "none" }}>
          <sup style={{ fontSize: 7, color: "#ffd24a", marginLeft: 2, fontWeight: 700 }}>Lᴮ</sup>
        </MetricTip>
      )}
    </span>
  );
}

// ── stat strip ───────────────────────────────────────────────────────────────

export interface StatItem {
  metricId: RevMetricId;
  label: string;
  value: ReactNode;
  delta?: string;
  deltaDir?: "up" | "down";
  sub?: string;
  tone?: "positive" | "negative" | "warning";
}

/** Horizontal row of flat stat tiles (Summary/Validation headers). */
export function StatStrip({ items }: { items: StatItem[] }) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 1, background: "var(--chrome-border)", border: "1px solid var(--chrome-border)" }}>
      {items.map((it) => (
        <div key={it.label} style={{ flex: "1 1 120px", background: "var(--bg-surface)", padding: "6px 10px", minWidth: 110 }}>
          <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: "var(--text-muted)", textTransform: "uppercase" }}>
            <MetricTip id={it.metricId}>{it.label}</MetricTip>
          </div>
          <div
            className="bb-num"
            style={{
              fontSize: 14,
              fontWeight: 700,
              color:
                it.tone === "positive"
                  ? "var(--color-positive)"
                  : it.tone === "negative"
                    ? "var(--color-negative)"
                    : it.tone === "warning"
                      ? "var(--color-warning)"
                      : "var(--text-primary)",
            }}
          >
            {it.value}
            {it.delta && (
              <span
                style={{
                  fontSize: 9,
                  marginLeft: 5,
                  color: it.deltaDir === "down" ? "var(--color-negative)" : "var(--color-positive)",
                }}
              >
                {it.deltaDir === "down" ? "▼" : "▲"} {it.delta}
              </span>
            )}
          </div>
          {it.sub && <div style={{ fontSize: 9, color: "var(--text-muted)" }}>{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

// ── grp │ idio split bar ─────────────────────────────────────────────────────

/**
 * Inline centered HTML bar: zero-axis at center, gray segment = group
 * component, amber = idio. Pure HTML/CSS so it scales to hundreds of rows.
 * Negative components render to the LEFT of the axis at reduced opacity.
 */
export function GroupIdioBar({
  groupZ,
  idioZ,
  span = 2.5,
  width = 96,
}: {
  groupZ: number | null;
  idioZ: number | null;
  span?: number;
  width?: number;
}) {
  const half = width / 2;
  const px = (v: number | null): number =>
    v === null || !Number.isFinite(v) ? 0 : Math.min(half, (Math.abs(v) / span) * half);
  const seg = (v: number | null, color: string, stack: number): CSSProperties => {
    const w = px(v);
    const neg = (v ?? 0) < 0;
    return {
      position: "absolute",
      top: stack,
      height: 4,
      width: w,
      [neg ? "right" : "left"]: half,
      background: color,
      opacity: neg ? 0.55 : 1,
    } as CSSProperties;
  };
  return (
    <span style={{ position: "relative", display: "inline-block", width, height: 12, verticalAlign: "middle", background: "var(--bg-surface)" }}>
      <span style={{ position: "absolute", left: half, top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
      <span style={seg(groupZ, "#8a8a8a", 1)} />
      <span style={seg(idioZ, "var(--color-accent)", 7)} />
    </span>
  );
}

// ── history states ───────────────────────────────────────────────────────────

/** Terminal-style placeholder for views below their minimum history. */
export function InsufficientHistory({ have, need, note }: { have: number; need: number; note?: string }) {
  return (
    <div
      style={{
        border: "1px dashed var(--chrome-border)",
        padding: "18px 14px",
        fontSize: 11,
        letterSpacing: 0.5,
        color: "var(--text-muted)",
        textAlign: "center",
      }}
    >
      INSUFFICIENT HISTORY — {have} OF {need} WKS MIN · ACCRUING
      {note && <div style={{ fontSize: 9, marginTop: 4 }}>{note}</div>}
    </div>
  );
}

/** Tiny effective-window tag attached to every validation figure: `8W · FULL`. */
export function WindowTag({ weeks, source }: { weeks: number; source: "FULL" | "LEG_B" | string }) {
  const legB = source !== "FULL";
  return (
    <MetricTip id={legB ? "legBOnly" : "effectiveWindow"} style={{ borderBottom: "none" }}>
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.5, color: legB ? "#ffd24a" : "var(--text-muted)" }}>
        {weeks}W · {legB ? "LEG-B ONLY" : "FULL"}
      </span>
    </MetricTip>
  );
}
