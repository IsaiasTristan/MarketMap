"use client";
/**
 * StockPriceChart — price chart for the per-stock detail panel.
 *
 * Ranges: 1D / 5D (live Yahoo intraday) · 1M / 6M / YTD / 1Y / 5Y / MAX
 * (stored daily adjusted closes). Default 1D.
 *
 * Interaction: click-and-drag across the chart to measure the return between
 * two points. While dragging, a floating readout shows the % change (and
 * absolute change) between the grab point and the cursor, and the selected
 * span is shaded. Mirrors the Bloomberg "drag to measure" gesture.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";
import {
  appendSparklineTail,
  mergeIntradayPoints,
} from "@/lib/holdings/merge-intraday-points";
import type {
  PriceRange,
  PriceSeriesResult,
} from "@/server/services/price-series.service";

const RANGES: PriceRange[] = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "MAX"];

const POS = "#26a269";
const NEG = "#e0533d";

interface ChartPoint {
  idx: number;
  t: string;
  price: number;
  label: string;
}

export interface StockPriceChartProps {
  ticker: string;
  /** Poll intraday ranges every 20s and append new points. */
  live?: boolean;
  /** Hide range toggles and shrink header chrome. */
  compact?: boolean;
  /** Chart body height in px. */
  height?: number;
  /** Optional sparkline tail from holdings refresh (5m closes). */
  liveTail?: number[];
  /** Omit outer card border when embedded in a modal shell. */
  embedded?: boolean;
}

function formatLabel(t: string, intraday: boolean): string {
  if (intraday) {
    const d = new Date(t);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return t; // YYYY-MM-DD
}

const fmtPrice = (v: number): string =>
  v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v: number): string => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(2)}%`;

/** Coerce Recharts' `activeTooltipIndex` (number | string | null) to a numeric index. */
function toIdx(raw: number | string | null | undefined): number | null {
  if (raw == null) return null;
  const n = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}

function toChartPoints(
  raw: { t: string; price: number }[],
  intraday: boolean,
): ChartPoint[] {
  return raw.map((p, i) => ({
    idx: i,
    t: p.t,
    price: p.price,
    label: formatLabel(p.t, intraday),
  }));
}

export function StockPriceChart({
  ticker,
  live = false,
  compact = false,
  height = 180,
  liveTail,
  embedded = false,
}: StockPriceChartProps) {
  const [range, setRange] = useState<PriceRange>("1D");
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [mergedPoints, setMergedPoints] = useState<{ t: string; price: number }[]>(
    [],
  );
  const mergedRangeRef = useRef<PriceRange | null>(null);

  useEffect(() => {
    setMergedPoints([]);
    mergedRangeRef.current = null;
    setDragStart(null);
    setDragEnd(null);
    setDragging(false);
  }, [ticker]);

  const isIntradayRange = range === "1D" || range === "5D";
  const livePolling = live && isIntradayRange;

  const { data, isLoading, error } = useQuery<PriceSeriesResult>({
    queryKey: ["price-series", ticker, range],
    queryFn: () =>
      fetch(
        `/api/analysis/securities/price-series?ticker=${encodeURIComponent(ticker)}&range=${range}`,
      ).then((r) => r.json()),
    staleTime: isIntradayRange ? 30_000 : 10 * 60_000,
    refetchInterval: livePolling ? 20_000 : false,
  });

  const intraday = data?.interval === "1m" || data?.interval === "5m";

  // Merge successive intraday fetches so the series grows forward without reset.
  useEffect(() => {
    if (!data?.points) return;
    if (!isIntradayRange) {
      setMergedPoints(data.points);
      mergedRangeRef.current = range;
      return;
    }
    if (mergedRangeRef.current !== range) {
      setMergedPoints(data.points);
      mergedRangeRef.current = range;
      return;
    }
    setMergedPoints((prev) => mergeIntradayPoints(prev, data.points));
  }, [data, isIntradayRange, range]);

  // Bridge holdings sparkline tail between full price-series polls.
  useEffect(() => {
    if (!live || !isIntradayRange || !liveTail?.length) return;
    setMergedPoints((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1]!.price;
      const tailFrom = liveTail.findIndex((p) => p !== last);
      const slice = tailFrom >= 0 ? liveTail.slice(tailFrom) : liveTail.slice(-1);
      return appendSparklineTail(prev, slice, 60_000);
    });
  }, [live, isIntradayRange, liveTail]);

  const seriesPoints = isIntradayRange ? mergedPoints : (data?.points ?? []);

  const points: ChartPoint[] = useMemo(
    () => toChartPoints(seriesPoints, !!intraday),
    [seriesPoints, intraday],
  );

  // Baseline for the header % change: 1D uses prior close when available so
  // the day's move is measured from yesterday's close, not the first tick.
  const baseline = useMemo(() => {
    if (points.length === 0) return null;
    if (range === "1D" && data?.previousClose != null) return data.previousClose;
    return points[0]!.price;
  }, [points, range, data]);

  const last = points.length ? points[points.length - 1]!.price : null;
  const headlineChange =
    last != null && baseline != null && baseline !== 0 ? (last - baseline) / baseline : null;
  const headlineAbs = last != null && baseline != null ? last - baseline : null;
  const color = (headlineChange ?? 0) >= 0 ? POS : NEG;

  // Drag selection (sorted) → measured return between the two points.
  const sel = useMemo(() => {
    if (dragStart == null || dragEnd == null || dragStart === dragEnd) return null;
    const a = Math.min(dragStart, dragEnd);
    const b = Math.max(dragStart, dragEnd);
    const pa = points[a]?.price;
    const pb = points[b]?.price;
    if (pa == null || pb == null || pa === 0) return null;
    return {
      a,
      b,
      from: points[a]!,
      to: points[b]!,
      ret: (pb - pa) / pa,
      abs: pb - pa,
    };
  }, [dragStart, dragEnd, points]);

  const yDomain = useMemo<[number, number] | undefined>(() => {
    if (points.length === 0) return undefined;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of points) {
      if (p.price < lo) lo = p.price;
      if (p.price > hi) hi = p.price;
    }
    const pad = (hi - lo) * 0.08 || hi * 0.02 || 1;
    return [lo - pad, hi + pad];
  }, [points]);

  const gradientId = `spc-${ticker}-${embedded ? "emb" : "std"}`;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: embedded ? "none" : "1px solid var(--bg-border)",
      }}
    >
      {/* Header: price + change + range toggles */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          padding: compact ? "6px 10px" : "8px 12px",
          borderBottom: "1px solid var(--bg-border)",
          flexWrap: "wrap",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            {ticker} Price
          </span>
          {last != null && (
            <span
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: compact ? 13 : 15,
                fontWeight: 600,
                color: "var(--text-primary)",
              }}
            >
              {fmtPrice(last)}
            </span>
          )}
          {headlineChange != null && headlineAbs != null && (
            <span
              style={{
                fontFamily: "var(--font-mono, monospace)",
                fontSize: compact ? 11 : 12,
                fontWeight: 600,
                color,
              }}
            >
              {headlineAbs >= 0 ? "+" : ""}
              {fmtPrice(headlineAbs)} ({fmtPct(headlineChange)})
            </span>
          )}
        </div>
        {!compact && (
          <div style={{ display: "flex", gap: 2 }}>
            {RANGES.map((r) => {
              const active = r === range;
              return (
                <button
                  key={r}
                  type="button"
                  onClick={() => {
                    setRange(r);
                    setMergedPoints([]);
                    mergedRangeRef.current = null;
                    setDragStart(null);
                    setDragEnd(null);
                    setDragging(false);
                  }}
                  style={{
                    fontSize: 10,
                    fontWeight: active ? 700 : 500,
                    padding: "2px 7px",
                    cursor: "pointer",
                    color: active ? "#0b0f17" : "var(--text-muted)",
                    background: active ? "var(--accent, #f0b65d)" : "transparent",
                    border: "1px solid",
                    borderColor: active ? "var(--accent, #f0b65d)" : "var(--bg-border)",
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {r}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Chart body */}
      <div style={{ position: "relative", padding: "6px 4px 2px" }}>
        {sel && (
          <div
            style={{
              position: "absolute",
              top: 8,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 5,
              background: "var(--bg-elevated)",
              border: `1px solid ${sel.ret >= 0 ? POS : NEG}`,
              padding: "4px 10px",
              fontSize: 11,
              fontFamily: "var(--font-mono, monospace)",
              color: "#fff",
              pointerEvents: "none",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ color: sel.ret >= 0 ? POS : NEG, fontWeight: 700 }}>
              {fmtPct(sel.ret)}
            </span>{" "}
            <span style={{ color: "var(--text-muted)" }}>
              {sel.from.label} → {sel.to.label} · {fmtPrice(sel.from.price)} →{" "}
              {fmtPrice(sel.to.price)}
            </span>
          </div>
        )}

        {isLoading && points.length === 0 ? (
          <div
            style={{
              height,
              display: "grid",
              placeItems: "center",
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            Loading {range} price…
          </div>
        ) : error || data?.error ? (
          <div
            style={{
              height,
              display: "grid",
              placeItems: "center",
              color: "var(--color-warning, #f59e0b)",
              fontSize: 11,
              textAlign: "center",
              padding: "0 16px",
            }}
          >
            {data?.error ?? "Failed to load price data."}
          </div>
        ) : points.length === 0 ? (
          <div
            style={{
              height,
              display: "grid",
              placeItems: "center",
              color: "var(--text-muted)",
              fontSize: 11,
            }}
          >
            No price data for {range}.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={height}>
            <AreaChart
              data={points}
              margin={{ top: 6, right: 8, bottom: 0, left: 0 }}
              onMouseDown={(e) => {
                const idx = toIdx(e?.activeTooltipIndex);
                if (idx == null) return;
                setDragStart(idx);
                setDragEnd(idx);
                setDragging(true);
              }}
              onMouseMove={(e) => {
                if (!dragging) return;
                const idx = toIdx(e?.activeTooltipIndex);
                if (idx == null) return;
                setDragEnd(idx);
              }}
              onMouseUp={() => setDragging(false)}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis
                dataKey="label"
                tick={{ fontSize: 9, fill: "var(--text-muted)" }}
                interval="preserveStartEnd"
                minTickGap={48}
                axisLine={{ stroke: "var(--bg-border)" }}
                tickLine={false}
              />
              <YAxis
                domain={yDomain ?? ["auto", "auto"]}
                tick={{ fontSize: 9, fill: "var(--text-muted)" }}
                width={48}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v: number) => fmtPrice(v)}
                orientation="right"
              />
              <Tooltip
                contentStyle={bbTooltipStyle}
                labelStyle={{ color: "var(--text-muted)", fontSize: 10 }}
                formatter={(v) => [fmtPrice(Number(v)), "Price"]}
              />
              {sel && (
                <ReferenceArea
                  x1={points[sel.a]!.label}
                  x2={points[sel.b]!.label}
                  fill={sel.ret >= 0 ? POS : NEG}
                  fillOpacity={0.12}
                />
              )}
              <Area
                type="monotone"
                dataKey="price"
                stroke={color}
                strokeWidth={1.4}
                fill={`url(#${gradientId})`}
                isAnimationActive={false}
                dot={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
        <div
          style={{
            fontSize: 9,
            color: "var(--text-muted)",
            padding: "2px 8px 6px",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            {data?.source === "yahoo-intraday"
              ? `Live intraday (${data.interval})`
              : "Daily adjusted close"}
          </span>
          <span>Drag across the chart to measure a return</span>
        </div>
      </div>
    </div>
  );
}
