import type { PrismaClient } from "@prisma/client";
import type { BenchmarkCode, MetricKind, RowLevel } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";
import type { DateClose } from "@/domain/calculations/alignment";
import { securityHorizonMetrics } from "@/domain/calculations/security-metrics";
import { riskFreeAnnual } from "@/infrastructure/config/env";
import type { ExtendedTickerQuote } from "@/server/services/extended-hours.service";
import type { LiveRegularQuote } from "@/server/services/live-regular.service";

function dec(x: { toString(): string }): number {
  return Number(x.toString());
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Most recent bars retained per security (covers the 1Y horizon ~252 td). */
const RECENT_BARS = 320;
/**
 * Calendar-day lookback for the batched price load. ~600 days comfortably
 * exceeds the 320 trading bars we keep (≈410 trading days), with margin for
 * weekends/holidays. Bounding the query by date keeps the single findMany
 * from scanning the full multi-year price history.
 */
const PRICE_LOOKBACK_DAYS = 600;

/**
 * Batch-load recent prices for many securities in ONE query, grouped by
 * securityId and trimmed to the most recent {@link RECENT_BARS} bars each.
 *
 * Replaces the previous per-ticker loop that issued one DB round-trip per
 * constituent (~1,220 sequential queries on the full universe). Mirrors the
 * single-query pattern used by factor-per-stock.service.
 */
export async function loadRecentPricesBatch(
  db: PrismaClient,
  securityIds: string[]
): Promise<Map<string, DateClose[]>> {
  const out = new Map<string, DateClose[]>();
  if (securityIds.length === 0) return out;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - PRICE_LOOKBACK_DAYS);

  const rows = await db.priceHistory.findMany({
    where: { securityId: { in: securityIds }, tradeDate: { gte: cutoff } },
    orderBy: { tradeDate: "asc" },
    select: { securityId: true, tradeDate: true, adjClose: true },
  });

  for (const r of rows) {
    let arr = out.get(r.securityId);
    if (!arr) {
      arr = [];
      out.set(r.securityId, arr);
    }
    arr.push({ date: iso(r.tradeDate), adjClose: dec(r.adjClose) });
  }
  // Rows are ascending; keep only the most recent RECENT_BARS per security.
  for (const [id, arr] of out) {
    if (arr.length > RECENT_BARS) out.set(id, arr.slice(-RECENT_BARS));
  }
  return out;
}

export async function loadBenchmarkSeries(
  db: PrismaClient,
  code: BenchmarkCode
): Promise<DateClose[]> {
  const b = await db.benchmark.findUnique({ where: { code } });
  if (!b) return [];
  const rows = await db.benchmarkPriceHistory.findMany({
    where: { benchmarkId: b.id },
    orderBy: { tradeDate: "desc" },
    take: 320,
  });
  return rows
    .reverse()
    .map((p) => ({ date: iso(p.tradeDate), adjClose: dec(p.adjClose) }));
}

type CompanyRow = {
  ticker: string;
  name: string;
  sector: string;
  subTheme: string;
  lastDate: string | null;
  metrics: ReturnType<typeof securityHorizonMetrics>;
  d1Source?: "AH" | "REGULAR";
};

function pickMetric(
  m: ReturnType<typeof securityHorizonMetrics>,
  h: Horizon,
  metric: MetricKind
): number | null {
  const cell = m[h];
  if (!cell) return null;
  switch (metric) {
    case "RETURN":
      return cell.return;
    case "EXCESS_RETURN":
      return cell.excessReturn;
    case "VOLATILITY":
      return cell.volatility;
    case "SHARPE":
      return cell.sharpe;
    default:
      return null;
  }
}

function averageNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export type MarketMapApiRow = {
  key: string;
  label: string;
  sector?: string;
  subTheme?: string;
  ticker?: string;
  cells: Record<Horizon, number | null>;
  /** Last trade-date represented in this row's underlying series (COMPANY only). */
  lastDate?: string | null;
  /**
   * How the D1 RETURN cell was sourced when an extended-hours overlay is
   * applied (COMPANY only): `"AH"` = a genuine after-hours print, `"REGULAR"`
   * = fell back to the regular close-to-close move because the stock had no
   * after-hours trade. Undefined on non-overlay rows. Lets the grid render the
   * regular-fallback values with reduced emphasis so the after-hours 1D column
   * stays honest instead of showing a blank cell.
   */
  d1Source?: "AH" | "REGULAR";
};

/**
 * Health counters surfaced alongside the grid so a real data gap is visible
 * (logged + chip in the UI) rather than appearing as a silent dash.
 */
export type MarketMapDiagnostics = {
  /** Constituents skipped because they had fewer than 5 price bars. */
  excludedInsufficientPrices: number;
  /** Rendered rows whose every horizon cell is null for the requested metric. */
  allNullRows: number;
  /**
   * D1 cells that fell back to the regular close move because the after-hours
   * overlay had no genuine AH print. Expected/benign overnight — not a fault.
   */
  d1FallbackToRegular: number;
};

/** Calendar days between two yyyy-MM-dd strings (exclusive of start, inclusive span). */
function calendarDaysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(`${startIso}T12:00:00Z`);
  const end = Date.parse(`${endIso}T12:00:00Z`);
  return Math.round((end - start) / 86_400_000);
}

export type ExtendedOverlayResult = {
  series: DateClose[];
  applied: boolean;
  ahOnly1D: number | null;
  skipReason?: "empty" | "bad_price" | "future_bar" | "stale_db";
};

/**
 * After-hours-only 1D: POST uses extended price vs regular close; PRE uses
 * extended price vs the last stored close before the print date.
 */
export function computeAhOnly1DReturn(
  quote: ExtendedTickerQuote,
  priorDbClose: number | null,
): number | null {
  if (
    quote.session === "POST" &&
    quote.regularClose != null &&
    quote.regularClose > 0 &&
    Number.isFinite(quote.regularClose)
  ) {
    return quote.price / quote.regularClose - 1;
  }
  if (
    quote.session === "PRE" &&
    priorDbClose != null &&
    priorDbClose > 0 &&
    Number.isFinite(priorDbClose)
  ) {
    return quote.price / priorDbClose - 1;
  }
  return null;
}

/**
 * Anchor extended-hours overlay on the print's ET trade date (not wall clock).
 * Skips overlay when the DB series lags the print by more than one trading
 * day (Fri→Mon gap = 3 calendar days is allowed).
 */
export function applyExtendedQuoteOverlay(
  series: DateClose[],
  quote: ExtendedTickerQuote,
): ExtendedOverlayResult {
  const skip = (
    s: DateClose[],
    reason: ExtendedOverlayResult["skipReason"],
  ): ExtendedOverlayResult => ({
    series: s,
    applied: false,
    ahOnly1D: null,
    skipReason: reason,
  });

  if (series.length === 0) return skip(series, "empty");
  if (!Number.isFinite(quote.price)) return skip(series, "bad_price");

  const { tradeDateEt, price } = quote;
  const last = series[series.length - 1]!;
  const priorDbClose = last.adjClose;

  if (last.date > tradeDateEt) return skip(series, "future_bar");

  if (last.date === tradeDateEt) {
    const out = series.slice(0, -1);
    out.push({ date: tradeDateEt, adjClose: price });
    return {
      series: out,
      applied: true,
      ahOnly1D: computeAhOnly1DReturn(quote, priorDbClose),
    };
  }

  const gapDays = calendarDaysBetween(last.date, tradeDateEt);
  if (gapDays > 3) return skip(series, "stale_db");

  const out = [...series, { date: tradeDateEt, adjClose: price }];
  return {
    series: out,
    applied: true,
    ahOnly1D: computeAhOnly1DReturn(quote, priorDbClose),
  };
}

export type LiveOverlayMode = "live" | "frozen";

export type LiveOverlayResult = {
  series: DateClose[];
  applied: boolean;
  skipReason?: "empty" | "bad_price" | "future_bar" | "stale_db" | "frozen_noop";
};

/**
 * Overlay today's regular-session live price onto the daily close series,
 * anchored on the quote's ET trade date (never wall-clock "now"). Unlike the
 * extended-hours overlay this keeps the close-to-close chain intact — the
 * appended/replaced bar is just today's price, so `securityHorizonMetrics`
 * recomputes every horizon naturally (D1 = price / prior close).
 *
 *   - `mode: "live"`   (REGULAR): a same-day bar is REPLACED so the live price
 *     supersedes any partial bar a `mode=missing` ingest wrote for a freshly
 *     seeded ticker, keeping the grid consistent across tickers.
 *   - `mode: "frozen"` (after close): a same-day bar is a NO-OP so the official
 *     EOD close, once written to PriceHistory, always wins over the frozen
 *     regular print.
 *
 * Both modes APPEND when the DB series lags the trade date by <= 3 calendar
 * days (Fri->Mon weekend gap allowed) and SKIP a larger gap (stale) or a DB
 * bar dated after the print (future_bar).
 */
export function applyLiveRegularOverlay(
  series: DateClose[],
  quote: LiveRegularQuote,
  mode: LiveOverlayMode,
): LiveOverlayResult {
  const skip = (
    s: DateClose[],
    reason: LiveOverlayResult["skipReason"],
  ): LiveOverlayResult => ({ series: s, applied: false, skipReason: reason });

  if (series.length === 0) return skip(series, "empty");
  if (!Number.isFinite(quote.price)) return skip(series, "bad_price");

  const { tradeDateEt, price } = quote;
  const last = series[series.length - 1]!;

  if (last.date > tradeDateEt) return skip(series, "future_bar");

  if (last.date === tradeDateEt) {
    if (mode === "frozen") return skip(series, "frozen_noop");
    const out = series.slice(0, -1);
    out.push({ date: tradeDateEt, adjClose: price });
    return { series: out, applied: true };
  }

  const gapDays = calendarDaysBetween(last.date, tradeDateEt);
  if (gapDays > 3) return skip(series, "stale_db");

  const out = [...series, { date: tradeDateEt, adjClose: price }];
  return { series: out, applied: true };
}

/**
 * Authoritative regular-session 1D return for a live quote = `price /
 * prevClose - 1`. Returned only in `"live"` mode with a finite price and a
 * positive finite `prevClose`; otherwise `null` (caller keeps the
 * close-to-close chain). Anchoring 1D here keeps it correct even when the
 * stored series is missing the prior trading day (e.g. Friday not yet ingested
 * on Monday morning), which would otherwise make the chained 1D a multi-day
 * move. `"frozen"` (after close) returns `null` so the official EOD close wins.
 */
export function liveRegular1D(
  quote: LiveRegularQuote,
  mode: LiveOverlayMode,
): number | null {
  if (mode !== "live") return null;
  if (!Number.isFinite(quote.price)) return null;
  if (!Number.isFinite(quote.prevClose) || quote.prevClose <= 0) return null;
  return quote.price / quote.prevClose - 1;
}

/**
 * @deprecated Use {@link applyExtendedQuoteOverlay} — kept for unit tests.
 */
export function applyExtendedOverlay(
  series: DateClose[],
  price: number,
  todayIso: string,
): DateClose[] {
  if (series.length === 0) return series;
  if (!Number.isFinite(price)) return series;
  const last = series[series.length - 1]!;
  if (last.date === todayIso) {
    const out = series.slice(0, -1);
    out.push({ date: todayIso, adjClose: price });
    return out;
  }
  if (last.date > todayIso) return series;
  return [...series, { date: todayIso, adjClose: price }];
}

export interface ComputeMarketMapOptions {
  /** Optional ticker -> extended-hours quote overlay (PRE / POST sessions). */
  extendedQuotes?: Map<string, ExtendedTickerQuote>;
  /** Optional ticker -> live regular-session quote overlay. Mutually exclusive
   *  with `extendedQuotes` (the route never passes both). */
  liveQuotes?: Map<string, LiveRegularQuote>;
  /** Overlay mode for `liveQuotes` — `"live"` during REGULAR (replace a
   *  same-day bar), `"frozen"` after close (no-op on a same-day bar so the
   *  official EOD close wins). Defaults to `"live"`. */
  liveMode?: LiveOverlayMode;
}

export async function computeMarketMap(
  db: PrismaClient,
  universeId: string,
  metric: MetricKind,
  rowLevel: RowLevel,
  benchmark: BenchmarkCode,
  filters: { sector?: string; subTheme?: string },
  options: ComputeMarketMapOptions = {}
): Promise<{
  rows: MarketMapApiRow[];
  asOf: string | null;
  warnings: string[];
  diagnostics: MarketMapDiagnostics;
}> {
  const warnings: string[] = [];
  const rf = riskFreeAnnual();

  const constituents = await db.universeConstituent.findMany({
    where: {
      universeId,
      // Skip user-deactivated tickers (delisted / acquired / renamed). They
      // remain in the universe in case the user wants to reactivate, but the
      // grid never tries to render or price them.
      security: { isActive: true },
      ...(filters.sector ? { sector: filters.sector } : {}),
      ...(filters.subTheme ? { subTheme: filters.subTheme } : {}),
    },
    include: { security: true },
    orderBy: { sortOrder: "asc" },
  });

  if (constituents.length === 0) {
    return {
      rows: [],
      asOf: null,
      warnings: ["No constituents in this universe."],
      diagnostics: {
        excludedInsufficientPrices: 0,
        allNullRows: 0,
        d1FallbackToRegular: 0,
      },
    };
  }

  const benchSeries = await loadBenchmarkSeries(db, benchmark);
  if (metric === "EXCESS_RETURN" && benchSeries.length < 5) {
    warnings.push(
      "Benchmark series is empty or too short. Run “Refresh benchmarks” on the Universe page."
    );
  }

  const benchForStock =
    metric === "EXCESS_RETURN" && benchSeries.length >= 5 ? benchSeries : null;

  const pricesBySecurity = await loadRecentPricesBatch(
    db,
    constituents.map((c) => c.securityId)
  );

  const companies: CompanyRow[] = [];
  const overlay = options.extendedQuotes;
  const live = options.liveQuotes;
  const liveMode: LiveOverlayMode = options.liveMode ?? "live";

  let excludedInsufficientPrices = 0;
  let d1FallbackToRegular = 0;

  for (const c of constituents) {
    let series = pricesBySecurity.get(c.securityId) ?? [];
    let ahOnly1D: number | null = null;
    let liveOnly1D: number | null = null;
    let overlayApplied = false;

    if (overlay) {
      const quote = overlay.get(c.security.ticker);
      if (quote) {
        const result = applyExtendedQuoteOverlay(series, quote);
        series = result.series;
        if (result.applied) {
          ahOnly1D = result.ahOnly1D;
          overlayApplied = true;
        } else if (result.skipReason === "stale_db") {
          warnings.push(
            `Extended overlay skipped for ${c.security.ticker} (DB stale vs print date ${quote.tradeDateEt})`,
          );
        }
      }
    } else if (live) {
      // Regular-session live overlay: append/replace today's price so the
      // multi-day horizons recompute on the close-to-close chain. For D1 we
      // anchor to Yahoo's prevClose (the authoritative prior close) rather
      // than the chain — otherwise a missing recent bar in PriceHistory (e.g.
      // Friday not yet ingested on Monday morning) makes D1 a multi-day
      // Mon/Thu move. Only in "live" mode; "frozen" keeps the chain so the
      // official EOD close wins once written.
      const quote = live.get(c.security.ticker);
      if (quote) {
        const result = applyLiveRegularOverlay(series, quote, liveMode);
        series = result.series;
        if (!result.applied && result.skipReason === "stale_db") {
          warnings.push(
            `Live overlay skipped for ${c.security.ticker} (DB stale vs print date ${quote.tradeDateEt})`,
          );
        }
        liveOnly1D = liveRegular1D(quote, liveMode);
      }
    }

    const lastDate = series.length ? series[series.length - 1]!.date : null;
    if (series.length < 5) {
      excludedInsufficientPrices++;
      warnings.push(`Insufficient prices for ${c.security.ticker}`);
      continue;
    }
    const metrics = securityHorizonMetrics(series, benchForStock, rf);
    let d1Source: "AH" | "REGULAR" | undefined;
    if (overlay) {
      // Extended session: prefer the AH-only print for the 1D move so the
      // after-hours leaderboard ranks genuine post-close action. When a stock
      // has no after-hours trade, fall back to the regular close-to-close move
      // (already computed by securityHorizonMetrics) instead of blanking the
      // cell — the row is tagged `d1Source: "REGULAR"` so the grid can dim it
      // and the leaderboard can tell the two apart.
      if (overlayApplied && ahOnly1D != null && Number.isFinite(ahOnly1D)) {
        metrics.D1.return = ahOnly1D;
        d1Source = "AH";
      } else {
        d1Source = "REGULAR";
        d1FallbackToRegular++;
      }
    } else if (ahOnly1D != null && Number.isFinite(ahOnly1D)) {
      metrics.D1.return = ahOnly1D;
    } else if (liveOnly1D != null && Number.isFinite(liveOnly1D)) {
      // Regular-session: anchor 1D to price / prevClose so it stays correct
      // even when the close-to-close chain is missing the prior trading day.
      metrics.D1.return = liveOnly1D;
    }
    companies.push({
      ticker: c.security.ticker,
      name: c.security.name,
      sector: c.sector,
      subTheme: c.subTheme,
      lastDate,
      metrics,
      d1Source,
    });
  }

  if (companies.length === 0) {
    return {
      rows: [],
      asOf: null,
      warnings,
      diagnostics: {
        excludedInsufficientPrices,
        allNullRows: 0,
        d1FallbackToRegular,
      },
    };
  }

  const asOf = companies.reduce<string | null>((min, co) => {
    const d = co.lastDate;
    if (!d) return min;
    if (!min || d < min) return d;
    return min;
  }, null);

  const buildCells = (m: ReturnType<typeof securityHorizonMetrics>) => {
    const cells = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      cells[h] = pickMetric(m, h, metric);
    }
    return cells;
  };

  const allNullRows = companies.reduce(
    (n, co) =>
      HORIZON_ORDER.some((h) => pickMetric(co.metrics, h, metric) != null)
        ? n
        : n + 1,
    0,
  );
  const diagnostics: MarketMapDiagnostics = {
    excludedInsufficientPrices,
    allNullRows,
    d1FallbackToRegular,
  };
  // Observability: never let a real data gap surface as a silent dash. The D1
  // fallback is expected after hours, so it alone does not warrant a warn.
  if (excludedInsufficientPrices > 0 || allNullRows > 0) {
    console.warn(
      `[market-map] universe=${universeId} metric=${metric} bench=${benchmark}: ` +
        `${excludedInsufficientPrices} excluded (<5 bars), ${allNullRows} all-null row(s)` +
        (d1FallbackToRegular > 0
          ? `, ${d1FallbackToRegular} D1 fell back to regular close`
          : ""),
    );
  }

  if (rowLevel === "COMPANY") {
    return {
      asOf,
      warnings,
      diagnostics,
      rows: companies.map((co) => ({
        key: co.ticker,
        label: `${co.ticker} — ${co.name}`,
        sector: co.sector,
        subTheme: co.subTheme,
        ticker: co.ticker,
        cells: buildCells(co.metrics),
        lastDate: co.lastDate,
        d1Source: co.d1Source,
      })),
    };
  }

  if (rowLevel === "SECTOR") {
    const sectors = [...new Set(companies.map((c) => c.sector))].sort();
    const rows: MarketMapApiRow[] = [];
    for (const s of sectors) {
      const group = companies.filter((c) => c.sector === s);
      const cells = {} as Record<Horizon, number | null>;
      for (const h of HORIZON_ORDER) {
        cells[h] = averageNullable(
          group.map((g) => pickMetric(g.metrics, h, metric))
        );
      }
      rows.push({ key: s, label: s, cells });
    }
    return { rows, asOf, warnings, diagnostics };
  }

  const keys = [
    ...new Set(companies.map((c) => `${c.sector}|||${c.subTheme}`)),
  ].sort();
  const rows: MarketMapApiRow[] = [];
  for (const k of keys) {
    const [sector, subTheme] = k.split("|||") as [string, string];
    const group = companies.filter(
      (c) => c.sector === sector && c.subTheme === subTheme
    );
    const cells = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      cells[h] = averageNullable(
        group.map((g) => pickMetric(g.metrics, h, metric))
      );
    }
    rows.push({
      key: k,
      label: `${sector} / ${subTheme}`,
      sector,
      subTheme,
      cells,
    });
  }
  return { rows, asOf, warnings, diagnostics };
}
