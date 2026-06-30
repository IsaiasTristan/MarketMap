"use client";

import { useMemo } from "react";
import {
  Area,
  ComposedChart,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { fmtPrice, fmtPct } from "@/components/analysis/overview/formatters";
import {
  extendedSessionFractionToEtLabel,
  timestampToExtendedSessionFraction,
} from "@/lib/market/sparkline-session-layout";
import type { TodaySessionPoint } from "@/lib/holdings/intraday-split";

const POS = "#26a269";
const NEG = "#e0533d";

// Chart layout (px). The split gradient is anchored to the plot area in user
// space (not each path's bounding box), so the green/red prior-close split lands
// at the true `prevClose` pixel. Keep these in sync with the chart props below.
const CHART_HEIGHT = 120;
const MARGIN_TOP = 14;
const MARGIN_BOTTOM = 0;
const X_AXIS_HEIGHT = 16;
const PLOT_TOP = MARGIN_TOP;
const PLOT_BOTTOM = CHART_HEIGHT - MARGIN_BOTTOM - X_AXIS_HEIGHT;

export interface LivePriceChartTileProps {
  ticker: string;
  /** Today's pre -> regular -> post timestamped intraday series. */
  intradayPoints: TodaySessionPoint[];
  prevClose: number;
  currentPrice: number;
  chg1dPct: number;
  onClick: () => void;
}

interface TilePoint {
  sessionX: number;
  regular: number | null;
  extended: number | null;
}

/**
 * Map today's session points onto the extended ET time axis (pre-market is
 * negative, regular is [0, 1], post-market is > 1). A regular bar adjacent to
 * an extended bar also carries the extended value so the gray pre/post segments
 * visually connect to the colored regular line instead of floating away.
 */
function buildTilePoints(points: TodaySessionPoint[]): TilePoint[] {
  return points.map((p, i) => {
    const isExt = p.session === "extended";
    const adjacentToExt =
      points[i - 1]?.session === "extended" ||
      points[i + 1]?.session === "extended";
    return {
      sessionX: timestampToExtendedSessionFraction(p.t),
      regular: isExt ? null : p.price,
      extended: isExt ? p.price : adjacentToExt ? p.price : null,
    };
  });
}

export function LivePriceChartTile({
  ticker,
  intradayPoints,
  prevClose,
  currentPrice,
  chg1dPct,
  onClick,
}: LivePriceChartTileProps) {
  const points = useMemo(
    () => buildTilePoints(intradayPoints),
    [intradayPoints],
  );

  const last = currentPrice;
  const headlineAbs = prevClose > 0 ? last - prevClose : 0;
  const color = chg1dPct >= 0 ? POS : NEG;

  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (points.length === 0) return undefined;
    const vals = points.flatMap((p) =>
      [p.regular, p.extended].filter((v): v is number => v != null),
    );
    if (prevClose > 0) vals.push(prevClose);
    if (vals.length === 0) return undefined;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;
    return [lo - pad, hi + pad];
  }, [points, prevClose]);

  // X domain across the full pre/regular/post day, anchored on the regular
  // [0, 1] window and stretched to whatever pre/post data exists.
  const xDomain = useMemo<[number, number]>(() => {
    let lo = 0;
    let hi = 1;
    for (const p of points) {
      if (p.sessionX < lo) lo = p.sessionX;
      if (p.sessionX > hi) hi = p.sessionX;
    }
    return [lo, hi];
  }, [points]);

  const splitOffset = useMemo<number | null>(() => {
    if (!(prevClose > 0) || !yDomain) return null;
    const [lo, hi] = yDomain;
    if (hi === lo) return null;
    return Math.min(1, Math.max(0, (hi - prevClose) / (hi - lo)));
  }, [prevClose, yDomain]);

  const fillGradId = `tile-${ticker}`;
  const strokeGradId = `tile-stroke-${ticker}`;

  const hasRenderable = points.length >= 2;
  const hasExtended = useMemo(
    () => points.some((p) => p.extended != null),
    [points],
  );

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        cursor: "pointer",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
        transition: "border-color 0.15s",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = "var(--color-accent)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = "var(--bg-border)";
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: 8,
          padding: "6px 10px",
          borderBottom: "1px solid var(--bg-border)",
          flexWrap: "wrap",
        }}
      >
        <span
          style={{
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: "0.08em",
            textTransform: "uppercase",
            color: "var(--text-muted)",
          }}
        >
          {ticker} Price
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 13,
            fontWeight: 600,
            color: "var(--text-primary)",
          }}
        >
          {fmtPrice(last)}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono, monospace)",
            fontSize: 11,
            fontWeight: 600,
            color,
          }}
        >
          {headlineAbs >= 0 ? "+" : ""}
          {fmtPrice(headlineAbs)} ({fmtPct(chg1dPct)})
        </span>
      </div>

      <div style={{ padding: "4px 2px 0", flex: 1, minHeight: 120 }}>
        {!hasRenderable ? (
          <div
            style={{
              height: 120,
              display: "grid",
              placeItems: "center",
              color: "var(--text-muted)",
              fontSize: 10,
            }}
          >
            No intraday data
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
            <ComposedChart
              data={points}
              margin={{ top: MARGIN_TOP, right: 4, bottom: MARGIN_BOTTOM, left: 0 }}
            >
              <defs>
                {splitOffset != null ? (
                  <>
                    {/* Fill: green above the prior close, red below. Anchored to
                        the plot area in user space so the split is at prevClose. */}
                    <linearGradient
                      id={fillGradId}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      x2="0"
                      y1={PLOT_TOP}
                      y2={PLOT_BOTTOM}
                    >
                      <stop offset="0%" stopColor={POS} stopOpacity={0.28} />
                      <stop offset={`${splitOffset * 100}%`} stopColor={POS} stopOpacity={0.04} />
                      <stop offset={`${splitOffset * 100}%`} stopColor={NEG} stopOpacity={0.04} />
                      <stop offset="100%" stopColor={NEG} stopOpacity={0.28} />
                    </linearGradient>
                    {/* Stroke: hard green/red split at the prior close. */}
                    <linearGradient
                      id={strokeGradId}
                      gradientUnits="userSpaceOnUse"
                      x1="0"
                      x2="0"
                      y1={PLOT_TOP}
                      y2={PLOT_BOTTOM}
                    >
                      <stop offset="0%" stopColor={POS} />
                      <stop offset={`${splitOffset * 100}%`} stopColor={POS} />
                      <stop offset={`${splitOffset * 100}%`} stopColor={NEG} />
                      <stop offset="100%" stopColor={NEG} />
                    </linearGradient>
                  </>
                ) : (
                  <linearGradient id={fillGradId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                    <stop offset="100%" stopColor={color} stopOpacity={0} />
                  </linearGradient>
                )}
              </defs>
              <XAxis
                type="number"
                dataKey="sessionX"
                domain={xDomain}
                ticks={xDomain}
                tickFormatter={(v: number) => extendedSessionFractionToEtLabel(v)}
                tick={{ fontSize: 7, fill: "var(--text-muted)" }}
                axisLine={{ stroke: "var(--bg-border)" }}
                tickLine={false}
                height={X_AXIS_HEIGHT}
              />
              <YAxis domain={yDomain ?? ["auto", "auto"]} hide width={0} />
              {prevClose > 0 && (
                <ReferenceLine
                  y={prevClose}
                  stroke="var(--text-muted)"
                  strokeDasharray="4 4"
                  strokeWidth={1}
                  label={{
                    value: `Prev ${fmtPrice(prevClose)}`,
                    position: "insideTopLeft",
                    fill: "var(--text-muted)",
                    fontSize: 7,
                  }}
                />
              )}
              <Area
                type="monotone"
                dataKey="regular"
                stroke={splitOffset != null ? `url(#${strokeGradId})` : color}
                strokeWidth={1.2}
                fill={`url(#${fillGradId})`}
                connectNulls={false}
                isAnimationActive={false}
                dot={false}
              />
              {hasExtended && (
                <Area
                  type="monotone"
                  dataKey="extended"
                  stroke="var(--text-muted)"
                  strokeWidth={1}
                  fill="none"
                  connectNulls={false}
                  isAnimationActive={false}
                  dot={false}
                />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <div
        style={{
          fontSize: 8,
          color: "var(--text-muted)",
          padding: "2px 8px 6px",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>Pre / regular / after-hours</span>
        <span>Click to expand</span>
      </div>
    </div>
  );
}
