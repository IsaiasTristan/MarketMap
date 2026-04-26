/**
 * factor-pipeline-macro.service — ingests the macro / style factor series
 * required by the MACRO14 model.
 *
 * Composition (decimal daily returns, RF-excess where noted):
 *   EQ        = ACWI - RF           (broad global equity premium)
 *   LOCAL_EQ  = SPY  - ACWI         (US equity premium over global)
 *   RATES     = IEF  - RF           (intermediate-term Treasury duration)
 *   COMM      = DBC  - RF           (broad commodity basket)
 *   EM        = EEM  - SPY          (emerging-markets premium)
 *   FX        = UUP  - RF           (USD strength vs basket)
 *   INFL      = TIP  - IEF          (breakeven inflation expectations)
 *   SHORT_VOL = SVXY - RF           (ProShares Short VIX Short-Term Futures
 *                                    ETF; futures-roll short-vol premium.
 *                                    NOTE: ProShares cut SVXY's effective
 *                                    leverage from -1.0x to -0.5x effective
 *                                    2018-02-27 after the XIV blow-up — pre-
 *                                    and post-2018 series are structurally
 *                                    different short-vol exposures and the
 *                                    regression β must be interpreted with
 *                                    that caveat.)
 *   TREND     = DBMF - RF           (managed-futures trend proxy)
 *   CROWD     = GVIP - SPY          (Goldman HF VIP basket vs SPY)
 *   BAB       = AQR Betting-Against-Beta US daily; USMV-SPY proxy splice for
 *               the ~2-month publish gap (normalised to AQR distribution).
 *   QMJ       = AQR Quality-Minus-Junk US daily; QUAL-SPY proxy splice.
 *
 * MOM and HML continue to be sourced by `factor-pipeline.service` from
 * Ken French; this service does not duplicate them.
 *
 * Idempotency: every row is upserted on (tradeDate, factorCode) so repeated
 * runs are safe and cheap. Yahoo fetches go through the existing
 * `fetchYahooChartDaily` helper which already handles 401/429 retry.
 */

import { prisma as db } from "@/infrastructure/db/client";
import { fetchYahooChartDaily } from "@/infrastructure/providers/yahoo-chart-http";
import { fetchAqrBabUs } from "@/infrastructure/providers/aqr-bab.provider";
import { fetchAqrQmjUs } from "@/infrastructure/providers/aqr-qmj.provider";
import { dailyReturnsFromAdjustedCloses } from "@/domain/calculations/returns";
import { normalizeProxyToFf, type FactorSeries } from "@/domain/calculations/factor-pipeline";
import { writeAuditLog } from "./audit.service";
import type { FactorCode } from "@/types/factors";

// ---------------------------------------------------------------------------
// Tickers we ingest from Yahoo for the macro factor pipeline.
// SPY is shared with the existing FF proxy pipeline; we still re-fetch here
// to keep the implementations independent.
// ---------------------------------------------------------------------------
const YAHOO_TICKERS = [
  "SPY",   // shared
  "ACWI",  // global equity (EQ)
  "IEF",   // 7-10y Treasury (RATES)
  "DBC",   // broad commodities (COMM)
  "EEM",   // emerging markets (EM)
  "UUP",   // US dollar bullish (FX)
  "TIP",   // TIPS (INFL)
  "USMV",  // low-vol ETF (BAB proxy splice)
  "QUAL",  // quality ETF (QMJ proxy splice)
  "DBMF",  // managed futures trend (TREND)
  "GVIP",  // Goldman HF VIP basket (CROWD)
  "SVXY",  // ProShares Short VIX Short-Term Futures ETF (SHORT_VOL)
] as const;

type YahooTicker = (typeof YAHOO_TICKERS)[number];

const HISTORY_START_ISO = "2002-01-01";
// Concurrency cap for Yahoo fetches (matches the universe ingest worker pool
// guidance in AGENTS.md to stay under throttling limits).
const YAHOO_WORKERS = 3;
const YAHOO_INTER_REQUEST_MS = 150;

/** Fetch Yahoo daily returns for a ticker, returned as a Map<date, return>. */
async function fetchEtfDailyReturns(
  ticker: string,
  startIso: string,
  endIso: string,
): Promise<Map<string, number>> {
  const bars = await fetchYahooChartDaily(ticker, startIso, endIso);
  if (bars.length < 2) return new Map();
  const prices = bars.map((b) => b.adjClose);
  const dates = bars.slice(1).map((b) => b.date);
  const rets = dailyReturnsFromAdjustedCloses(prices);
  const out = new Map<string, number>();
  dates.forEach((d, i) => out.set(d, rets[i] ?? 0));
  return out;
}

/** Fetch all Yahoo tickers concurrently with a small worker pool. */
async function fetchAllYahooReturns(
  startIso: string,
  endIso: string,
): Promise<{
  byTicker: Map<YahooTicker, Map<string, number>>;
  failed: { ticker: YahooTicker; error: string }[];
}> {
  const byTicker = new Map<YahooTicker, Map<string, number>>();
  const failed: { ticker: YahooTicker; error: string }[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < YAHOO_TICKERS.length) {
      const idx = cursor++;
      const ticker = YAHOO_TICKERS[idx]!;
      try {
        const map = await fetchEtfDailyReturns(ticker, startIso, endIso);
        byTicker.set(ticker, map);
      } catch (e) {
        failed.push({ ticker, error: e instanceof Error ? e.message : String(e) });
      }
      // Politeness gap so Yahoo doesn't 401-throttle us.
      await new Promise((r) => setTimeout(r, YAHOO_INTER_REQUEST_MS));
    }
  }

  await Promise.all(Array.from({ length: YAHOO_WORKERS }, () => worker()));
  return { byTicker, failed };
}

/** Subtract series B from series A on the intersection of their dates. */
function diffSeries(
  a: Map<string, number>,
  b: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [d, va] of a.entries()) {
    const vb = b.get(d);
    if (vb !== undefined) out.set(d, va - vb);
  }
  return out;
}

/** Subtract a constant daily RF (annual / 252) from each value in a series. */
function excessOfRf(
  a: Map<string, number>,
  rfDaily: number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [d, v] of a.entries()) out.set(d, v - rfDaily);
  return out;
}

function mapToFactorSeries(map: Map<string, number>): FactorSeries[] {
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value }));
}

interface FactorWriteRow {
  tradeDate: Date;
  factorCode: FactorCode;
  value: number;
  source: "FF" | "PROXY";
}

/**
 * Refresh the MACRO14-specific factor return series (everything except the
 * Ken French / Carhart factors which are handled by `factor-pipeline.service`).
 */
export async function refreshMacroFactorPipeline(opts?: {
  /** Override start date for ETF history. Defaults to {@link HISTORY_START_ISO}. */
  startIso?: string;
}): Promise<{
  yahooFetched: number;
  yahooFailed: { ticker: string; error: string }[];
  aqrBabRows: number;
  aqrQmjRows: number;
  factorRowsUpserted: Record<string, number>;
}> {
  const startIso = opts?.startIso ?? HISTORY_START_ISO;
  const todayIso = new Date().toISOString().slice(0, 10);

  // 1) Fetch Yahoo and AQR series in parallel.
  const [{ byTicker: yahooByTicker, failed: yahooFailed }, babAqr, qmjAqr] = await Promise.all([
    fetchAllYahooReturns(startIso, todayIso),
    fetchAqrBabUs().catch((e) => {
      console.error("[refreshMacroFactorPipeline] AQR BAB fetch failed:", e);
      return [] as Awaited<ReturnType<typeof fetchAqrBabUs>>;
    }),
    fetchAqrQmjUs().catch((e) => {
      console.error("[refreshMacroFactorPipeline] AQR QMJ fetch failed:", e);
      return [] as Awaited<ReturnType<typeof fetchAqrQmjUs>>;
    }),
  ]);

  // 2) Pull a recent risk-free rate from FactorReturnDaily so we can compute
  //    excess returns. We use the most recent FF RF as the daily rate (fine
  //    for the gap window — when FF lags, this is one ~2-month-old constant).
  const lastRfRow = await db.factorReturnDaily.findFirst({
    where: { factorCode: "RF" },
    orderBy: { tradeDate: "desc" },
    select: { value: true },
  });
  const annualRf = lastRfRow ? Number(lastRfRow.value) : 0.045;
  const dailyRf = annualRf / 252;

  // 3) Compose factor series.
  //    Series that depend on a Yahoo ticker we failed to fetch are skipped.
  function need(...tickers: YahooTicker[]): boolean {
    return tickers.every((t) => yahooByTicker.has(t) && yahooByTicker.get(t)!.size > 0);
  }
  const factorComposed: Partial<Record<FactorCode, Map<string, number>>> = {};

  if (need("ACWI")) factorComposed.EQ = excessOfRf(yahooByTicker.get("ACWI")!, dailyRf);
  if (need("SPY", "ACWI")) factorComposed.LOCAL_EQ = diffSeries(yahooByTicker.get("SPY")!, yahooByTicker.get("ACWI")!);
  if (need("IEF")) factorComposed.RATES = excessOfRf(yahooByTicker.get("IEF")!, dailyRf);
  if (need("DBC")) factorComposed.COMM = excessOfRf(yahooByTicker.get("DBC")!, dailyRf);
  if (need("EEM", "SPY")) factorComposed.EM = diffSeries(yahooByTicker.get("EEM")!, yahooByTicker.get("SPY")!);
  if (need("UUP")) factorComposed.FX = excessOfRf(yahooByTicker.get("UUP")!, dailyRf);
  if (need("TIP", "IEF")) factorComposed.INFL = diffSeries(yahooByTicker.get("TIP")!, yahooByTicker.get("IEF")!);
  if (need("SVXY")) factorComposed.SHORT_VOL = excessOfRf(yahooByTicker.get("SVXY")!, dailyRf);
  if (need("DBMF")) factorComposed.TREND = excessOfRf(yahooByTicker.get("DBMF")!, dailyRf);
  if (need("GVIP", "SPY")) factorComposed.CROWD = diffSeries(yahooByTicker.get("GVIP")!, yahooByTicker.get("SPY")!);

  // 4) BAB: AQR series for historical, USMV-SPY proxy spliced into recent gap.
  const babRows: FactorWriteRow[] = [];
  if (babAqr.length) {
    const lastAqrDate = babAqr[babAqr.length - 1]!.date;
    for (const r of babAqr) {
      babRows.push({ tradeDate: new Date(r.date), factorCode: "BAB", value: r.value, source: "FF" });
    }
    if (need("USMV", "SPY")) {
      const proxy = mapToFactorSeries(diffSeries(yahooByTicker.get("USMV")!, yahooByTicker.get("SPY")!));
      const aqrSeries = babAqr.map((r) => ({ date: r.date, value: r.value }));
      const normalized = normalizeProxyToFf(aqrSeries, proxy, lastAqrDate);
      for (const r of normalized) {
        babRows.push({ tradeDate: new Date(r.date), factorCode: "BAB", value: r.value, source: "PROXY" });
      }
    }
  }

  // 5) QMJ: AQR series for historical, QUAL-SPY proxy spliced into recent gap.
  const qmjRows: FactorWriteRow[] = [];
  if (qmjAqr.length) {
    const lastAqrDate = qmjAqr[qmjAqr.length - 1]!.date;
    for (const r of qmjAqr) {
      qmjRows.push({ tradeDate: new Date(r.date), factorCode: "QMJ", value: r.value, source: "FF" });
    }
    if (need("QUAL", "SPY")) {
      const proxy = mapToFactorSeries(diffSeries(yahooByTicker.get("QUAL")!, yahooByTicker.get("SPY")!));
      const aqrSeries = qmjAqr.map((r) => ({ date: r.date, value: r.value }));
      const normalized = normalizeProxyToFf(aqrSeries, proxy, lastAqrDate);
      for (const r of normalized) {
        qmjRows.push({ tradeDate: new Date(r.date), factorCode: "QMJ", value: r.value, source: "PROXY" });
      }
    }
  }

  // 6) Convert composed Yahoo factors into upsert rows.
  const composedRows: FactorWriteRow[] = [];
  for (const [code, map] of Object.entries(factorComposed)) {
    if (!map) continue;
    for (const [d, v] of map.entries()) {
      composedRows.push({
        tradeDate: new Date(d),
        factorCode: code as FactorCode,
        value: v,
        source: "PROXY",
      });
    }
  }

  // 7) Upsert in batches per factor code so a partial failure leaves the
  //    other factors intact.
  const allRows = [...composedRows, ...babRows, ...qmjRows];
  const counts: Record<string, number> = {};
  for (const row of allRows) {
    if (!Number.isFinite(row.value)) continue;
    await db.factorReturnDaily.upsert({
      where: { tradeDate_factorCode: { tradeDate: row.tradeDate, factorCode: row.factorCode } },
      create: row,
      update: { value: row.value, source: row.source },
    });
    counts[row.factorCode] = (counts[row.factorCode] ?? 0) + 1;
  }

  await writeAuditLog("factor.macro_pipeline.refresh", {
    yahooFetched: yahooByTicker.size,
    yahooFailed,
    aqrBabRows: babAqr.length,
    aqrQmjRows: qmjAqr.length,
    factorRowsUpserted: counts,
  });

  return {
    yahooFetched: yahooByTicker.size,
    yahooFailed,
    aqrBabRows: babAqr.length,
    aqrQmjRows: qmjAqr.length,
    factorRowsUpserted: counts,
  };
}
