/**
 * GET /api/analysis/factors/per-stock/live-1d
 *
 * Live (intraday) 1D factor decomposition for a single ticker. Reuses the
 * saved horizon-OLS betas + intercept (persisted on the per-stock grid
 * cache) and applies them to TODAY's live factor row + live stock 1D
 * return. The result is shaped as a {@link PerStockPeriodSlice} so the
 * existing waterfall (PerStockDetail) can render it identically to the
 * cached at-close slice without further branching.
 *
 * Query params:
 *   - ticker  (required) — stock symbol to decompose.
 *   - model   ModelPresetName (default MACRO14) — cache key.
 *   - window  regression-window in trading days (default 252) — cache key.
 *
 * Response shapes (200):
 *   { live: true, slice, asOf, session, missingLegs }
 *   { live: false, reason }   // ticker not in cache, no live factor row,
 *                             // or no live stock quote available.
 *
 * The caller (PerStockDetail) falls back to `row.periodSlices["1D"]` when
 * `live: false`, so this endpoint never blocks the panel from rendering.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { MODEL_PRESET_NAMES } from "@/lib/api/schemas";
import { readPerStockGridCache } from "@/server/services/factor-per-stock-cache.service";
import {
  getLiveFactorRow,
  getLiveStockReturn,
} from "@/server/services/live-factor-returns.service";
import {
  factorRowLog,
  logOnePlusClipped,
} from "@/lib/factors/attribution/log-returns";
import { computeStaticBetaPeriodSlice } from "@/lib/factors/attribution/static-beta-period";
import { todayEtIsoDate } from "@/lib/factors/attribution/today-et";
import type {
  PerStockPeriodSlice,
  PerStockResult,
  PerStockRow,
} from "@/server/services/factor-per-stock.service";
import type { FactorCode, ModelPresetName } from "@/types/factors";
import type { LiveFactorEtf } from "@/lib/factors/live/compose-live-factors";
import type { MarketSession } from "@/lib/market-map/market-session";

const querySchema = z.object({
  ticker: z.string().min(1),
  model: z.enum(MODEL_PRESET_NAMES).optional().default("MACRO14"),
  window: z
    .string()
    .optional()
    .transform((v) => (v ? Math.max(20, Math.min(2520, Number(v))) : 252))
    .pipe(z.number().int().min(20).max(2520)),
});

export const maxDuration = 30;

interface LiveOkResponse {
  live: true;
  asOf: string;
  session: MarketSession;
  /** Live 1D period slice — drop-in replacement for `row.periodSlices["1D"]`. */
  slice: PerStockPeriodSlice;
  /** Live stock quote for the headline. */
  stock: { price: number; prevClose: number; return1D: number };
  /** ETF legs that were missing — surfaced so the UI can warn of partial coverage. */
  missingLegs: LiveFactorEtf[];
  /**
   * Factors used in the live decomposition (intersection of cached `betas`
   * and the live row's `returns`). Surfaced so the UI can disambiguate
   * dropped factors from cell-level read paths.
   */
  factorsUsed: FactorCode[];
}

interface LiveSkipResponse {
  live: false;
  reason:
    | "TICKER_NOT_IN_GRID"
    | "NO_LIVE_FACTORS"
    | "NO_LIVE_STOCK_QUOTE"
    | "CACHE_MISS";
}

function findRow(result: PerStockResult, ticker: string): PerStockRow | null {
  const upper = ticker.trim().toUpperCase();
  for (const r of result.rows) {
    if (r.ticker.toUpperCase() === upper) return r;
  }
  return null;
}

export async function GET(req: NextRequest) {
  const q = Object.fromEntries(req.nextUrl.searchParams);
  const parsed = querySchema.safeParse(q);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const { ticker, model, window: win } = parsed.data;
  const modelName = model as ModelPresetName;

  // 1) Live factor row — available in any session with a usable Yahoo quote.
  const liveRow = await getLiveFactorRow(new Date());
  if (!liveRow) {
    return NextResponse.json({
      live: false,
      reason: "NO_LIVE_FACTORS",
    } satisfies LiveSkipResponse);
  }

  // 2) Cached row gives us the persisted betas + alpha (simple + log).
  const cached = await readPerStockGridCache(modelName, win);
  if (!cached) {
    return NextResponse.json({
      live: false,
      reason: "CACHE_MISS",
    } satisfies LiveSkipResponse);
  }
  const row = findRow(cached, ticker);
  if (!row) {
    return NextResponse.json({
      live: false,
      reason: "TICKER_NOT_IN_GRID",
    } satisfies LiveSkipResponse);
  }

  // 3) Live stock quote for the LHS.
  const stockQ = await getLiveStockReturn(ticker);
  if (!stockQ) {
    return NextResponse.json({
      live: false,
      reason: "NO_LIVE_STOCK_QUOTE",
    } satisfies LiveSkipResponse);
  }

  // 4) Build the live factor row in the SAME factor order the cached row
  //    used. Drop factors with no live return OR no persisted beta on this
  //    stock — keeping the simple/log paths perfectly aligned.
  const factorCodes = (cached.usableFactors ?? []).filter((code) => {
    const cell = row.cells[code];
    if (!cell) return false;
    const lr = liveRow.returns[code];
    return lr != null && Number.isFinite(lr);
  });

  if (factorCodes.length === 0) {
    return NextResponse.json({
      live: false,
      reason: "NO_LIVE_FACTORS",
    } satisfies LiveSkipResponse);
  }

  const betas = factorCodes.map((c) => row.cells[c]!.beta);
  const factorReturnSimple = factorCodes.map((c) => liveRow.returns[c]!);
  // y_excess = r_stock - r_f, where r_f is the latest stored daily RF
  // (intraday RF moves are vanishingly small ~1e-7/day).
  const yExcess = stockQ.return1D - liveRow.rf;

  const decompSimple = computeStaticBetaPeriodSlice(
    betas,
    row.alphaDaily,
    [factorReturnSimple],
    [yExcess],
  );

  // ---- Log path ----------------------------------------------------------
  // Only built when every factor in `factorCodes` has a persisted log beta
  // AND the daily log alpha AND the log domain is well-defined for both
  // the LHS and the entire RHS row. Strict-drop policy from the historical
  // path: any bad cell → no log slice (UI falls back to simple cleanly).
  const logBetas: number[] = [];
  let logOk = row.alphaDailyLog != null;
  if (logOk) {
    for (const c of factorCodes) {
      const bL = row.cells[c]?.betaLog;
      if (bL == null || !Number.isFinite(bL)) {
        logOk = false;
        break;
      }
      logBetas.push(bL);
    }
  }
  const factorReturnLog = logOk ? factorRowLog(factorReturnSimple) : null;
  let returnByFactorLog: Partial<Record<FactorCode, number>> = {};
  let alphaSumLog: number | null = null;
  let residualSumLog: number | null = null;
  if (logOk && factorReturnLog) {
    const lsRStock = logOnePlusClipped(stockQ.return1D);
    const lsRf = logOnePlusClipped(liveRow.rf);
    if (
      Number.isFinite(lsRStock.value) &&
      Number.isFinite(lsRf.value) &&
      !lsRStock.clipped
    ) {
      const yLog = lsRStock.value - lsRf.value;
      const decompLog = computeStaticBetaPeriodSlice(
        logBetas,
        row.alphaDailyLog!,
        [factorReturnLog],
        [yLog],
      );
      factorCodes.forEach((c, i) => {
        returnByFactorLog[c] = decompLog.returnByFactor[i] ?? 0;
      });
      alphaSumLog = decompLog.alphaSum;
      residualSumLog = decompLog.residualSum;
    } else {
      // Stock dropped ≥ 100% in a single day — log path is undefined.
      // Surface as null so the UI degrades to simple-mode rendering.
      returnByFactorLog = {};
    }
  }

  const returnByFactor: Partial<Record<FactorCode, number>> = {};
  factorCodes.forEach((c, i) => {
    returnByFactor[c] = decompSimple.returnByFactor[i] ?? 0;
  });

  const today = todayEtIsoDate();
  const slice: PerStockPeriodSlice = {
    returnByFactor,
    returnByFactorLog,
    alphaSum: decompSimple.alphaSum,
    residualSum: decompSimple.residualSum,
    alphaSumLog,
    residualSumLog,
    observations: 1,
    startDate: today,
    endDate: today,
    // Live total return is the price-based 1D move (matches the chart header).
    realizedTotalReturn: stockQ.return1D,
  };

  const body: LiveOkResponse = {
    live: true,
    asOf: liveRow.asOf,
    session: liveRow.session,
    slice,
    stock: stockQ,
    missingLegs: liveRow.missingLegs,
    factorsUsed: factorCodes,
  };
  return NextResponse.json(body);
}
