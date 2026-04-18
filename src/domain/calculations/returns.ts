import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_TRADING_DAYS } from "@/domain/entities/horizons";

/**
 * `adjCloses` must be in **ascending** trade-date order (oldest → newest).
 * Daily return: (P_t / P_{t-1}) - 1
 */
export function dailyReturnsFromAdjustedCloses(adjCloses: number[]): number[] {
  if (adjCloses.length < 2) return [];
  const out: number[] = [];
  for (let i = 1; i < adjCloses.length; i++) {
    const prev = adjCloses[i - 1]!;
    const cur = adjCloses[i]!;
    if (prev === 0) {
      out.push(0);
    } else {
      out.push(cur / prev - 1);
    }
  }
  return out;
}

/**
 * Compound return over the last `horizon` **trading days** using the last
 * `horizon` daily returns in `dailyReturns` (most recent at end of array).
 * Requires at least `tradingDays` return observations (i.e. `tradingDays + 1` prices).
 */
export function totalReturnForHorizon(
  dailyReturns: number[],
  horizon: Horizon
): number | null {
  const h = HORIZON_TRADING_DAYS[horizon];
  if (dailyReturns.length < h || h < 1) return null;
  const slice = dailyReturns.slice(-h);
  return compoundFromDailyReturns(slice);
}

function compoundFromDailyReturns(dailyReturns: number[]): number {
  return dailyReturns.reduce((acc, r) => acc * (1 + r), 1) - 1;
}
