/**
 * Engine 1 — weekly price capture + backfill into RevisionPriceSnapshot.
 *
 * The gap score needs peer-relative price returns on the same weekly grid as
 * the revision snapshots. Unlike estimates, prices ARE backfillable from FMP,
 * so the first run seeds ~priceBackfillWeeks of weekly closes behind the
 * earliest snapshot (13w returns + forward returns for validation work
 * immediately). The weekly capture then re-fetches a trailing window and
 * upserts it — wide enough to feed ret13w and to self-heal adjClose
 * re-adjustments after splits/dividends. Idempotent per (ticker, snapshotDate).
 */
import { prisma } from "@/infrastructure/db/client";
import { fetchHistoricalEod, fmpPool } from "@/infrastructure/providers/fmp";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  trailingReturns,
  weeklyCloseSeries,
  weeklyGridDates,
  type WeeklyClose,
} from "@/lib/revision/prices";
import { loadActiveUniverseTickers } from "./reference-ingest.service";

const DAY_MS = 86_400_000;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoAddDays(iso: string, days: number): string {
  return new Date(new Date(`${iso}T00:00:00Z`).getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

/** The full weekly grid: every distinct RevisionSnapshot date + backward extension. */
export async function loadWeeklyGrid(extendWeeks: number): Promise<string[]> {
  const dates = await prisma.revisionSnapshot.findMany({
    distinct: ["snapshotDate"],
    select: { snapshotDate: true },
    orderBy: { snapshotDate: "asc" },
  });
  return weeklyGridDates(dates.map((d) => isoOf(d.snapshotDate)), extendWeeks);
}

interface TickerWeekRow {
  ticker: string;
  snapshotDate: string;
  close: number | null;
  priceDate: string | null;
  ret1w: number | null;
  ret4w: number | null;
  ret13w: number | null;
}

function buildRows(ticker: string, series: WeeklyClose[]): TickerWeekRow[] {
  const rets = trailingReturns(series.map((s) => s.close));
  return series.map((s, i) => ({
    ticker,
    snapshotDate: s.snapshotDate,
    close: s.close,
    priceDate: s.priceDate,
    ret1w: rets[i]!.ret1w,
    ret4w: rets[i]!.ret4w,
    ret13w: rets[i]!.ret13w,
  }));
}

export interface PriceBackfillSummary {
  tickers: number;
  gridWeeks: number;
  rowsWritten: number;
  failures: string[];
}

/**
 * One-time (re-runnable) backfill: for each active ticker, ONE daily-EOD fetch
 * covering the whole grid, sampled onto it. createMany(skipDuplicates) keeps
 * re-runs cheap; pass `refresh: true` to upsert over existing rows instead
 * (heals historical adjCloses after splits — recommended occasionally).
 */
export async function backfillPriceHistory(
  opts: {
    extendWeeks?: number;
    tickers?: string[];
    refresh?: boolean;
    log?: (msg: string) => void;
  } = {},
): Promise<PriceBackfillSummary> {
  const log = opts.log ?? (() => {});
  const extendWeeks = opts.extendWeeks ?? REVISION_THRESHOLDS.priceBackfillWeeks;
  const grid = await loadWeeklyGrid(extendWeeks);
  if (grid.length === 0) {
    log("[prices] no snapshot dates present; nothing to backfill");
    return { tickers: 0, gridWeeks: 0, rowsWritten: 0, failures: [] };
  }
  const tickers = opts.tickers ?? (await loadActiveUniverseTickers());
  // 13w returns at the grid start need bars before it.
  const fetchFrom = isoAddDays(grid[0]!, -7 * 14);
  const fetchTo = grid[grid.length - 1]!;
  log(`[prices] backfilling ${tickers.length} tickers x ${grid.length} grid weeks (${grid[0]} .. ${fetchTo})`);

  let rowsWritten = 0;
  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const bars = await fetchHistoricalEod(ticker, fetchFrom, fetchTo);
      const rows = buildRows(ticker, weeklyCloseSeries(bars, grid));
      const data = rows.map((r) => ({
        ticker: r.ticker,
        snapshotDate: new Date(`${r.snapshotDate}T00:00:00Z`),
        close: r.close,
        priceDate: r.priceDate ? new Date(`${r.priceDate}T00:00:00Z`) : null,
        ret1w: r.ret1w,
        ret4w: r.ret4w,
        ret13w: r.ret13w,
      }));
      if (opts.refresh) {
        for (const d of data) {
          await prisma.revisionPriceSnapshot.upsert({
            where: { ticker_snapshotDate: { ticker: d.ticker, snapshotDate: d.snapshotDate } },
            create: d,
            update: { close: d.close, priceDate: d.priceDate, ret1w: d.ret1w, ret4w: d.ret4w, ret13w: d.ret13w },
          });
        }
        rowsWritten += data.length;
      } else {
        const res = await prisma.revisionPriceSnapshot.createMany({ data, skipDuplicates: true });
        rowsWritten += res.count;
      }
    },
    { concurrency: 8 },
  );

  log(`[prices] backfill wrote ${rowsWritten} rows (${failures.length} ticker failures)`);
  return {
    tickers: tickers.length,
    gridWeeks: grid.length,
    rowsWritten,
    failures: failures.map((f) => `${f.item}: ${f.error}`),
  };
}

export interface PriceCaptureSummary {
  snapshotDate: string;
  tickers: number;
  rowsWritten: number;
  coverage: number; // share of tickers with a non-null close at snapshotDate
  failures: string[];
}

/**
 * Weekly capture for one snapshot date: re-fetch a trailing window per ticker
 * and UPSERT the trailing `refreshTrailingWeeks` grid weeks. The window covers
 * ret13w's lookback and self-heals recent split/dividend re-adjustments —
 * which is why this doesn't just read prior closes back out of the table.
 */
export async function capturePriceWeek(
  opts: {
    snapshotDate: string;
    tickers?: string[];
    refreshTrailingWeeks?: number;
    log?: (msg: string) => void;
  },
): Promise<PriceCaptureSummary> {
  const log = opts.log ?? (() => {});
  const refreshWeeks = opts.refreshTrailingWeeks ?? REVISION_THRESHOLDS.weeklyPriceRefreshWeeks;
  const grid = await loadWeeklyGrid(REVISION_THRESHOLDS.priceBackfillWeeks);
  const upTo = grid.filter((d) => d <= opts.snapshotDate);
  if (upTo.length === 0) {
    log(`[prices] snapshot date ${opts.snapshotDate} precedes the grid; skipping`);
    return { snapshotDate: opts.snapshotDate, tickers: 0, rowsWritten: 0, coverage: 0, failures: [] };
  }
  // Compute over refreshWeeks + 13 so the oldest refreshed week keeps its ret13w.
  const computeGrid = upTo.slice(Math.max(0, upTo.length - (refreshWeeks + 13)));
  const writeFrom = computeGrid[Math.max(0, computeGrid.length - refreshWeeks)]!;
  const fetchFrom = isoAddDays(computeGrid[0]!, -10);
  const tickers = opts.tickers ?? (await loadActiveUniverseTickers());
  log(`[prices] weekly capture ${opts.snapshotDate}: ${tickers.length} tickers, upserting weeks >= ${writeFrom}`);

  let rowsWritten = 0;
  let covered = 0;
  const { failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const bars = await fetchHistoricalEod(ticker, fetchFrom, opts.snapshotDate);
      const rows = buildRows(ticker, weeklyCloseSeries(bars, computeGrid));
      const target = rows.filter((r) => r.snapshotDate >= writeFrom);
      for (const r of target) {
        const key = { ticker: r.ticker, snapshotDate: new Date(`${r.snapshotDate}T00:00:00Z`) };
        const fields = {
          close: r.close,
          priceDate: r.priceDate ? new Date(`${r.priceDate}T00:00:00Z`) : null,
          ret1w: r.ret1w,
          ret4w: r.ret4w,
          ret13w: r.ret13w,
        };
        await prisma.revisionPriceSnapshot.upsert({
          where: { ticker_snapshotDate: key },
          create: { ...key, ...fields },
          update: fields,
        });
        rowsWritten++;
      }
      const atSnapshot = target.find((r) => r.snapshotDate === opts.snapshotDate);
      if (atSnapshot?.close !== null && atSnapshot?.close !== undefined) covered++;
    },
    { concurrency: 8 },
  );

  const coverage = tickers.length > 0 ? covered / tickers.length : 0;
  log(`[prices] capture wrote ${rowsWritten} rows, coverage ${(coverage * 100).toFixed(1)}% (${failures.length} failures)`);
  return {
    snapshotDate: opts.snapshotDate,
    tickers: tickers.length,
    rowsWritten,
    coverage,
    failures: failures.map((f) => `${f.item}: ${f.error}`),
  };
}
