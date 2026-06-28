/**
 * Engine 2 — read side. Shapes stored snapshots/scores into the payloads the
 * Fundamentals UI consumes (discovery queue, per-name diligence, and the
 * Engine 1 x Engine 2 overlap). The discovery-queue payload already carries the
 * per-name fields the dumbbell / quality-value / accruals / compounder views
 * need, so those are projections of a single cached read. No mutation.
 */
import { prisma } from "@/infrastructure/db/client";
import { getOrCreateDefaultUniverse } from "@/server/services/universe.service";
import { readMarketMapCache } from "@/server/services/market-map-cache.service";
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
    const mm = await readMarketMapCache(universe.id, "RETURN", "SP500");
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

/** Latest ranked discovery queue (optionally truncated), enriched with per-name returns. */
export async function getDiscoveryQueue(limit?: number): Promise<DiscoveryQueuePayload | null> {
  const snap = await prisma.discoveryQueueSnapshot.findFirst({ orderBy: { snapshotDate: "desc" } });
  if (!snap) return null;
  const payload = snap.payloadJson as unknown as DiscoveryQueuePayload;
  const returnsByTicker = await loadReturnsByTicker();
  const rows = Array.isArray(payload.rows)
    ? limit
      ? payload.rows.slice(0, limit)
      : payload.rows
    : [];
  return { ...payload, rows: attachReturns(rows, returnsByTicker) };
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
  const [snap, score, ref, periods] = await Promise.all([
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
    companyName: ref?.companyName ?? null,
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

export interface OverlapRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  fundamentalComposite: number | null;
  fundamentalRank: number | null;
  fundamentalDecile: number | null;
  revisionComposite: number | null;
  revisionRank: number | null;
  revisionDecile: number | null;
  trapFlag: boolean;
  bothFlagged: boolean;
}

export interface OverlapPayload {
  fundamentalDate: string | null;
  revisionDate: string | null;
  rows: OverlapRow[];
}

/**
 * Highest-conviction overlap: join the latest FundamentalScore with the latest
 * RevisionScore (Engine 1) on ticker. `bothFlagged` = top-decile on both engines.
 */
export async function getOverlap(topDecile = 8): Promise<OverlapPayload> {
  const [fDate, rDate] = await Promise.all([
    prisma.fundamentalScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } }),
    prisma.revisionScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } }),
  ]);
  if (!fDate) return { fundamentalDate: null, revisionDate: rDate ? isoOf(rDate.snapshotDate) : null, rows: [] };

  const [fScores, rScores] = await Promise.all([
    prisma.fundamentalScore.findMany({ where: { snapshotDate: fDate.snapshotDate } }),
    rDate
      ? prisma.revisionScore.findMany({ where: { snapshotDate: rDate.snapshotDate } })
      : Promise.resolve([]),
  ]);
  const rByTicker = new Map(rScores.map((r) => [r.ticker, r]));
  const tickers = fScores.map((f) => f.ticker);
  const refs = await prisma.revisionReference.findMany({
    where: { ticker: { in: tickers } },
    select: { ticker: true, companyName: true, sector: true, subsector: true },
  });
  const refByTicker = new Map(refs.map((r) => [r.ticker, r]));

  const rows: OverlapRow[] = fScores.map((f) => {
    const r = rByTicker.get(f.ticker);
    const fDecile = f.subsectorDecile ?? f.sectorDecile ?? null;
    const rDecile = r?.subsectorDecile ?? r?.sectorDecile ?? null;
    const ref = refByTicker.get(f.ticker);
    return {
      ticker: f.ticker,
      companyName: ref?.companyName ?? null,
      sector: ref?.sector ?? null,
      subsector: ref?.subsector ?? null,
      fundamentalComposite: f.composite,
      fundamentalRank: f.rank,
      fundamentalDecile: fDecile,
      revisionComposite: r?.composite ?? null,
      revisionRank: r?.rank ?? null,
      revisionDecile: rDecile,
      trapFlag: f.trapFlag,
      bothFlagged: (fDecile ?? 0) >= topDecile && (rDecile ?? 0) >= topDecile && !f.trapFlag,
    };
  });
  rows.sort((a, b) => {
    if (a.bothFlagged !== b.bothFlagged) return a.bothFlagged ? -1 : 1;
    return (b.fundamentalComposite ?? -Infinity) - (a.fundamentalComposite ?? -Infinity);
  });

  return {
    fundamentalDate: isoOf(fDate.snapshotDate),
    revisionDate: rDate ? isoOf(rDate.snapshotDate) : null,
    rows,
  };
}
