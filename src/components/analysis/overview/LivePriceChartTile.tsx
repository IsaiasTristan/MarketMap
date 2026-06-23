"use client";

import { useMemo } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { fmtPrice, fmtPct } from "@/components/analysis/overview/formatters";
import {
  computeTodayOnlyLayout,
  mapSeriesToX,
  sessionFractionToEtLabel,
} from "@/lib/market/sparkline-session-layout";
import { useSessionClock } from "@/lib/market/use-session-clock";
import { getUsMarketSession } from "@/lib/market-map/market-session";

const POS = "#26a269";
const NEG = "#e0533d";

export interface LivePriceChartTileProps {
  ticker: string;
  sparkline: number[];
  sparklineExtended?: number[];
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

function buildSessionTilePoints(
  sparkline: number[],
  sparklineExtended: number[],
  now: Date,
): TilePoint[] {
  const regular = sparkline.length >= 2 ? sparkline : [];
  const extended = sparklineExtended ?? [];

  const layout = computeTodayOnlyLayout({
    hasToday: regular.length >= 2,
    hasExtended: extended.length >= 2,
    now,
    clockSession: getUsMarketSession(now),
  });

  const [tStart, tEnd] = layout.todayXRange;
  const out: TilePoint[] = regular.map((price, i) => ({
    sessionX: mapSeriesToX(i, regular.length, tStart, tEnd),
    regular: price,
    extended: null,
  }));

  const extRange = layout.extendedXRange;
  if (extRange && extended.length >= 2) {
    for (let i = 0; i < extended.length; i++) {
      out.push({
        sessionX: mapSeriesToX(i, extended.length, extRange[0], extRange[1]),
        regular: null,
        extended: extended[i]!,
      });
    }
  }

  if (out.length === 0 && extended.length >= 2 && extRange) {
    return extended.map((price, i) => ({
      sessionX: mapSeriesToX(i, extended.length, extRange[0], extRange[1]),
      regular: null,
      extended: price,
    }));
  }

  return out.sort((a, b) => a.sessionX - b.sessionX);
}

export function LivePriceChartTile({
  ticker,
  sparkline,
  sparklineExtended = [],
  prevClose,
  currentPrice,
  chg1dPct,
  onClick,
}: LivePriceChartTileProps) {
  const now = useSessionClock(20_000);

  const points = useMemo(
    () => buildSessionTilePoints(sparkline, sparklineExtended, now),
    [sparkline, sparklineExtended, now],
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
    let lo = Math.min(...vals);
    let hi = Math.max(...vals);
    const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;
    return [lo - pad, hi + pad];
  }, [points, prevClose]);

  const hasRenderable = points.length >= 2;

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
          <ResponsiveContainer width="100%" height={120}>
            <ComposedChart
              data={points}
              margin={{ top: 14, right: 4, bottom: 0, left: 0 }}
            >
              <defs>
                <linearGradient id={`tile-${ticker}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                type="number"
                dataKey="sessionX"
                domain={[0, 1]}
                ticks={[0, 1]}
                tickFormatter={(v: number) => sessionFractionToEtLabel(v)}
                tick={{ fontSize: 7, fill: "var(--text-muted)" }}
                axisLine={{ stroke: "var(--bg-border)" }}
                tickLine={false}
                height={16}
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
                stroke={color}
                strokeWidth={1.2}
                fill={`url(#tile-${ticker})`}
                connectNulls={false}
                isAnimationActive={false}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="extended"
                stroke="var(--text-muted)"
                strokeWidth={1}
                strokeDasharray="3 3"
                connectNulls
                isAnimationActive={false}
                dot={false}
              />
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
        <span>Live intraday (5m)</span>
        <span>Click to expand</span>
      </div>
    </div>
  );
}
