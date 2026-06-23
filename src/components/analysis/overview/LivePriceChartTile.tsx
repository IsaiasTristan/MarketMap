"use client";

import { useMemo } from "react";
import {
  Area,
  ComposedChart,
  Line,
  ResponsiveContainer,
  XAxis,
  YAxis,
} from "recharts";
import { fmtPrice, fmtPct } from "@/components/analysis/overview/formatters";

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
  idx: number;
  regular: number | null;
  extended: number | null;
}

function buildTilePoints(
  sparkline: number[],
  sparklineExtended: number[],
): TilePoint[] {
  const regular = sparkline.length >= 2 ? sparkline : [];
  const extended = sparklineExtended ?? [];
  const out: TilePoint[] = regular.map((price, idx) => ({
    idx,
    regular: price,
    extended: null,
  }));
  const base = out.length;
  for (let i = 0; i < extended.length; i++) {
    out.push({
      idx: base + i,
      regular: null,
      extended: extended[i]!,
    });
  }
  if (out.length === 0 && extended.length >= 2) {
    return extended.map((price, idx) => ({
      idx,
      regular: null,
      extended: price,
    }));
  }
  return out;
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
  const points = useMemo(
    () => buildTilePoints(sparkline, sparklineExtended),
    [sparkline, sparklineExtended],
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
            <ComposedChart data={points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id={`tile-${ticker}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="idx" hide />
              <YAxis domain={yDomain ?? ["auto", "auto"]} hide width={0} />
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
