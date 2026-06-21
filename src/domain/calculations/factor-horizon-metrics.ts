import { HORIZON_ORDER, tradingDaysForHorizon } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";
import { totalReturnForHorizon } from "./returns";
import { annualizedRealizedVolatility } from "./volatility";
import { sharpeRatio } from "./sharpe";
import { excessReturn } from "./excess";
import type { HorizonMetrics } from "./security-metrics";

/**
 * Per-horizon return / excess / volatility / Sharpe for a factor whose daily
 * simple returns are already in hand (factor returns are stored as daily
 * decimals in `FactorReturnDaily`, so unlike `securityHorizonMetrics` there is
 * no price → return conversion or alignment step here).
 *
 * Geometric compounding `Π(1 + r) − 1` (via `totalReturnForHorizon`) matches
 * the stock Market Map grid so factor cells are directly comparable to ticker
 * cells in the same column.
 *
 * Volatility and Sharpe are only defined when the horizon has at least two
 * observations (i.e. `1D` always returns `null` for both), mirroring
 * `securityHorizonMetrics` exactly.
 *
 * The benchmark slice is aligned by **trailing-N of its own series**, not by
 * date — both share the US trading calendar, so the offset is negligible at
 * Market Map horizons.
 */
export function factorHorizonMetrics(
  factorDaily: number[],
  benchDaily: number[] | null,
  riskFreeAnnual: number,
): HorizonMetrics {
  const out = {} as HorizonMetrics;
  for (const h of HORIZON_ORDER) {
    out[h] = { return: null, excessReturn: null, volatility: null, sharpe: null };
  }
  if (factorDaily.length === 0) return out;

  for (const h of HORIZON_ORDER) {
    const td = tradingDaysForHorizon(h);
    const ret = totalReturnForHorizon(factorDaily, h);
    out[h].return = ret;

    if (benchDaily && benchDaily.length >= td) {
      const benchRet = totalReturnForHorizon(benchDaily, h);
      if (ret != null && benchRet != null) {
        out[h].excessReturn = excessReturn(ret, benchRet);
      }
    }

    if (td >= 2 && factorDaily.length >= td) {
      const window = factorDaily.slice(-td);
      out[h].volatility = annualizedRealizedVolatility(window);
      out[h].sharpe = sharpeRatio(window, riskFreeAnnual);
    }
  }

  return out;
}

/**
 * Pick the per-horizon scalar matching the selected metric. Mirrors the
 * private `pickMetric` in `market-map.service` so factor rows render with
 * the exact same selector semantics as ticker rows.
 */
export function pickFactorMetric(
  m: HorizonMetrics,
  h: Horizon,
  metric: "RETURN" | "EXCESS_RETURN" | "VOLATILITY" | "SHARPE",
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
