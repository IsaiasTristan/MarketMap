"use client";
/**
 * Screen 1 — the universe panels. Each one answers "where are analysts
 * changing their minds" and clicks through into the queue with the matching
 * filter already applied, so the zoom from market to name is one path.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
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
import { Sparkline } from "../primitives";
import { MetricTip } from "../MetricTip";
import { breadthTint, fmtCap } from "@/lib/revision/screen-format";
import type { SubsectorBreadthCell } from "@/lib/revision/screen-rows";
import type { UniversePayload } from "@/server/services/revision/revision-screen.service";
import { REVISION_BASE, queueQueryString } from "./useScreens";

/** Names the arrivals / exits panel lists before collapsing into "+N more". */
const CHIP_LIMIT = 14;
/** Dots the scatter labels, chosen by the widest unpriced gap. */
const LABEL_TOP = 8;

// ── Breadth strip ────────────────────────────────────────────────────────────

export function BreadthTiles({ strip }: { strip: UniversePayload["strip"] }) {
  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const ratio =
    strip.ptDownTotal > 0 ? (strip.ptUpTotal / strip.ptDownTotal).toFixed(2) : strip.ptUpTotal > 0 ? "∞" : "—";
  const total = strip.ptUpTotal + strip.ptDownTotal;
  const upShare = total > 0 ? (strip.ptUpTotal / total) * 100 : 0;
  const total4w = (strip.ptUpTotal4wAgo ?? 0) + (strip.ptDownTotal4wAgo ?? 0);

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 1, background: "var(--chrome-border)", border: "1px solid var(--chrome-border)" }}>
      <div style={{ background: "var(--bg-surface)", padding: "6px 10px" }}>
        <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
          <MetricTip id="pctNamesNetUp">Share of stocks where analysts are raising</MetricTip>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="bb-num" style={{ fontSize: 16, fontWeight: 700 }}>
            {pct(strip.pctNamesNetUp)}
          </span>
          {strip.pctNamesNetUpWow !== null && (
            <span style={{ fontSize: 9, color: strip.pctNamesNetUpWow >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>
              {strip.pctNamesNetUpWow >= 0 ? "▲" : "▼"} {Math.abs(strip.pctNamesNetUpWow * 100).toFixed(1)}pp w/w
            </span>
          )}
          <div style={{ flex: 1 }} />
          <Sparkline values={strip.pctNamesNetUpHist.map((v) => (v === null ? null : v - 0.5))} w={110} h={22} clamp={0.5} color="var(--color-accent)" />
        </div>
        <div style={{ fontSize: 8.5, color: "var(--text-muted)" }}>26 weeks · {strip.namesScored.toLocaleString()} names scored</div>
      </div>

      <div style={{ background: "var(--bg-surface)", padding: "6px 10px" }}>
        <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
          <MetricTip id="ptFlowWeek">Price-target changes this week</MetricTip>
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span className="bb-num" style={{ fontSize: 16, fontWeight: 700, color: "var(--color-positive)" }}>
            {strip.ptUpTotal.toLocaleString()}
          </span>
          <span style={{ color: "var(--text-muted)" }}>up</span>
          <span className="bb-num" style={{ fontSize: 16, fontWeight: 700, color: "var(--color-negative)" }}>
            {strip.ptDownTotal.toLocaleString()}
          </span>
          <span style={{ color: "var(--text-muted)" }}>down · {ratio}×</span>
        </div>
        <div style={{ display: "flex", height: 5, marginTop: 3, background: "var(--color-negative)" }}>
          <div style={{ width: `${upShare}%`, background: "var(--color-positive)" }} />
        </div>
        <div style={{ fontSize: 8.5, color: "var(--text-muted)" }}>
          {total4w > 0
            ? `4 weeks ago: ${strip.ptUpTotal4wAgo} up / ${strip.ptDownTotal4wAgo} down`
            : "no comparison week yet"}
        </div>
      </div>
    </div>
  );
}

// ── Density overlay ──────────────────────────────────────────────────────────

export function DensityOverlay({ histogram }: { histogram: UniversePayload["histogram"] }) {
  const W = 300;
  const H = 96;
  const { bins, prior4w, min, max } = histogram;
  const peak = Math.max(1, ...bins, ...(prior4w ?? []));
  const x = (i: number) => (i / Math.max(1, bins.length - 1)) * W;
  const y = (v: number) => H - 14 - (v / peak) * (H - 22);
  const path = (arr: number[]) => arr.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const zeroBin = ((0 - min) / (max - min)) * (bins.length - 1);

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block" }}>
        <line x1={x(zeroBin)} y1={4} x2={x(zeroBin)} y2={H - 14} stroke="#3a3a40" strokeDasharray="2 3" />
        {prior4w && <path d={path(prior4w)} fill="none" stroke="#6b6b70" strokeWidth={1.1} strokeDasharray="3 3" />}
        <path d={path(bins)} fill="none" stroke="var(--color-accent)" strokeWidth={1.4} />
        <text x={0} y={H - 3} fontSize={8} fill="#6b6b70">
          {min}
        </text>
        <text x={x(zeroBin)} y={H - 3} textAnchor="middle" fontSize={8} fill="#6b6b70">
          0
        </text>
        <text x={W} y={H - 3} textAnchor="end" fontSize={8} fill="#6b6b70">
          +{max}
        </text>
      </svg>
      <div style={{ fontSize: 8.5, color: "var(--text-muted)" }}>
        <span style={{ color: "var(--color-accent)" }}>—— this week</span> · <span>– – four weeks ago</span>. A fatter
        right tail means the strong names are pulling further ahead of the pack.
      </div>
    </div>
  );
}

// ── Arrivals / exits ─────────────────────────────────────────────────────────

function Chips({ tickers, tone }: { tickers: string[]; tone: "positive" | "negative" }) {
  const shown = tickers.slice(0, CHIP_LIMIT);
  const color = tone === "positive" ? "var(--color-positive)" : "var(--color-negative)";
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 3 }}>
      {shown.map((t) => (
        <Link
          key={t}
          href={`${REVISION_BASE}/${t}`}
          style={{ fontSize: 9, fontWeight: 700, color, border: `1px solid ${color}`, padding: "0 3px", textDecoration: "none" }}
        >
          {t}
        </Link>
      ))}
      {tickers.length > shown.length && (
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>+{tickers.length - shown.length} more</span>
      )}
    </div>
  );
}

export function ChurnPanel({ churn }: { churn: UniversePayload["churn"] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, fontSize: 10 }}>
      <div>
        <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--color-positive)", textTransform: "uppercase" }}>
          Joined the top 10% · {churn.arrivals.length}
        </div>
        <Chips tickers={churn.arrivals} tone="positive" />
      </div>
      <div>
        <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--color-negative)", textTransform: "uppercase" }}>
          Left the top 10% · {churn.exits.length}
        </div>
        <Chips tickers={churn.exits} tone="negative" />
      </div>
    </div>
  );
}

// ── Subsector heatmap ────────────────────────────────────────────────────────

export function SubsectorHeatmap({ cells }: { cells: SubsectorBreadthCell[] }) {
  const sorted = useMemo(() => [...cells].sort((a, b) => b.z - a.z), [cells]);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 2 }}>
      {sorted.map((c) => (
        <Link
          key={c.name}
          href={`${REVISION_BASE}/queue?${queueQueryString({ subsector: c.name, minZ: 0 })}`}
          title={`${c.name} · breadth z ${c.z.toFixed(2)} · ${c.n} names`}
          style={{
            background: breadthTint(c.z),
            border: "1px solid var(--chrome-border)",
            padding: "4px 6px",
            textDecoration: "none",
            color: "var(--text-primary)",
            display: "block",
          }}
        >
          <div style={{ fontSize: 8.5, letterSpacing: 0.3, textTransform: "uppercase", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {c.name}
          </div>
          <div style={{ display: "flex", alignItems: "baseline", gap: 5 }}>
            <span className="bb-num" style={{ fontSize: 13, fontWeight: 700 }}>
              {c.z >= 0 ? "+" : ""}
              {c.z.toFixed(2)}
            </span>
            {/* The tile fill already carries the sign, so the delta stays neutral to stay legible on it. */}
            {c.chg4w !== null && (
              <span style={{ fontSize: 8.5, color: "rgba(255,255,255,0.72)" }}>
                {c.chg4w >= 0 ? "▲" : "▼"} {Math.abs(c.chg4w).toFixed(1)}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 8.5, color: "var(--text-muted)" }}>n={c.n}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

// ── Revision vs price scatter ────────────────────────────────────────────────

type ScatterRow = UniversePayload["scatter"][number];

const tickStyle = { fontSize: 9, fill: "var(--color-accent)" };

function PointTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ScatterRow }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div style={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", padding: "4px 7px", fontSize: 10 }}>
      <div style={{ color: "var(--color-accent)", fontWeight: 700 }}>
        {p.ticker} · {p.subsector}
      </div>
      <div style={{ color: "var(--text-muted)" }}>
        analysts raising vs peers {p.ptRevOrthZ.toFixed(2)} · stock vs peers{" "}
        {p.pxZ === null ? "—" : p.pxZ.toFixed(2)} · gap {p.gap === null ? "—" : p.gap.toFixed(2)}
      </div>
      <div style={{ color: "var(--text-muted)" }}>
        {fmtCap(p.mktCap)} · {p.weeksInTopDecile}w in the top decile
      </div>
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

/** Fill by persistence: a one-week wonder should not look like a four-week run. */
function persistenceFill(weeks: number): string {
  if (weeks >= 4) return "var(--color-accent)";
  if (weeks >= 2) return "#d07b2a";
  return "#6b6b70";
}

export function RevPriceScatter({ rows }: { rows: ScatterRow[] }) {
  const router = useRouter();
  const [hoverTicker, setHoverTicker] = useState<string | null>(null);

  const points = rows.filter((r) => r.pxZ !== null);
  // A handful of names run to |z| > 10 and would squash everything else into a
  // band, so the axes are clipped at a robust quantile and the clipped count is
  // stated rather than silently dropped.
  const domain = useMemo(() => {
    const q = (vals: number[]) => {
      if (vals.length === 0) return 3;
      const s = vals.map(Math.abs).sort((a, b) => a - b);
      return Math.max(3, Math.ceil(s[Math.floor(s.length * 0.97)] ?? 3));
    };
    const bound = Math.max(q(points.map((p) => p.ptRevOrthZ)), q(points.map((p) => p.pxZ as number)));
    const clipped = points.filter((p) => Math.abs(p.ptRevOrthZ) > bound || Math.abs(p.pxZ as number) > bound).length;
    return { bound, clipped };
  }, [points]);
  const buckets = [
    { key: "1w", data: points.filter((p) => p.weeksInTopDecile <= 1) },
    { key: "2-3w", data: points.filter((p) => p.weeksInTopDecile >= 2 && p.weeksInTopDecile <= 3) },
    { key: "4w+", data: points.filter((p) => p.weeksInTopDecile >= 4) },
  ];
  const labelled = [...points]
    .sort((a, b) => Math.abs(b.gap ?? 0) - Math.abs(a.gap ?? 0))
    .slice(0, LABEL_TOP);

  const open = (p: unknown) => {
    const t = (p as { payload?: ScatterRow })?.payload?.ticker ?? (p as ScatterRow)?.ticker;
    if (t) router.push(`${REVISION_BASE}/${t}`);
  };

  return (
    <div>
      <div style={{ position: "relative", height: 300, background: "var(--bg-surface)" }}>
        <ResponsiveContainer>
          <ScatterChart margin={{ top: 14, right: 18, bottom: 18, left: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--chrome-border)" />
            <XAxis
              type="number"
              dataKey="ptRevOrthZ"
              domain={[-domain.bound, domain.bound]}
              allowDataOverflow
              tick={tickStyle}
              axisLine={{ stroke: "var(--color-accent)" }}
              tickLine={false}
              label={{
                value: "→ analysts raising targets more than peers",
                position: "insideBottomRight",
                offset: -12,
                style: { fontSize: 9, fill: "var(--text-muted)" },
              }}
            />
            <YAxis
              type="number"
              dataKey="pxZ"
              domain={[-domain.bound, domain.bound]}
              allowDataOverflow
              width={34}
              tick={tickStyle}
              axisLine={{ stroke: "var(--color-accent)" }}
              tickLine={false}
              label={{
                value: "↑ stock beat its peers",
                angle: -90,
                position: "insideLeft",
                offset: 4,
                style: { fontSize: 9, fill: "var(--text-muted)" },
              }}
            />
            <ZAxis type="number" dataKey="mktCap" range={[10, 90]} />
            <ReferenceLine x={0} stroke="#464646" />
            <ReferenceLine y={0} stroke="#464646" />
            <ReferenceLine
              segment={[
                { x: -domain.bound, y: -domain.bound },
                { x: domain.bound, y: domain.bound },
              ]}
              stroke="#464646"
              strokeDasharray="2 4"
            />
            <Tooltip content={<PointTooltip />} cursor={{ strokeDasharray: "3 3", stroke: "#464646" }} />
            {buckets.map((b) => (
              <Scatter
                key={b.key}
                data={b.data}
                fill={persistenceFill(b.key === "4w+" ? 4 : b.key === "2-3w" ? 2 : 1)}
                fillOpacity={0.8}
                onClick={open}
                onMouseEnter={(p: unknown) => setHoverTicker((p as { ticker?: string })?.ticker ?? null)}
                onMouseLeave={() => setHoverTicker(null)}
                cursor="pointer"
                isAnimationActive={false}
              />
            ))}
          </ScatterChart>
        </ResponsiveContainer>
        <span style={{ ...quadLabel, right: 14, bottom: 34, color: "var(--color-positive)" }}>UNPRICED UPGRADE</span>
        <span style={{ ...quadLabel, right: 14, top: 12 }}>PRICED / CHASED</span>
        <span style={{ ...quadLabel, left: 46, top: 12, color: "var(--color-negative)" }}>UNPRICED DOWNGRADE</span>
        <span style={{ ...quadLabel, left: 46, bottom: 34 }}>WASHED OUT</span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, padding: "4px 6px", fontSize: 8.5, color: "var(--text-muted)" }}>
        <span>Dot size = company size.</span>
        <span style={{ color: persistenceFill(1) }}>● first week in the top decile</span>
        <span style={{ color: persistenceFill(2) }}>● 2–3 weeks</span>
        <span style={{ color: persistenceFill(4) }}>● 4 weeks or more</span>
        <span>
          {points.length} names with a score of 1 or stronger. Click a dot for the name page.
          {domain.clipped > 0 ? ` ${domain.clipped} sit outside the axis range.` : ""}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "0 6px 4px" }}>
        <span style={{ fontSize: 8.5, color: "var(--text-muted)", letterSpacing: 0.4 }}>WIDEST GAPS:</span>
        {labelled.map((p) => (
          <Link
            key={p.ticker}
            href={`${REVISION_BASE}/${p.ticker}`}
            style={{
              fontSize: 9,
              fontWeight: 700,
              textDecoration: "none",
              color: (p.gap ?? 0) >= 0 ? "var(--color-positive)" : "var(--color-negative)",
              opacity: hoverTicker && hoverTicker !== p.ticker ? 0.5 : 1,
            }}
          >
            {p.ticker} {(p.gap ?? 0) >= 0 ? "+" : ""}
            {(p.gap ?? 0).toFixed(1)}
          </Link>
        ))}
      </div>
    </div>
  );
}

// ── Composition ──────────────────────────────────────────────────────────────

const CAP_LABEL: Record<string, string> = {
  MICRO: "< $300M",
  SMALL: "$300M–$2B",
  MID: "$2B–$10B",
  LARGE: "> $10B",
};
const COV_LABEL: Record<string, string> = {
  THIN: "1–4 analysts",
  MID: "5–10 analysts",
  DEEP: "11+ analysts",
};

function CompositionBar({
  title,
  buckets,
  labels,
}: {
  title: string;
  buckets: Array<{ bucket: string; topDecile: number; universe: number }>;
  labels: Record<string, string>;
}) {
  const topTotal = buckets.reduce((a, b) => a + b.topDecile, 0) || 1;
  const uniTotal = buckets.reduce((a, b) => a + b.universe, 0) || 1;
  const colors = ["#e8a33d", "#5aa0ff", "#2f8f45", "#c65ad1"];
  return (
    <div style={{ fontSize: 9 }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
        {title}
      </div>
      <div style={{ display: "flex", height: 12, marginTop: 3, border: "1px solid var(--chrome-border)" }}>
        {buckets.map((b, i) => (
          <div
            key={b.bucket}
            title={`${labels[b.bucket] ?? b.bucket}: ${b.topDecile} of the top decile`}
            style={{ width: `${(b.topDecile / topTotal) * 100}%`, background: colors[i % colors.length] }}
          />
        ))}
      </div>
      <div style={{ color: "var(--text-muted)", marginTop: 2 }}>
        {buckets.map((b, i) => (
          <span key={b.bucket} style={{ marginRight: 8 }}>
            <span style={{ color: colors[i % colors.length] }}>■</span> {labels[b.bucket] ?? b.bucket}:{" "}
            {((b.topDecile / topTotal) * 100).toFixed(0)}% of the top decile vs{" "}
            {((b.universe / uniTotal) * 100).toFixed(0)}% of the universe
          </span>
        ))}
      </div>
    </div>
  );
}

export function CompositionPanel({ composition }: { composition: UniversePayload["composition"] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <CompositionBar title="Top decile by company size" buckets={composition.byCap} labels={CAP_LABEL} />
      <CompositionBar title="Top decile by analyst coverage" buckets={composition.byCoverage} labels={COV_LABEL} />
    </div>
  );
}
