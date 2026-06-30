/**
 * Engine 2 — read side. Shapes stored snapshots/scores into the payloads the
 * Fundamentals UI consumes (discovery queue, per-name diligence, and the
 * Engine 1 x Engine 2 overlap). The discovery-queue payload already carries the
 * per-name fields the dumbbell / quality-value / accruals / compounder views
 * need, so those are projections of a single cached read. No mutation.
 */
import { prisma } from "@/infrastructure/db/client";
import { getOrCreateDefaultUniverse } from "@/server/services/universe.service";
import {
  readMarketMapCache,
  computeAndCacheMarketMap,
} from "@/server/services/market-map-cache.service";
import {
  getCompanyNamesByTicker,
  pickDisplayName,
} from "@/server/services/security-name.service";
import { HORIZON_ORDER, type Horizon } from "@/domain/entities/horizons";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function dec(v: { toString(): string } | null): number | null {
  return v === null ? null : Number(v);
}

export interface DiscoveryQueuePayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: Array<Record<string, unknown>>;
}

/**
 * Per-ticker total-return cells (D1..Y1) keyed by ticker, sourced from the
 * cached market-map grid (RETURN is benchmark-independent total return). Used
 * to enrich discovery rows without recomputing prices. Empty map if no cache.
 */
async function loadReturnsByTicker(): Promise<Map<string, Record<Horizon, number | null>>> {
  const byTicker = new Map<string, Record<Horizon, number | null>>();
  try {
    const universe = await getOrCreateDefaultUniverse(prisma);
    // Read-first; on a cold miss compute + cache so the columns populate (and
    // the market-map page is warmed) instead of rendering dashes.
    const mm =
      (await readMarketMapCache(universe.id, "RETURN", "SP500")) ??
      (await computeAndCacheMarketMap(universe.id, "RETURN", "SP500"));
    if (!mm) return byTicker;
    for (const row of mm.rows) {
      const ticker = (row.ticker ?? row.key)?.toUpperCase();
      if (!ticker) continue;
      const cells = {} as Record<Horizon, number | null>;
      for (const h of HORIZON_ORDER) cells[h] = row.cells?.[h] ?? null;
      byTicker.set(ticker, cells);
    }
  } catch {
    // Market-map cache unavailable — discovery still renders without returns.
  }
  return byTicker;
}

function attachReturns(
  rows: Array<Record<string, unknown>>,
  returnsByTicker: Map<string, Record<Horizon, number | null>>,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const ticker = typeof r.ticker === "string" ? r.ticker.toUpperCase() : null;
    return { ...r, returns: ticker ? returnsByTicker.get(ticker) ?? null : null };
  });
}

/**
 * Override each row's `companyName` from the live market-map source
 * (`Security.name`) so display names stay consistent with the market map and
 * pick up custom edits immediately. Falls back to the row's baked name then the
 * ticker for any ticker outside the universe.
 */
function attachCompanyNames(
  rows: Array<Record<string, unknown>>,
  namesByTicker: Map<string, string>,
): Array<Record<string, unknown>> {
  return rows.map((r) => {
    const ticker = typeof r.ticker === "string" ? r.ticker : null;
    if (!ticker) return r;
    const baked = typeof r.companyName === "string" ? r.companyName : null;
    return { ...r, companyName: pickDisplayName(namesByTicker, ticker, baked) };
  });
}

/** Latest ranked discovery queue (optionally truncated), enriched with per-name returns + live names. */
export async function getDiscoveryQueue(limit?: number): Promise<DiscoveryQueuePayload | null> {
  const snap = await prisma.discoveryQueueSnapshot.findFirst({ orderBy: { snapshotDate: "desc" } });
  if (!snap) return null;
  const payload = snap.payloadJson as unknown as DiscoveryQueuePayload;
  const rows = Array.isArray(payload.rows)
    ? limit
      ? payload.rows.slice(0, limit)
      : payload.rows
    : [];
  const tickers = rows
    .map((r) => (typeof r.ticker === "string" ? r.ticker : null))
    .filter((t): t is string => t !== null);
  const [returnsByTicker, namesByTicker] = await Promise.all([
    loadReturnsByTicker(),
    getCompanyNamesByTicker(prisma, tickers),
  ]);
  const enriched = attachCompanyNames(attachReturns(rows, returnsByTicker), namesByTicker);
  return { ...payload, rows: enriched };
}

export interface DiligencePayload {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  snapshotDate: string | null;
  latest: {
    revenueTtm: number | null;
    grossMargin: number | null;
    ebitdaMargin: number | null;
    operatingMargin: number | null;
    netMargin: number | null;
    roic: number | null;
    roe: number | null;
    fcfTtm: number | null;
    fcfMargin: number | null;
    revenueGrowthYoy: number | null;
    netDebtToEbitda: number | null;
    accrualsRatio: number | null;
    peRatio: number | null;
    evToEbitda: number | null;
    priceToSales: number | null;
    marketCap: number | null;
    enterpriseValue: number | null;
  };
  score: Record<string, unknown> | null;
  /** Trailing per-period series for the margin-trend chart + valuation history. */
  series: {
    dates: string[];
    ttmGrossMargin: Array<number | null>;
    ttmEbitdaMargin: Array<number | null>;
    ttmNetMargin: Array<number | null>;
    revenueGrowthYoy: Array<number | null>;
    roic: Array<number | null>;
    netDebtToEbitda: Array<number | null>;
    peRatio: Array<number | null>;
    evToEbitda: Array<number | null>;
    priceToSales: Array<number | null>;
  };
}

/** Per-name diligence panel: latest metrics, score detail, and the full series. */
export async function getDiligence(ticker: string): Promise<DiligencePayload | null> {
  const t = ticker.toUpperCase();
  const [snap, score, ref, periods, namesByTicker] = await Promise.all([
    prisma.fundamentalSnapshot.findFirst({ where: { ticker: t }, orderBy: { snapshotDate: "desc" } }),
    prisma.fundamentalScore.findFirst({ where: { ticker: t }, orderBy: { snapshotDate: "desc" } }),
    prisma.revisionReference.findUnique({ where: { ticker: t }, select: { companyName: true, sector: true, subsector: true } }),
    prisma.fundamentalPeriod.findMany({
      where: { ticker: t, periodType: "quarter" },
      orderBy: { fiscalDate: "asc" },
      select: {
        fiscalDate: true,
        grossMargin: true,
        ebitdaMargin: true,
        netMargin: true,
        roic: true,
        netDebtToEbitda: true,
        peRatio: true,
        evToEbitda: true,
        priceToSales: true,
        revenue: true,
      },
    }),
    getCompanyNamesByTicker(prisma, [t]),
  ]);
  if (!snap && periods.length === 0) return null;

  // YoY revenue growth from the per-period revenue (quarterly, 4 back).
  const revs = periods.map((p) => dec(p.revenue));
  const revenueGrowthYoy = revs.map((cur, i) => {
    const prev = revs[i - 4];
    if (cur === null || prev === null || prev === undefined || Math.abs(prev) < 1e-9) return null;
    return cur / prev - 1;
  });

  return {
    ticker: t,
    companyName: pickDisplayName(namesByTicker, t, ref?.companyName ?? null),
    sector: ref?.sector ?? null,
    subsector: ref?.subsector ?? null,
    snapshotDate: snap ? isoOf(snap.snapshotDate) : null,
    latest: {
      revenueTtm: dec(snap?.revenueTtm ?? null),
      grossMargin: snap?.grossMargin ?? null,
      ebitdaMargin: snap?.ebitdaMargin ?? null,
      operatingMargin: snap?.operatingMargin ?? null,
      netMargin: snap?.netMargin ?? null,
      roic: snap?.roic ?? null,
      roe: snap?.roe ?? null,
      fcfTtm: dec(snap?.fcfTtm ?? null),
      fcfMargin: snap?.fcfMargin ?? null,
      revenueGrowthYoy: snap?.revenueGrowthYoy ?? null,
      netDebtToEbitda: snap?.netDebtToEbitda ?? null,
      accrualsRatio: snap?.accrualsRatio ?? null,
      peRatio: dec(snap?.peRatio ?? null),
      evToEbitda: dec(snap?.evToEbitda ?? null),
      priceToSales: dec(snap?.priceToSales ?? null),
      marketCap: dec(snap?.marketCap ?? null),
      enterpriseValue: dec(snap?.enterpriseValue ?? null),
    },
    score: (score?.scoreJson as Record<string, unknown> | undefined) ?? null,
    series: {
      dates: periods.map((p) => isoOf(p.fiscalDate)),
      ttmGrossMargin: periods.map((p) => p.grossMargin),
      ttmEbitdaMargin: periods.map((p) => p.ebitdaMargin),
      ttmNetMargin: periods.map((p) => p.netMargin),
      revenueGrowthYoy,
      roic: periods.map((p) => p.roic),
      netDebtToEbitda: periods.map((p) => p.netDebtToEbitda),
      peRatio: periods.map((p) => p.peRatio),
      evToEbitda: periods.map((p) => p.evToEbitda),
      priceToSales: periods.map((p) => p.priceToSales),
    },
  };
}

