/**
 * price-series.service — resolves a stock price chart range into a canonical
 * time series for the per-stock detail chart.
 *
 * Hybrid data sourcing (Bloomberg-style):
 *   - 1D / 5D  → live Yahoo intraday (1m / 5m). The daily PriceHistory table
 *                cannot serve an intraday curve, so these are fetched on
 *                demand and never persisted (cached briefly client-side).
 *   - 1M..MAX  → stored daily adjusted closes from PriceHistory (fast, cached,
 *                consistent with the analytics that already run on adjClose).
 *
 * The service treats a benchmark proxy ticker (e.g. ^GSPC) the same way the
 * single-point price route does, so the chart works for index rows too.
 */
import { prisma as db } from "@/infrastructure/db/client";
import { fetchYahooIntraday } from "@/infrastructure/providers/yahoo-chart-http";

export type PriceRange = "1D" | "5D" | "1M" | "6M" | "YTD" | "1Y" | "5Y" | "MAX";

export interface PricePoint {
  /** ISO datetime (intraday) or YYYY-MM-DD (daily). */
  t: string;
  /** Adjusted close (daily) or intraday close (raw). */
  price: number;
}

export interface PriceSeriesResult {
  ticker: string;
  range: PriceRange;
  interval: "1m" | "5m" | "1d";
  source: "yahoo-intraday" | "db-daily";
  points: PricePoint[];
  /** Prior close for the 1D % baseline; null for daily ranges (baseline = first point). */
  previousClose: number | null;
  /** Present when the live intraday fetch failed (UI shows a clean message). */
  error?: string;
}

const INTRADAY_RANGES = new Set<PriceRange>(["1D", "5D"]);

/** Lower bound (inclusive) for a daily range, or null for MAX (no bound). */
function rangeStartDate(range: PriceRange, now: Date): Date | null {
  const d = new Date(now);
  switch (range) {
    case "1M":
      d.setMonth(d.getMonth() - 1);
      return d;
    case "6M":
      d.setMonth(d.getMonth() - 6);
      return d;
    case "YTD":
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case "1Y":
      d.setFullYear(d.getFullYear() - 1);
      return d;
    case "5Y":
      d.setFullYear(d.getFullYear() - 5);
      return d;
    case "MAX":
      return null;
    default:
      return null;
  }
}

/**
 * Resolve a ticker to either a benchmark id or a security id (benchmarks take
 * precedence, mirroring the single-point price route).
 */
async function resolveSource(
  ticker: string,
): Promise<{ kind: "benchmark"; id: string } | { kind: "security"; id: string } | null> {
  const benchmark = await db.benchmark.findFirst({
    where: { proxyTicker: { equals: ticker, mode: "insensitive" } },
    select: { id: true },
  });
  if (benchmark) return { kind: "benchmark", id: benchmark.id };

  const security = await db.security.findUnique({
    where: { ticker },
    select: { id: true },
  });
  if (security) return { kind: "security", id: security.id };
  return null;
}

export async function getPriceSeries(
  tickerRaw: string,
  range: PriceRange,
): Promise<PriceSeriesResult | null> {
  const ticker = tickerRaw.trim().toUpperCase();
  if (!ticker) return null;

  // --- Intraday (live) -----------------------------------------------------
  if (INTRADAY_RANGES.has(range)) {
    const interval: "1m" | "5m" = range === "1D" ? "1m" : "5m";
    const res = await fetchYahooIntraday(ticker, range === "1D" ? "1d" : "5d");
    if (res.kind !== "ok") {
      return {
        ticker,
        range,
        interval,
        source: "yahoo-intraday",
        points: [],
        previousClose: null,
        error:
          res.kind === "throttled"
            ? "Intraday data temporarily unavailable (rate limited). Try again shortly."
            : "Intraday data unavailable for this symbol.",
      };
    }
    return {
      ticker,
      range,
      interval,
      source: "yahoo-intraday",
      points: res.points.map((p) => ({ t: p.t, price: p.price })),
      previousClose: res.previousClose,
    };
  }

  // --- Daily (stored) ------------------------------------------------------
  const source = await resolveSource(ticker);
  if (!source) return null;

  const now = new Date();
  const start = rangeStartDate(range, now);

  let rows: { tradeDate: Date; adjClose: unknown }[];
  if (source.kind === "benchmark") {
    rows = await db.benchmarkPriceHistory.findMany({
      where: {
        benchmarkId: source.id,
        ...(start ? { tradeDate: { gte: start } } : {}),
      },
      orderBy: { tradeDate: "asc" },
      select: { tradeDate: true, adjClose: true },
    });
  } else {
    rows = await db.priceHistory.findMany({
      where: {
        securityId: source.id,
        ...(start ? { tradeDate: { gte: start } } : {}),
      },
      orderBy: { tradeDate: "asc" },
      select: { tradeDate: true, adjClose: true },
    });
  }

  const points: PricePoint[] = rows.map((r) => ({
    t: r.tradeDate.toISOString().slice(0, 10),
    price: Number(r.adjClose),
  }));

  return {
    ticker,
    range,
    interval: "1d",
    source: "db-daily",
    points,
    previousClose: null,
  };
}
