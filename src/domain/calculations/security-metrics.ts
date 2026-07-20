import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER, tradingDaysForHorizon } from "@/domain/entities/horizons";
import { alignCloseSeries, type DateClose } from "./alignment";
import {
  dailyReturnsFromAdjustedCloses,
  totalReturnForHorizon,
} from "./returns";
import { annualizedRealizedVolatility } from "./volatility";
import { standardDeviationSample } from "./math";
import { sharpeRatio } from "./sharpe";
import { excessReturn } from "./excess";

/**
 * Z-score denominator estimation window: σ_daily is the sample std of daily
 * returns strictly BEFORE the horizon window (so the move being scored never
 * deflates its own denominator), capped to the most recent Z_LOOKBACK obs and
 * requiring at least Z_MIN_OBS. z(h) = return(h) / (σ_daily × √N).
 */
const Z_LOOKBACK = 252;
const Z_MIN_OBS = 40;

export type HorizonMetrics = Record<
  Horizon,
  {
    return: number | null;
    excessReturn: number | null;
    volatility: number | null;
    sharpe: number | null;
    /** Volatility-adjusted ("sigma move") return: return / zDenom. */
    returnZ: number | null;
    /** σ_daily × √N scale, kept so callers overriding `return` (live/AH 1D
     *  overlays) can re-derive a consistent returnZ. */
    zDenom: number | null;
  }
>;

/**
 * Build aligned series, then per-horizon return / excess / vol / Sharpe.
 * Excess uses benchmark total return over the same horizon (trading days).
 */
export function securityHorizonMetrics(
  stockSeries: DateClose[],
  benchmarkSeries: DateClose[] | null,
  riskFreeAnnual: number
): HorizonMetrics {
  const empty = (): HorizonMetrics => {
    const o = {} as HorizonMetrics;
    for (const h of HORIZON_ORDER) {
      o[h] = {
        return: null,
        excessReturn: null,
        volatility: null,
        sharpe: null,
        returnZ: null,
        zDenom: null,
      };
    }
    return o;
  };

  const out = empty();
  if (stockSeries.length < 3) return out;

  let stockCloses = stockSeries.map((r) => r.adjClose);
  let stockDaily = dailyReturnsFromAdjustedCloses(stockCloses);
  let benchDaily: number[] | null = null;

  if (benchmarkSeries && benchmarkSeries.length > 0) {
    const aligned = alignCloseSeries(stockSeries, benchmarkSeries);
    if (aligned.dates.length >= 3) {
      stockCloses = aligned.stock;
      stockDaily = dailyReturnsFromAdjustedCloses(stockCloses);
      benchDaily = dailyReturnsFromAdjustedCloses(aligned.bench);
    }
  }

  for (const h of HORIZON_ORDER) {
    const td = tradingDaysForHorizon(h);
    const ret = totalReturnForHorizon(stockDaily, h);
    out[h].return = ret;

    let benchRet: number | null = null;
    if (benchDaily && benchDaily.length >= td) {
      benchRet = totalReturnForHorizon(benchDaily, h);
    }
    if (ret != null && benchRet != null) {
      out[h].excessReturn = excessReturn(ret, benchRet);
    }

    if (td >= 2 && stockDaily.length >= td) {
      const window = stockDaily.slice(-td);
      out[h].volatility = annualizedRealizedVolatility(window);
      out[h].sharpe = sharpeRatio(window, riskFreeAnnual);
    }

    const preWindow = stockDaily.slice(0, -td).slice(-Z_LOOKBACK);
    if (preWindow.length >= Z_MIN_OBS) {
      const sigma = standardDeviationSample(preWindow);
      if (sigma > 0) {
        const denom = sigma * Math.sqrt(td);
        out[h].zDenom = denom;
        if (ret != null) out[h].returnZ = ret / denom;
      }
    }
  }

  return out;
}
