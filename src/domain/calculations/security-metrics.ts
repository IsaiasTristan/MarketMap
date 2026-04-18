import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER, tradingDaysForHorizon } from "@/domain/entities/horizons";
import { alignCloseSeries, type DateClose } from "./alignment";
import {
  dailyReturnsFromAdjustedCloses,
  totalReturnForHorizon,
} from "./returns";
import { annualizedRealizedVolatility } from "./volatility";
import { sharpeRatio } from "./sharpe";
import { excessReturn } from "./excess";

export type HorizonMetrics = Record<
  Horizon,
  {
    return: number | null;
    excessReturn: number | null;
    volatility: number | null;
    sharpe: number | null;
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
  }

  return out;
}
