"use client";

import { useQuery } from "@tanstack/react-query";
import { SessionSeamSparkline } from "@/components/analysis/ui/SessionSeamSparkline";
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

function Chip({ quote, "aria-hidden": ariaHidden }: { quote: MarketStripQuote; "aria-hidden"?: boolean }) {
  const positive = (quote.change ?? 0) >= 0;
  const color = quote.change == null
    ? "var(--text-muted)"
    : positive
      ? "var(--color-positive)"
      : "var(--color-negative)";

  const priceText = quote.kind === "yield"
    ? `${formatPrice(quote.price, quote.decimals)}%`
    : formatPrice(quote.price, quote.decimals);

  const changeText = quote.kind === "yield"
    ? formatSignedBp(quote.changeBp)
    : formatSignedDollar(quote.change, quote.decimals);

  return (
    <div
      aria-hidden={ariaHidden}
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
      <SessionSeamSparkline
        priorSeries={quote.prevDaySparkline}
        todaySeries={quote.sparkline}
        extendedSeries={quote.extendedSparkline}
        prevClose={quote.prevClose}
        timeMode={quote.timeMode}
        width={SPARK_WIDTH}
        height={SPARK_HEIGHT}
      />
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
        overflow: "hidden",
      }}
    >
      {quotes.length === 0 ? (
        <span style={{ fontSize: 10, color: "var(--text-muted)", padding: "0 8px" }}>
          Loading market data…
        </span>
      ) : (
        <div className="bb-ticker-track">
          {quotes.map((q) => <Chip key={q.symbol} quote={q} />)}
          {quotes.map((q) => (
            <Chip key={`dup-${q.symbol}`} quote={q} aria-hidden />
          ))}
        </div>
      )}
    </div>
  );
}
