/**
 * Engine 2 — weekly ingestion orchestrator. Single code path shared by the CLI
 * (scripts/fundamental-weekly.ts) and any startup catch-up. Reuses Engine 1's
 * RevisionReference universe (loadActiveUniverseTickers). For each ticker it
 * fetches + maps fundamentals, persists FundamentalPeriod write-once, and
 * upserts one append-only FundamentalSnapshot per (ticker, snapshotDate) with
 * the latest TTM leading metrics, current valuation multiples, and a compact
 * trailing series for the diligence sparklines.
 *
 * Fundamentals only change on filings, so a weekly cadence is ample. The first
 * run uses `backfill` (BACKFILL provenance + deep history); routine weekly runs
 * are LIVE (tail newly-filed periods, accruing true as-first-reported history).
 */
import type { FundamentalProvenance, Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { fmpPool, type NormalizedQuote } from "@/infrastructure/providers/fmp";
import {
  buildReferenceFromMarketMap,
  loadActiveUniverseTickers,
  refreshRevisionReference,
} from "@/server/services/revision/reference-ingest.service";
import type { ReferenceSource } from "@/server/services/revision/revision-weekly-job.service";
import { buildMetricSeries, lastFinite, type PeriodFacts } from "@/lib/fundamental/series";
import { accrualsRatio } from "@/lib/fundamental/quality";
import {
  buildTickerFundamentals,
  persistPeriods,
  type ComputedPeriod,
} from "./fundamental-statements.service";
import { persistEarningsSurprises } from "./fundamental-earnings.service";

const METRICS_TRAIL = 20; // quarters retained in the snapshot sparkline cache

export interface FundamentalWeeklyOptions {
  snapshotDate?: string;
  refreshReference?: boolean; // default false — Engine 1 owns the shared universe
  /** MARKET_MAP (default): user's saved universe taxonomy; FMP_SCREENER: cap-ranked screener. */
  referenceSource?: ReferenceSource;
  /** Specific market-map universe to source from (MARKET_MAP only). */
  universeId?: string;
  backfill?: boolean; // BACKFILL provenance + deep history (first run)
  enrichProfiles?: boolean;
  maxUniverse?: number;
  quarters?: number;
  log?: (msg: string) => void;
}

export interface FundamentalWeeklySummary {
  snapshotDate: string;
  provenance: FundamentalProvenance;
  universeSize: number;
  snapshotsWritten: number;
  periodsInserted: number;
  restatements: number;
  failures: string[];
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function ratio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  return num / den;
}

function toFacts(p: ComputedPeriod): PeriodFacts {
  return {
    fiscalDate: p.fiscalDate,
    revenue: p.revenue,
    grossProfit: p.grossProfit,
    operatingIncome: p.operatingIncome,
    netIncome: p.netIncome,
    ebitda: p.ebitda,
    freeCashFlow: p.freeCashFlow,
    operatingCashFlow: p.operatingCashFlow,
    totalDebt: p.totalDebt,
    cash: p.cash,
    totalAssets: p.totalAssets,
    roic: p.roic,
    peRatio: p.peRatio,
    evToEbitda: p.evToEbitda,
    priceToSales: p.priceToSales,
  };
}

/** Positive-only multiple (negative P/E or EV/EBITDA carries no valuation meaning). */
function posMultiple(v: number | null): number | null {
  return v !== null && Number.isFinite(v) && v > 0 ? v : null;
}

function buildSnapshotData(
  periods: ComputedPeriod[],
  quote: NormalizedQuote | null,
): Prisma.FundamentalSnapshotUncheckedCreateInput | null {
  if (periods.length === 0) return null;
  const series = buildMetricSeries(periods.map(toFacts));
  const ttmRevenue = lastFinite(series.ttmRevenue);
  const grossMargin = lastFinite(series.ttmGrossMargin);
  const ebitdaMargin = lastFinite(series.ttmEbitdaMargin);
  const operatingMargin = lastFinite(series.ttmOperatingMargin);
  const netMargin = lastFinite(series.ttmNetMargin);
  const fcfTtm = lastFinite(series.ttmFcf);
  const fcfMargin = lastFinite(series.ttmFcfMargin);
  const revenueGrowthYoy = lastFinite(series.revenueGrowthYoy);
  const roic = lastFinite(series.roic);
  const netDebtToEbitda = lastFinite(series.netDebtToEbitda);

  const latest = periods[periods.length - 1]!;
  const marketCap = quote?.marketCap ?? null;
  const enterpriseValue =
    marketCap !== null && latest.totalDebt !== null && latest.cash !== null
      ? marketCap + latest.totalDebt - latest.cash
      : null;

  const ttmNetIncome = ttmRevenue !== null && netMargin !== null ? ttmRevenue * netMargin : null;
  const ttmEbitda = ttmRevenue !== null && ebitdaMargin !== null ? ttmRevenue * ebitdaMargin : null;
  const peRatio = posMultiple(ratio(marketCap, ttmNetIncome));
  const evToEbitda = posMultiple(ratio(enterpriseValue, ttmEbitda));
  const priceToSales = posMultiple(ratio(marketCap, ttmRevenue));

  // Accruals (TTM net income vs TTM operating cash flow over average assets).
  const ttmOcf = (() => {
    const ocf = series.operatingCashFlow;
    const n = ocf.length;
    if (n < 4) return null;
    let s = 0;
    for (let k = n - 4; k < n; k++) {
      const v = ocf[k];
      if (v === null || v === undefined || !Number.isFinite(v)) return null;
      s += v;
    }
    return s;
  })();
  const assetsNow = latest.totalAssets;
  const assetsPrev = periods[periods.length - 2]?.totalAssets ?? assetsNow;
  const avgAssets =
    assetsNow !== null && assetsPrev !== null ? (assetsNow + assetsPrev) / 2 : assetsNow;
  const accruals = accrualsRatio(ttmNetIncome, ttmOcf, avgAssets);

  const trail = <T,>(arr: T[]) => arr.slice(-METRICS_TRAIL);
  const metricsJson = {
    dates: trail(series.dates),
    ttmGrossMargin: trail(series.ttmGrossMargin),
    ttmEbitdaMargin: trail(series.ttmEbitdaMargin),
    ttmOperatingMargin: trail(series.ttmOperatingMargin),
    ttmNetMargin: trail(series.ttmNetMargin),
    revenueGrowthYoy: trail(series.revenueGrowthYoy),
    ttmFcf: trail(series.ttmFcf),
    roic: trail(series.roic),
    netDebtToEbitda: trail(series.netDebtToEbitda),
    histPeRatio: trail(series.peRatio),
    histEvToEbitda: trail(series.evToEbitda),
    histPriceToSales: trail(series.priceToSales),
    currentMultiples: { peRatio, evToEbitda, priceToSales },
  };

  return {
    ticker: "", // set by the caller
    snapshotDate: new Date(), // set by the caller
    latestFiscalDate: new Date(`${latest.fiscalDate}T00:00:00Z`),
    revenueTtm: ttmRevenue,
    grossMargin,
    ebitdaMargin,
    operatingMargin,
    netMargin,
    roic,
    roe: latest.roe,
    fcfTtm,
    fcfMargin,
    revenueGrowthYoy,
    netDebtToEbitda,
    accrualsRatio: accruals,
    peRatio,
    evToEbitda,
    priceToSales,
    marketCap,
    enterpriseValue,
    metricsJson: metricsJson as Prisma.InputJsonValue,
  } as Prisma.FundamentalSnapshotUncheckedCreateInput;
}

export async function runFundamentalWeekly(
  opts: FundamentalWeeklyOptions = {},
): Promise<FundamentalWeeklySummary> {
  const log = opts.log ?? (() => {});
  const snapshotDate = opts.snapshotDate ?? todayIso();
  const snap = new Date(`${snapshotDate}T00:00:00Z`);
  const provenance: FundamentalProvenance = opts.backfill ? "BACKFILL" : "LIVE";
  const quarters = opts.quarters ?? (opts.backfill ? 36 : 12);
  const failures: string[] = [];

  if (opts.refreshReference) {
    const referenceSource: ReferenceSource = opts.referenceSource ?? "MARKET_MAP";
    const ref =
      referenceSource === "FMP_SCREENER"
        ? await refreshRevisionReference({
            enrichProfiles: opts.enrichProfiles,
            maxUniverse: opts.maxUniverse,
            log,
          })
        : await buildReferenceFromMarketMap({ universeId: opts.universeId, log });
    failures.push(...ref.failures.slice(0, 20));
  }

  let tickers = await loadActiveUniverseTickers();
  if (opts.maxUniverse) tickers = tickers.slice(0, opts.maxUniverse);
  log(`[fund-weekly] universe ${tickers.length} tickers; snapshotDate=${snapshotDate}; provenance=${provenance}`);
  if (tickers.length === 0) {
    return { snapshotDate, provenance, universeSize: 0, snapshotsWritten: 0, periodsInserted: 0, restatements: 0, failures };
  }

  let snapshotsWritten = 0;
  let periodsInserted = 0;
  let restatements = 0;

  const { failures: poolFailures } = await fmpPool(
    tickers,
    async (ticker) => {
      const f = await buildTickerFundamentals(ticker, { quarters });
      if (f.periods.length === 0) return;
      const persisted = await persistPeriods(ticker, f.periods, snapshotDate, provenance);
      periodsInserted += persisted.inserted;
      restatements += persisted.restatements;

      // Per-report earnings surprises (write-once) — Surprise box + residual-since-earnings.
      try {
        await persistEarningsSurprises(ticker, snapshotDate);
      } catch (e) {
        failures.push(`${ticker} earnings: ${e instanceof Error ? e.message : String(e)}`);
      }

      const data = buildSnapshotData(f.periods, f.quote);
      if (!data) return;
      data.ticker = ticker;
      data.snapshotDate = snap;
      await prisma.fundamentalSnapshot.upsert({
        where: { ticker_snapshotDate: { ticker, snapshotDate: snap } },
        create: data,
        update: data,
      });
      snapshotsWritten++;
    },
    { concurrency: 6 },
  );

  for (const f of poolFailures) failures.push(`${f.item}: ${f.error}`);
  log(`[fund-weekly] snapshots ${snapshotsWritten}, periods +${periodsInserted}, restatements ${restatements}, failures ${poolFailures.length}`);

  return {
    snapshotDate,
    provenance,
    universeSize: tickers.length,
    snapshotsWritten,
    periodsInserted,
    restatements,
    failures,
  };
}
