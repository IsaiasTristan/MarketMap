"use client";
/**
 * Engine 3 (Flows) — shared presentational helpers. Positional, raw-quantity
 * encodings only: split bars, sparklines, cap tags, action pills. No scores.
 */
import type { CSSProperties, ReactNode } from "react";

// ── color maps ───────────────────────────────────────────────────────────────
/** Market-cap tag colors — small-caps are BRIGHT so unfamiliar names stand out. */
const CAP_COLORS: Record<string, string> = {
  small: "#00bfff", // info cyan — the discovery zone
  mid: "#52a8cc",
  large: "var(--text-secondary)",
  mega: "var(--text-muted)",
};
export function capColor(tier: string | null | undefined): string {
  return (tier && CAP_COLORS[tier]) || "var(--text-muted)";
}

/** Quadrant → semantic color (green accumulating · amber crowded · gray static). */
export const QUADRANT_COLOR: Record<string, string> = {
  early: "var(--color-positive)",
  crowded: "var(--color-accent)",
  "broad-low": "var(--color-neutral)",
  ignored: "#555",
};
export const QUADRANT_LABEL: Record<string, string> = {
  early: "Early conviction",
  crowded: "Crowded / late-trade risk",
  "broad-low": "Broad but low conviction",
  ignored: "Ignored / early nibble",
};

const ACTION_STYLE: Record<string, { bg: string; fg: string }> = {
  NEW: { bg: "rgba(0,200,0,0.18)", fg: "var(--color-positive)" },
  ADDED: { bg: "rgba(0,200,0,0.10)", fg: "var(--color-positive)" },
  HELD: { bg: "rgba(138,138,138,0.14)", fg: "var(--text-secondary)" },
  TRIMMED: { bg: "rgba(255,50,50,0.10)", fg: "var(--color-negative)" },
  EXITED: { bg: "rgba(255,50,50,0.20)", fg: "var(--color-negative)" },
};

const TRAJECTORY_COLOR: Record<string, string> = {
  durable: "var(--color-positive)",
  accelerating: "var(--color-positive)",
  spike: "var(--text-muted)",
  choppy: "var(--text-muted)",
};
export function trajectoryColor(label: string | null | undefined): string {
  return (label && TRAJECTORY_COLOR[label]) || "var(--text-muted)";
}

// ── formatting ───────────────────────────────────────────────────────────────
export function fmtMoney(m: number): string {
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m.toFixed(0)}M`;
}
export function fmtPct(v: number | null | undefined, dp = 1): string {
  return v === null || v === undefined ? "—" : `${v.toFixed(dp)}%`;
}
export function fmtDelta(n: number): string {
  return n > 0 ? `+${n}` : `${n}`;
}

// ── components ───────────────────────────────────────────────────────────────
export function CapTag({ tier }: { tier: string | null | undefined }) {
  if (!tier) return null;
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: "0.04em",
        color: capColor(tier),
        border: `1px solid ${capColor(tier)}`,
        borderRadius: 0,
        padding: "0 3px",
        opacity: tier === "small" || tier === "mid" ? 1 : 0.7,
      }}
    >
      {tier}
    </span>
  );
}

export function ActionPill({ action }: { action: string }) {
  const s = ACTION_STYLE[action] ?? ACTION_STYLE.HELD!;
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: "lowercase",
        color: s.fg,
        background: s.bg,
        borderRadius: 0,
        padding: "1px 6px",
      }}
    >
      {action.toLowerCase()}
    </span>
  );
}

/** Raw bought-vs-sold split bar (e.g. "19 bought / 2 sold"). Positional, no score. */
export function SplitBar({ bought, sold, width = 220 }: { bought: number; sold: number; width?: number }) {
  const total = Math.max(1, bought + sold);
  const bw = (bought / total) * width;
  const sw = (sold / total) * width;
  return (
    <div style={{ display: "flex", alignItems: "center", height: 18, width, background: "var(--bg-base)", border: "1px solid var(--bg-border)" }}>
      <div style={{ width: bw, height: "100%", background: "var(--color-positive)", display: "flex", alignItems: "center", overflow: "hidden" }}>
        {bought > 0 && (
          <span style={{ fontSize: 10, color: "#000", fontWeight: 700, paddingLeft: 4, whiteSpace: "nowrap" }}>{bought} bought</span>
        )}
      </div>
      <div style={{ width: sw, height: "100%", background: "var(--color-negative)", display: "flex", alignItems: "center", justifyContent: "flex-end", overflow: "hidden" }}>
        {sold > 0 && (
          <span style={{ fontSize: 10, color: "#000", fontWeight: 700, paddingRight: 4, whiteSpace: "nowrap" }}>{sold} sold</span>
        )}
      </div>
    </div>
  );
}

/** Inline SVG sparkline of a numeric series; colored by trajectory label. */
export function Sparkline({
  values,
  label,
  width = 150,
  height = 40,
}: {
  values: number[];
  label?: string | null;
  width?: number;
  height?: number;
}) {
  const color = trajectoryColor(label);
  if (values.length < 2) return <div style={{ width, height }} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = 3;
  const pts = values.map((v, i) => {
    const x = pad + (i / (values.length - 1)) * (width - 2 * pad);
    const y = height - pad - ((v - min) / span) * (height - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const lastX = pad + (width - 2 * pad);
  const lastY = height - pad - ((values[values.length - 1]! - min) / span) * (height - 2 * pad);
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.6} />
      <circle cx={lastX} cy={lastY} r={2.4} fill={color} />
    </svg>
  );
}

/**
 * Prominent as-of banner. 13F is lagged & quarterly — this must never read as
 * live flow. Present on every view.
 */
export function AsOfBanner({ period, extra }: { period: string | null | undefined; extra?: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        background: "var(--bb-chrome)",
        color: "#fff",
        padding: "3px 10px",
        fontSize: 10,
        letterSpacing: "0.04em",
      }}
    >
      <span style={{ fontWeight: 700 }}>AS OF {period ? quarterLabel(period) : "—"}</span>
      <span style={{ opacity: 0.85 }}>period-end {period ?? "—"}</span>
      <span style={{ opacity: 0.7 }}>· 13F lags ~45 days · lagging confirmation signal, not live flow</span>
      {extra}
    </div>
  );
}

/** Legend explaining the trajectory labels (durable/accelerating vs spike/choppy). */
export function AsOfLabelNote() {
  return (
    <div style={{ fontSize: 10, color: "var(--text-muted)", display: "flex", gap: 14, flexWrap: "wrap" }}>
      <span><span style={{ color: "var(--color-positive)", fontWeight: 700 }}>durable / accelerating</span> — a rising staircase you follow</span>
      <span><span style={{ color: "var(--text-muted)", fontWeight: 700 }}>spike / choppy</span> — a one-quarter jump or noise you discount</span>
    </div>
  );
}

export function quarterLabel(period: string): string {
  const [y, m] = period.split("-");
  const q = { "03": "Q1", "06": "Q2", "09": "Q3", "12": "Q4" }[m ?? ""] ?? "";
  return `${q} ${y}`;
}

// ── shared data states ───────────────────────────────────────────────────────
export function PanelState({ state, error, children }: { state: string; error?: unknown; children: ReactNode }) {
  if (state === "loading") return <Muted>Loading…</Muted>;
  if (state === "error") return <Muted tone="negative">{error instanceof Error ? error.message : "Failed to load."}</Muted>;
  if (state === "empty") return <Muted>No data for this period.</Muted>;
  return <>{children}</>;
}

export function Muted({ children, tone, style }: { children: ReactNode; tone?: "negative"; style?: CSSProperties }) {
  return (
    <div style={{ padding: 20, fontSize: 12, color: tone === "negative" ? "var(--color-negative)" : "var(--text-muted)", ...style }}>
      {children}
    </div>
  );
}
