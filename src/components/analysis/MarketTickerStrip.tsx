"use client";

import { useQuery } from "@tanstack/react-query";
import type { MarketStripQuote } from "@/server/services/market-strip.service";

function formatPrice(value: number | null, decimals: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function formatSignedDollar(value: number | null, decimals: number): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })}`;
}

function formatSignedPct(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${(Math.abs(value) * 100).toFixed(2)}%`;
}

function formatSignedBp(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "−";
  return `${sign}${Math.abs(value).toFixed(1)} bp`;
}

const SPARK_WIDTH = 60;
const SPARK_HEIGHT = 18;

/**
 * Inline bicolor area sparkline. Renders the intraday price path with the
 * area between the line and the prev-close baseline filled green where the
 * price sits above prev close and red where it sits below.
 *
 * Technique: build a single closed area polygon from the data, then draw it
 * twice — once clipped to a rectangle ABOVE the baseline (green fill) and
 * once clipped to a rectangle BELOW the baseline (red fill). SVG clipPath
 * does the per-pixel split for free, so we never have to compute zero
 * crossings against prev close.
 *
 * The y-scale is intentionally padded to include the prev-close baseline in
 * its range even on a clean all-up or all-down day, so the baseline is always
 * visible at a sensible vertical position inside the box.
 */
function Sparkline({
  series,
  prevClose,
}: {
  series: number[];
  prevClose: number | null;
}) {
  if (series.length < 2 || prevClose == null || !Number.isFinite(prevClose)) {
    return (
      <svg
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
        style={{ flexShrink: 0, display: "block" }}
        aria-hidden
      >
        <line
          x1={0}
          x2={SPARK_WIDTH}
          y1={SPARK_HEIGHT / 2}
          y2={SPARK_HEIGHT / 2}
          stroke="var(--chrome-border)"
          strokeDasharray="2 2"
          strokeWidth={1}
        />
      </svg>
    );
  }

  // Build a vertical range that always contains the prev-close baseline plus
  // a small padding band so the line doesn't kiss the top/bottom edges. Pure
  // data min/max would push prevClose out of the box on a one-sided day and
  // hide the threshold — defeating the bicolor effect.
  let dataMin = Math.min(...series, prevClose);
  let dataMax = Math.max(...series, prevClose);
  if (dataMin === dataMax) {
    dataMin -= 1;
    dataMax += 1;
  }
  const span = dataMax - dataMin;
  const pad = span * 0.1;
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;

  const toX = (i: number) =>
    series.length === 1 ? SPARK_WIDTH / 2 : (i / (series.length - 1)) * SPARK_WIDTH;
  const toY = (v: number) =>
    SPARK_HEIGHT - ((v - yMin) / (yMax - yMin)) * SPARK_HEIGHT;

  const baselineY = toY(prevClose);

  // Closed polygon: x0 anchor on the baseline -> walk the price line ->
  // back down to the baseline at the last x. Same polygon is drawn twice
  // (clipped above for green, clipped below for red).
  const pts = series.map((v, i) => `${toX(i).toFixed(2)},${toY(v).toFixed(2)}`);
  const areaPath = `M${toX(0).toFixed(2)},${baselineY.toFixed(2)} L${pts.join(
    " L",
  )} L${toX(series.length - 1).toFixed(2)},${baselineY.toFixed(2)} Z`;
  const linePath = `M${pts.join(" L")}`;

  // Unique-enough clipPath IDs per render: we have at most ~12 sparklines on
  // screen, and React reuses them across refreshes via key stability, so a
  // counter scoped to module load is fine. Math.random would be cheaper to
  // reason about but causes hydration mismatches; use the series fingerprint.
  const uid = `${series.length}-${baselineY.toFixed(0)}`;

  return (
    <svg
      width={SPARK_WIDTH}
      height={SPARK_HEIGHT}
      style={{ flexShrink: 0, display: "block" }}
      aria-hidden
    >
      <defs>
        <clipPath id={`spark-above-${uid}`}>
          <rect x={0} y={0} width={SPARK_WIDTH} height={baselineY} />
        </clipPath>
        <clipPath id={`spark-below-${uid}`}>
          <rect
            x={0}
            y={baselineY}
            width={SPARK_WIDTH}
            height={Math.max(0, SPARK_HEIGHT - baselineY)}
          />
        </clipPath>
      </defs>
      <path
        d={areaPath}
        fill="var(--color-positive)"
        fillOpacity={0.45}
        clipPath={`url(#spark-above-${uid})`}
      />
      <path
        d={areaPath}
        fill="var(--color-negative)"
        fillOpacity={0.45}
        clipPath={`url(#spark-below-${uid})`}
      />
      <line
        x1={0}
        x2={SPARK_WIDTH}
        y1={baselineY}
        y2={baselineY}
        stroke="var(--text-muted)"
        strokeDasharray="2 2"
        strokeWidth={0.75}
        opacity={0.6}
      />
      <path
        d={linePath}
        fill="none"
        stroke="var(--text-secondary)"
        strokeWidth={1}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Chip({ quote }: { quote: MarketStripQuote }) {
  const positive = (quote.change ?? 0) >= 0;
  const color = quote.change == null
    ? "var(--text-muted)"
    : positive
      ? "var(--color-positive)"
      : "var(--color-negative)";

  // Yields show their level with a `%` suffix (e.g. 4.25%); everything else
  // shows the price formatted to its instrument-specific decimals.
  const priceText = quote.kind === "yield"
    ? `${formatPrice(quote.price, quote.decimals)}%`
    : formatPrice(quote.price, quote.decimals);

  // For yields the day-over-day move is shown in basis points; for price
  // instruments it's the dollar (or native-unit) move at the same precision
  // as the price itself.
  const changeText = quote.kind === "yield"
    ? formatSignedBp(quote.changeBp)
    : formatSignedDollar(quote.change, quote.decimals);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "0 8px",
        borderRight: "1px solid var(--chrome-border)",
        whiteSpace: "nowrap",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          fontSize: 10,
          fontWeight: 700,
          color: "var(--text-secondary)",
          letterSpacing: 0.3,
        }}
      >
        {quote.label}
      </span>
      <span className="bb-num" style={{ fontSize: 11, fontWeight: 700 }}>
        {priceText}
      </span>
      <span
        className="bb-num"
        style={{ fontSize: 10, color, fontWeight: 600 }}
      >
        {changeText}
      </span>
      <span
        className="bb-num"
        style={{ fontSize: 10, color }}
      >
        ({formatSignedPct(quote.changePct)})
      </span>
      <Sparkline series={quote.sparkline} prevClose={quote.prevClose} />
    </div>
  );
}

export function MarketTickerStrip() {
  const { data } = useQuery<{ quotes: MarketStripQuote[] } | null>({
    queryKey: ["market-strip"],
    queryFn: async () => {
      const r = await fetch("/api/market/strip");
      if (!r.ok) return null;
      return (await r.json()) as { quotes: MarketStripQuote[] };
    },
    refetchInterval: 60_000,
    staleTime: 60_000,
  });

  const quotes = data?.quotes ?? [];

  return (
    <div
      style={{
        flexShrink: 0,
        position: "sticky",
        top: 26,
        zIndex: 9,
        background: "var(--bg-base)",
        borderBottom: "1px solid var(--chrome-border)",
        minHeight: 24,
        display: "flex",
        alignItems: "center",
        overflowX: "auto",
        WebkitOverflowScrolling: "touch",
      }}
    >
      {quotes.length === 0 ? (
        <span style={{ fontSize: 10, color: "var(--text-muted)", padding: "0 8px" }}>
          Loading market data…
        </span>
      ) : (
        quotes.map((q) => <Chip key={q.symbol} quote={q} />)
      )}
    </div>
  );
}
