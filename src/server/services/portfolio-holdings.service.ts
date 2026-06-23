/**
 * portfolio-holdings.service — Bloomberg-style Overview holdings dashboard.
 */

import { prisma as db } from "@/infrastructure/db/client";
import {
  fetchYahooPriorSession,
  fetchYahooQuotesWithSparklinePool,
  toYahooSymbol,
  type YahooStripQuote,
} from "@/infrastructure/providers/yahoo-chart-http";
import {
  getPriorSessionSparkline,
} from "./prior-session-sparkline.service";
import { computePctRank } from "@/lib/factors/screener/derived";
import {
  buildCohortStats,
  groupReturnsByKey,
} from "@/lib/holdings/cohort-stats";
import { signedPeriodReturn } from "@/lib/holdings/day-range";
import { getPositions } from "./position.service";
import {
  horizonStartDateIso,
  periodBoundaryIso,
  resolveSector,
} from "./pnl.service";
import { getOrCreateDefaultUniverse } from "./universe.service";

export interface HoldingRow {
  ticker: string;
  name: string;
  shares: number;
  isShort: boolean;
  currentPrice: number;
  marketValue: number;
  sparkline: number[];
  prevDaySparkline: number[];
  sparklineExtended: number[];
  prevClose: number;
  dayOpen: number;
  dayLow: number;
  dayHigh: number;
  sector: string | null;
  subTheme: string | null;
  chg1dPct: number;
  chg5dPct: number;
  chgMtdPct: number;
  chgQtdPct: number;
  chgYtdPct: number;
  sectorPctile: number | null;
  subThemePctile: number | null;
  sectorDist: number[];
  subThemeDist: number[];
}

function isWeekend(): boolean {
  const day = new Date().getDay();
  return day === 0 || day === 6;
}

async function getPriceAt(
  securityId: string,
  date: string,
): Promise<number | null> {
  const row = await db.priceHistory.findFirst({
    where: { securityId, tradeDate: { lte: new Date(date) } },
    orderBy: { tradeDate: "desc" },
  });
  return row ? Number(row.adjClose) : null;
}

/** Batch-load the last two stored closes per security (one DB round-trip). */
async function batchLastTwoPrices(
  securityIds: string[],
): Promise<Map<string, { currentPrice: number; prevClose: number }>> {
  const out = new Map<string, { currentPrice: number; prevClose: number }>();
  if (securityIds.length === 0) return out;

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - 21);

  const rows = await db.priceHistory.findMany({
    where: { securityId: { in: securityIds }, tradeDate: { gte: cutoff } },
    orderBy: { tradeDate: "desc" },
    select: { securityId: true, adjClose: true },
  });

  const counts = new Map<string, number>();
  for (const r of rows) {
    const n = counts.get(r.securityId) ?? 0;
    if (n >= 2) continue;
    counts.set(r.securityId, n + 1);
    const price = Number(r.adjClose);
    const existing = out.get(r.securityId);
    if (!existing) {
      out.set(r.securityId, { currentPrice: price, prevClose: price });
    } else {
      out.set(r.securityId, { ...existing, prevClose: price });
    }
  }
  return out;
}

function isTickerLikeName(name: string, ticker: string): boolean {
  return name.trim().toUpperCase() === ticker.trim().toUpperCase();
}

function resolveHoldingDisplayName(
  ticker: string,
  securityName: string | undefined,
  quote: YahooStripQuote | undefined,
): string {
  // DB-first: the stored name (manual / universe import) is authoritative and
  // survives Yahoo throttling. Fall back to the live name, then the ticker.
  const storedName = securityName?.trim();
  if (storedName && !isTickerLikeName(storedName, ticker)) return storedName;

  const yahooName = quote?.displayName?.trim();
  if (yahooName && !isTickerLikeName(yahooName, ticker)) return yahooName;

  return storedName || yahooName || ticker;
}

function resolveQuote(
  ticker: string,
  quotes: Map<string, YahooStripQuote>,
  stored: { currentPrice: number; prevClose: number } | null,
  weekend: boolean,
): {
  price: number;
  prevClose: number;
  sparkline: number[];
  prevDaySparkline: number[];
  sparklineExtended: number[];
  dayOpen: number;
  dayLow: number;
  dayHigh: number;
} {
  if (weekend && stored) {
    const p = stored.currentPrice;
    const q = quotes.get(toYahooSymbol(ticker));
    return {
      price: p,
      prevClose: stored.prevClose,
      sparkline: q?.intradayCloses ?? [],
      prevDaySparkline: q?.prevDayCloses ?? [],
      sparklineExtended: q?.extendedCloses ?? [],
      dayOpen: q?.dayOpen ?? p,
      dayLow: q?.dayLow ?? p,
      dayHigh: q?.dayHigh ?? p,
    };
  }
  const q = quotes.get(toYahooSymbol(ticker));
  if (q) {
    return {
      price: q.price,
      prevClose: q.prevClose,
      sparkline: q.intradayCloses ?? [],
      prevDaySparkline: q.prevDayCloses ?? [],
      sparklineExtended: q.extendedCloses ?? [],
      dayOpen: q.dayOpen,
      dayLow: q.dayLow,
      dayHigh: q.dayHigh,
    };
  }
  if (stored) {
    const p = stored.currentPrice;
    return {
      price: p,
      prevClose: stored.prevClose,
      sparkline: [],
      prevDaySparkline: [],
      sparklineExtended: [],
      dayOpen: p,
      dayLow: p,
      dayHigh: p,
    };
  }
  return {
    price: 0,
    prevClose: 0,
    sparkline: [],
    prevDaySparkline: [],
    sparklineExtended: [],
    dayOpen: 0,
    dayLow: 0,
    dayHigh: 0,
  };
}

export async function getPortfolioHoldings(
  portfolioId: string,
): Promise<{ rows: HoldingRow[] }> {
  const positions = await getPositions(portfolioId);
  if (!positions.length) return { rows: [] };

  const weekend = isWeekend();
  const portfolioTickers = [...new Set(positions.map((p) => p.ticker))];

  const universe = await getOrCreateDefaultUniverse(db);
  const universeRows = await db.universeConstituent.findMany({
    where: {
      universeId: universe.id,
      security: { isActive: true },
    },
    select: {
      sector: true,
      subTheme: true,
      security: { select: { id: true, ticker: true, sector: true } },
    },
  });

  const universeSecurityIds = universeRows.map((r) => r.security.id);
  const storedBySecId = await batchLastTwoPrices(universeSecurityIds);

  // Live today's sparkline + price only (small `1d` pull). Prior-session
  // sparklines come from the daily cache — see prior-session-sparkline.service.
  const quotes = await fetchYahooQuotesWithSparklinePool(portfolioTickers, {
    concurrency: 3,
    perRequestDelayMs: 350,
  });

  // Prior-session sparklines from the in-memory cache; one-off 5d fallback for
  // tickers missing from the cache (cold start / just-added holding).
  const priorSparkByTicker = new Map<string, number[]>();
  const priorFallbackTickers: string[] = [];
  for (const t of portfolioTickers) {
    const cached = getPriorSessionSparkline(t);
    if (cached && cached.prevDayCloses.length >= 2) {
      priorSparkByTicker.set(t, cached.prevDayCloses);
    } else {
      priorFallbackTickers.push(t);
    }
  }
  if (priorFallbackTickers.length > 0) {
    const fallbacks = await Promise.all(
      priorFallbackTickers.map(async (t) => {
        const prior = await fetchYahooPriorSession(t);
        return prior && prior.prevDayCloses.length >= 2
          ? { t, closes: prior.prevDayCloses }
          : null;
      }),
    );
    for (const fb of fallbacks) {
      if (fb) priorSparkByTicker.set(fb.t, fb.closes);
    }
  }

  const securities = await db.security.findMany({
    where: { ticker: { in: portfolioTickers } },
    select: { id: true, ticker: true, name: true, sector: true },
  });
  const secMap = new Map(securities.map((s) => [s.ticker, s]));

  const universeByTicker = new Map(
    universeRows.map((r) => [r.security.ticker, r]),
  );

  const start5d = horizonStartDateIso("5D");
  const startMtd = periodBoundaryIso("MTD");
  const startQtd = periodBoundaryIso("QTD");
  const startYtd = periodBoundaryIso("YTD");

  // Cohort 1D returns — stored closes for universe; live Yahoo overlays portfolio tickers.
  const cohortEntries: { key: string; subKey: string; chg1dPct: number }[] = [];
  for (const ur of universeRows) {
    const t = ur.security.ticker;
    const stored = storedBySecId.get(ur.security.id) ?? null;
    const q = resolveQuote(t, quotes, stored, weekend);
    const chg1d = signedPeriodReturn(q.price, q.prevClose, false);
    const sector = resolveSector(ur.sector, null, ur.security.sector) ?? "Other";
    const subTheme = ur.subTheme?.trim() || "Other";
    cohortEntries.push({ key: sector, subKey: subTheme, chg1dPct: chg1d });
  }

  const sectorGroups = groupReturnsByKey(
    cohortEntries.map((e) => ({ key: e.key, chg1dPct: e.chg1dPct })),
  );
  const subThemeGroups = groupReturnsByKey(
    cohortEntries.map((e) => ({ key: e.subKey, chg1dPct: e.chg1dPct })),
  );

  const sectorStats = new Map(
    [...sectorGroups.entries()].map(([k, v]) => [k, buildCohortStats(v)]),
  );
  const subThemeStats = new Map(
    [...subThemeGroups.entries()].map(([k, v]) => [k, buildCohortStats(v)]),
  );

  const rows: HoldingRow[] = [];
  const nameUpdates: { id: string; name: string }[] = [];

  for (const pos of positions) {
    const sec = secMap.get(pos.ticker);
    const secId = sec?.id;
    const ur = universeByTicker.get(pos.ticker);

    const [stored, price5d, priceMtd, priceQtd, priceYtd] = await Promise.all([
      secId
        ? Promise.resolve(storedBySecId.get(secId) ?? null)
        : Promise.resolve(null),
      secId ? getPriceAt(secId, start5d) : Promise.resolve(null),
      secId ? getPriceAt(secId, startMtd) : Promise.resolve(null),
      secId ? getPriceAt(secId, startQtd) : Promise.resolve(null),
      secId ? getPriceAt(secId, startYtd) : Promise.resolve(null),
    ]);

    const q = resolveQuote(pos.ticker, quotes, stored, weekend);
    const liveQuote = quotes.get(toYahooSymbol(pos.ticker));
    const displayName = resolveHoldingDisplayName(
      pos.ticker,
      sec?.name ?? pos.name,
      liveQuote,
    );

    if (
      secId &&
      sec &&
      isTickerLikeName(sec.name, pos.ticker) &&
      liveQuote?.displayName &&
      !isTickerLikeName(liveQuote.displayName, pos.ticker)
    ) {
      nameUpdates.push({ id: secId, name: liveQuote.displayName.trim() });
    }

    const prevDaySparkline = priorSparkByTicker.get(pos.ticker) ?? [];
    const sector =
      resolveSector(ur?.sector, pos.sector, sec?.sector) ?? "Other";
    const subTheme = ur?.subTheme?.trim() || "Other";

    const chg1dPct = signedPeriodReturn(q.price, q.prevClose, pos.isShort);
    const chg5dPct = signedPeriodReturn(
      q.price,
      price5d ?? q.price,
      pos.isShort,
    );
    const chgMtdPct = signedPeriodReturn(
      q.price,
      priceMtd ?? q.price,
      pos.isShort,
    );
    const chgQtdPct = signedPeriodReturn(
      q.price,
      priceQtd ?? q.price,
      pos.isShort,
    );
    const chgYtdPct = signedPeriodReturn(
      q.price,
      priceYtd ?? q.price,
      pos.isShort,
    );

    const sectorDist = sectorGroups.get(sector) ?? [];
    const subThemeDist = subThemeGroups.get(subTheme) ?? [];

    rows.push({
      ticker: pos.ticker,
      name: displayName,
      shares: pos.shares,
      isShort: pos.isShort,
      currentPrice: q.price,
      marketValue: Math.abs(pos.shares * q.price),
      sparkline: q.sparkline,
      prevDaySparkline,
      sparklineExtended: q.sparklineExtended,
      prevClose: q.prevClose,
      dayOpen: q.dayOpen,
      dayLow: q.dayLow,
      dayHigh: q.dayHigh,
      sector,
      subTheme,
      chg1dPct,
      chg5dPct,
      chgMtdPct,
      chgQtdPct,
      chgYtdPct,
      sectorPctile: computePctRank(chg1dPct, sectorStats.get(sector) ?? null),
      subThemePctile: computePctRank(
        chg1dPct,
        subThemeStats.get(subTheme) ?? null,
      ),
      sectorDist,
      subThemeDist,
    });
  }

  rows.sort((a, b) => b.chg1dPct - a.chg1dPct);

  if (nameUpdates.length > 0) {
    await Promise.all(
      nameUpdates.map((u) =>
        db.security.update({ where: { id: u.id }, data: { name: u.name } }),
      ),
    );
  }

  return { rows };
}
