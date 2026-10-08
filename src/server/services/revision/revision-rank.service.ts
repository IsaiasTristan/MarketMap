/**
 * Engine 1 — THE rank, computed for one grid week.
 *
 * The rank is a single signal: `ptRevOrthZ`, the matched-panel price-target
 * revision orthogonalized against trailing 4-week return and z-scored against
 * peers. This service is the only place a week's rank is assembled, so the
 * live queue (scored weeks only) and the historical screen-row / signal-lab
 * grid (143 weeks) read an identical definition by construction.
 *
 * Universe = every ticker with a Leg-B weekly reconstruction on that date that
 * is also in the revision reference. The cross-sectional regression always
 * runs over that full universe, so a consumer asking about a subset still gets
 * numbers computed on the whole cross-section.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  resolvePeerGroups,
  type PeerGroup,
} from "@/lib/revision/aggregate";
import { computePtRevOrth } from "@/lib/revision/orthogonalize";
import { rankAndDecile, zScores } from "@/lib/revision/scoring";

export interface RankRef {
  ticker: string;
  companyName: string;
  sector: string | null;
  subsector: string | null;
  marketCap: number | null;
}

export interface RankEntry {
  ticker: string;
  peer: PeerGroup;
  sector: string | null;
  subsector: string | null;
  /** Raw matched-panel PT revision (the pre-orthogonalization input). */
  ptRevisionRecon: number | null;
  ret4w: number | null;
  /** Peer-relative z of the trailing 4w return. */
  pxZ: number | null;
  /** Orthogonalized revision in raw units (pre-z). */
  ptRevOrthRaw: number | null;
  /** THE RANK — peer-relative z of the orthogonalized revision. */
  ptRevOrthZ: number | null;
  /**
   * Universe-scale z of the same residual. The peer z has ~zero mean inside
   * every peer bucket by construction, so group-level analytics (group/idio
   * decomposition, sector aggregates, rotation) need this cross-universe
   * scale instead — same reason the legacy composite kept a global variant.
   */
  ptRevOrthGlobalZ: number | null;
  /** ptRevOrthZ - pxZ. Positive = revisions the price has not paid for yet. */
  gap: number | null;
  /** Decile of ptRevOrthZ across the whole universe this week (10 = strongest). */
  decile: number | null;
  /** Universe rank of ptRevOrthZ, 1 = strongest. */
  rank: number | null;
}

export interface WeekRank {
  snapshotDate: Date;
  entries: RankEntry[];
  byTicker: Map<string, RankEntry>;
  /** This week's cross-sectional loading of revision on trailing return. */
  beta: number | null;
  /** Names in the orthogonalization regression. */
  regressionN: number;
  /** Names that received a rank. */
  rankedN: number;
}

/**
 * Reference taxonomy for the revision universe, keyed by ticker. ACTIVE names
 * only — that is the universe every other Engine-1 job runs on (Leg-B weekly,
 * price grid, signal lab), and the rank has to be computed on exactly the same
 * cross-section or a lab top-25 and a live top-25 stop being the same list.
 */
export async function loadRankRefs(): Promise<Map<string, RankRef>> {
  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { ticker: true, companyName: true, sector: true, subsector: true, marketCap: true },
  });
  return new Map(
    refs.map((r) => [
      r.ticker,
      {
        ticker: r.ticker,
        companyName: r.companyName,
        sector: r.sector,
        subsector: r.subsector,
        marketCap: r.marketCap === null ? null : Number(r.marketCap),
      },
    ]),
  );
}

/**
 * Market cap per ticker. `RevisionReference.marketCap` is populated for only a
 * handful of names (the market-map universe rarely carries one), so the real
 * source is Engine 2's latest weekly fundamental snapshot, with the reference
 * as fallback.
 *
 * NOT point-in-time: Engine 2 only started snapshotting in 2026-06, so
 * historical grid weeks get today's cap. Fine for bucketing a screen into
 * size tranches; not fine for anything that needs the cap AS OF a past week.
 */
export async function loadMarketCaps(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const refs = await prisma.revisionReference.findMany({
    where: { marketCap: { not: null } },
    select: { ticker: true, marketCap: true },
  });
  for (const r of refs) out.set(r.ticker, Number(r.marketCap));

  const latest = await prisma.fundamentalSnapshot.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (latest) {
    const snaps = await prisma.fundamentalSnapshot.findMany({
      where: { snapshotDate: latest.snapshotDate, marketCap: { not: null } },
      select: { ticker: true, marketCap: true },
    });
    for (const s of snaps) out.set(s.ticker, Number(s.marketCap));
  }
  return out;
}

/** Peer-relative z of a value array, bucketed by peer-group key. */
function peerZ(tickers: string[], values: Array<number | null>, keyOf: (t: string) => string) {
  const out = new Map<string, number>();
  const buckets = new Map<string, number[]>();
  tickers.forEach((t, i) => {
    const k = keyOf(t);
    const arr = buckets.get(k);
    if (arr) arr.push(i);
    else buckets.set(k, [i]);
  });
  for (const idxs of buckets.values()) {
    const { z } = zScores(idxs.map((i) => values[i] ?? null));
    for (const [local, zv] of z) out.set(tickers[idxs[local]!]!, zv);
  }
  return out;
}

/** Ranks for many grid weeks, bulk-loaded (one query pair for the whole set). */
export async function computeWeekRanks(
  snapshotDates: Date[],
  refs?: Map<string, RankRef>,
): Promise<WeekRank[]> {
  if (snapshotDates.length === 0) return [];
  const refMap = refs ?? (await loadRankRefs());
  // Peer groups are resolved ONCE over the whole reference universe, not
  // per-week over whoever happens to have a row: the subsector -> sector
  // fallback depends on bucket size, so resolving it per week would make a
  // name's peer group drift with weekly coverage.
  const peers = resolvePeerGroups(
    [...refMap.values()].map((r) => ({ ticker: r.ticker, sector: r.sector, subsector: r.subsector })),
  );

  const [legb, prices] = await Promise.all([
    prisma.revisionLegBWeekly.findMany({
      where: { snapshotDate: { in: snapshotDates } },
      select: { ticker: true, snapshotDate: true, ptRevisionRecon: true },
    }),
    prisma.revisionPriceSnapshot.findMany({
      where: { snapshotDate: { in: snapshotDates } },
      select: { ticker: true, snapshotDate: true, ret4w: true },
    }),
  ]);

  const legbByDate = new Map<number, Array<{ ticker: string; ptRevisionRecon: number | null }>>();
  for (const r of legb) {
    const k = r.snapshotDate.getTime();
    const arr = legbByDate.get(k);
    if (arr) arr.push(r);
    else legbByDate.set(k, [r]);
  }
  const priceByDate = new Map<number, Map<string, number | null>>();
  for (const p of prices) {
    const k = p.snapshotDate.getTime();
    let m = priceByDate.get(k);
    if (!m) {
      m = new Map();
      priceByDate.set(k, m);
    }
    m.set(p.ticker, p.ret4w);
  }

  return snapshotDates.map((d) =>
    buildWeekRank(
      d,
      legbByDate.get(d.getTime()) ?? [],
      priceByDate.get(d.getTime()) ?? new Map(),
      refMap,
      peers,
    ),
  );
}

export async function computeWeekRank(
  snapshotDate: Date,
  refs?: Map<string, RankRef>,
): Promise<WeekRank> {
  const [week] = await computeWeekRanks([snapshotDate], refs);
  return week!;
}

function buildWeekRank(
  snapshotDate: Date,
  legb: Array<{ ticker: string; ptRevisionRecon: number | null }>,
  ret4wByTicker: Map<string, number | null>,
  refMap: Map<string, RankRef>,
  peers: Map<string, PeerGroup>,
): WeekRank {
  const universe = legb.filter((r) => refMap.has(r.ticker));
  const tickers = universe.map((r) => r.ticker);
  const peerKeyOf = (t: string) => peers.get(t)?.peerGroupKey ?? "Unclassified";

  const orth = computePtRevOrth(
    universe.map((r) => ({
      ticker: r.ticker,
      ptRevisionRecon: r.ptRevisionRecon,
      ret4w: ret4wByTicker.get(r.ticker) ?? null,
    })),
    new Map(tickers.map((t) => [t, peerKeyOf(t)])),
  );

  const pxZByTicker = peerZ(
    tickers,
    tickers.map((t) => ret4wByTicker.get(t) ?? null),
    peerKeyOf,
  );
  const { z: globalZ } = zScores(tickers.map((t) => orth.byTicker.get(t)?.raw ?? null));

  const zArr = tickers.map((t) => orth.byTicker.get(t)?.z ?? null);
  const decileByIdx = new Map<number, { rank: number; decile: number }>();
  for (const e of rankAndDecile(zArr)) decileByIdx.set(e.index, { rank: e.rank, decile: e.decile });

  const entries: RankEntry[] = tickers.map((ticker, i) => {
    const o = orth.byTicker.get(ticker)!;
    const px = pxZByTicker.get(ticker) ?? null;
    const rd = decileByIdx.get(i);
    return {
      ticker,
      peer: peers.get(ticker) ?? {
        ticker,
        peerGroupType: "SECTOR",
        peerGroupKey: peerKeyOf(ticker),
      },
      sector: refMap.get(ticker)?.sector ?? null,
      subsector: refMap.get(ticker)?.subsector ?? null,
      ptRevisionRecon: universe[i]!.ptRevisionRecon,
      ret4w: ret4wByTicker.get(ticker) ?? null,
      pxZ: px,
      ptRevOrthRaw: o.raw,
      ptRevOrthZ: o.z,
      ptRevOrthGlobalZ: globalZ.get(i) ?? null,
      gap: o.z !== null && px !== null ? o.z - px : null,
      decile: rd?.decile ?? null,
      rank: rd?.rank ?? null,
    };
  });

  return {
    snapshotDate,
    entries,
    byTicker: new Map(entries.map((e) => [e.ticker, e])),
    beta: orth.beta,
    regressionN: orth.regressionN,
    rankedN: entries.filter((e) => e.ptRevOrthZ !== null).length,
  };
}
