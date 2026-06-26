/**
 * factor-top-movers.service — universe-wide per-factor movers ranking.
 *
 * For each MACRO14 factor, rank every active universe stock by its return
 * contribution to that factor (β_stock,factor × factor return over the
 * horizon) and return the top-N most-positive and most-negative.
 *
 * Cost: one cached per-stock grid read (saved betas + cached period slices),
 * plus — for the 1D horizon only — one shared `getLiveFactorRow()` fetch
 * (~16 ETF quotes, 30s/5min cache) to compute today's live factor moves. No
 * per-stock market-data calls: ranking needs only β × r_factor.
 *
 *   • 1D  : value = cell.beta × liveFactorReturn[code]  (live intraday)
 *   • 5D+ : value = row.periodSlices[label].returnByFactor[code]  (cached EOD)
 *
 * Factor order matches the Factor Performance table: descending by the
 * factor's own return over the horizon (live returns for 1D, the EOD factor
 * performance map for 5D+). Falls back to the cached at-close 1D slice when
 * the live fetch is unavailable.
 */
import { prisma as db } from "@/infrastructure/db/client";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_LABEL } from "@/lib/format";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { isExcludedSector } from "@/lib/market-map/excluded-sectors";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import { logOnePlus } from "@/lib/factors/attribution/log-returns";
import {
  splitTopMovers,
} from "@/lib/factors/per-stock/rank-factor-movers";
import type {
  FactorCode,
  FactorTopMoverEntry,
  FactorTopMoversFactor,
  FactorTopMoversResult,
} from "@/types/factors";
import { readPerStockGridCache } from "./factor-per-stock-cache.service";
import { getLiveFactorRow } from "./live-factor-returns.service";
import { computeFactorPerformanceMap } from "./factor-performance.service";

type PeriodLabel = "1D" | "5D" | "1M" | "3M" | "6M" | "1Y";

export interface FactorTopMoversParams {
  horizon: Horizon;
  /** Regression window (trading days) for the saved betas. Default 252 (Standard). */
  window?: number;
  /** Top-N per side. Default 20. */
  limit?: number;
  /**
   * Attribution space. "log" (default) ties to the per-stock popup waterfall
   * (which renders in log mode by default): contribution = β_log × ln(1 + r).
   * "simple" uses β × r. Mirrors the app-wide `factorAttributionMode`.
   */
  mode?: "simple" | "log";
}

/**
 * Ranked-result cache. Re-reading the ~1,200-row grid blob and re-ranking 14
 * factors on every request is the dominant cost here (no per-stock market-data
 * calls). The ranked output is keyed by horizon|mode|window|limit with a short
 * TTL so bursts of requests (mount, horizon toggle, the 1D poll) reuse one
 * computation:
 *   • 1D  : TTL follows the live cadence (30s REGULAR / 5min otherwise) — the
 *           underlying live factor row is itself cached on the same cadence.
 *   • 5D+ : static EOD between daily precomputes; a 5min TTL self-corrects
 *           within minutes of a fresh grid being written.
 * globalThis-singleton so Next.js dev's separate route bundles share one Map
 * (same pattern as the Prisma client).
 */
const TOP_MOVERS_TTL_REGULAR_MS = 30_000;
const TOP_MOVERS_TTL_OFFHOURS_MS = 5 * 60_000;

interface TopMoversCacheEntry {
  at: number;
  ttl: number;
  result: FactorTopMoversResult;
}

const globalForTopMovers = globalThis as unknown as {
  __factorTopMoversCache?: Map<string, TopMoversCacheEntry>;
};

const topMoversCache: Map<string, TopMoversCacheEntry> =
  globalForTopMovers.__factorTopMoversCache ?? new Map();

if (process.env.NODE_ENV !== "production") {
  globalForTopMovers.__factorTopMoversCache = topMoversCache;
}

/** Reset the ranked-result cache. Test-only / invalidation hook. */
export function _resetFactorTopMoversCache(): void {
  topMoversCache.clear();
}

export async function getFactorTopMovers(
  params: FactorTopMoversParams,
): Promise<FactorTopMoversResult> {
  const { horizon } = params;
  const window = params.window ?? 252;
  const limit = params.limit ?? 20;
  const mode = params.mode ?? "log";

  const cacheKey = `${horizon}|${mode}|${window}|${limit}`;
  const now = Date.now();
  const hit = topMoversCache.get(cacheKey);
  if (hit && now - hit.at < hit.ttl) {
    return hit.result;
  }

  const grid = await readPerStockGridCache("MACRO14", window);
  if (!grid) {
    return {
      horizon,
      window,
      mode,
      asOf: null,
      live: false,
      session: null,
      factors: [],
    };
  }

  // Live factor row only for the 1D horizon (today's bar). Graceful fallback
  // to the cached at-close slice when Yahoo is unavailable.
  const liveRow = horizon === "D1" ? await getLiveFactorRow().catch(() => null) : null;
  const live = liveRow != null;

  // Factor's own return over the horizon — drives ordering and the panel
  // subtitle. Live returns for 1D; the EOD performance map otherwise.
  const factorReturnByCode = new Map<FactorCode, number | null>();
  if (live && liveRow) {
    for (const code of grid.usableFactors) {
      const r = liveRow.returns[code];
      factorReturnByCode.set(code, r != null && Number.isFinite(r) ? r : null);
    }
  } else {
    const perf = await computeFactorPerformanceMap(db, "RETURN", "SP500");
    const byCode = new Map(perf.rows.map((row) => [row.code, row.cells[horizon]]));
    for (const code of grid.usableFactors) {
      const r = byCode.get(code);
      factorReturnByCode.set(code, r != null && Number.isFinite(r) ? r : null);
    }
  }

  const orderedCodes = [...grid.usableFactors].sort((a, b) => {
    const av = factorReturnByCode.get(a) ?? null;
    const bv = factorReturnByCode.get(b) ?? null;
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });

  const periodLabel = HORIZON_LABEL[horizon] as PeriodLabel;
  const rows = grid.rows.filter((r) => !isExcludedSector(r.sector));

  const useLog = mode === "log";

  const factors: FactorTopMoversFactor[] = orderedCodes.map((code) => {
    const liveFactorReturn = live && liveRow ? liveRow.returns[code] : undefined;
    // Log-space factor return for the live 1D leg (ln(1 + r)); null when out
    // of domain (1 + r <= 0). Mirrors `factorRowLog` in the live-1d route.
    const liveFactorReturnLog =
      useLog && liveFactorReturn != null && Number.isFinite(liveFactorReturn)
        ? logOnePlus(liveFactorReturn)
        : null;
    const entries: FactorTopMoverEntry[] = [];

    for (const r of rows) {
      const cell = r.cells[code];
      if (!cell) continue;

      let value: number | null;
      if (live && liveRow) {
        if (useLog) {
          // β_log × ln(1 + r) — ties to the popup waterfall's log factor bar.
          if (liveFactorReturnLog == null) continue;
          if (cell.betaLog == null || !Number.isFinite(cell.betaLog)) continue;
          value = cell.betaLog * liveFactorReturnLog;
        } else {
          if (liveFactorReturn == null || !Number.isFinite(liveFactorReturn)) continue;
          if (!Number.isFinite(cell.beta)) continue;
          value = cell.beta * liveFactorReturn;
        }
      } else {
        const slice = r.periodSlices?.[periodLabel];
        const v = useLog
          ? slice?.returnByFactorLog?.[code]
          : slice?.returnByFactor?.[code];
        value = v == null ? null : v;
      }

      if (value == null || !Number.isFinite(value)) continue;
      entries.push({
        ticker: r.ticker,
        name: r.name,
        sector: r.sector,
        subTheme: r.subTheme,
        value,
      });
    }

    const split = splitTopMovers(entries, limit);
    return {
      code,
      label: getFactorDef(code).label,
      factorReturn: factorReturnByCode.get(code) ?? null,
      positive: split.positive,
      negative: split.negative,
      range: split.range,
    };
  });

  const result: FactorTopMoversResult = {
    horizon,
    window,
    mode,
    asOf: grid.asOfDate,
    live,
    session: liveRow?.session ?? null,
    factors,
    missingLegs: liveRow?.missingLegs,
  };

  // 1D reflects the live tape (short TTL); 5D+ are static EOD between daily
  // precomputes (longer TTL self-corrects after a fresh grid).
  const ttl =
    horizon === "D1" && getUsMarketSession(new Date(now)) === "REGULAR"
      ? TOP_MOVERS_TTL_REGULAR_MS
      : TOP_MOVERS_TTL_OFFHOURS_MS;
  topMoversCache.set(cacheKey, { at: now, ttl, result });

  return result;
}
