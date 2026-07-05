/**
 * Engine 3 — Fund page read layer (FUNDS Part 4, deep-linkable /flows?tab=funds&fund=<cik>).
 *
 * Assembles a single fund's signal-provenance profile: header + filing-day tell,
 * stat chips (13F AUM, positions, median tenure, turnover, top-10 concentration,
 * clone-alpha STUB), the last 6 qualified initiations with outcomes (incl. failures),
 * the signal profile (follow + exit-lead), led exits with stasis tags, and a reverse
 * index computed from the views' own data. Reuses the follow + exit-lead boards.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import { FUNDS_ATTRIBUTION_CONFIG, type FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";
import { FUND_OVERVIEW_CONFIG } from "@/domain/calculations/fund-overview-config";
import { trailingWindow, windowExcess, WINDOW_QUARTERS, type QuarterReturn } from "@/domain/calculations/return-series";
import { overlapScore, percentileInSet, differentiatedIdeas, type WeightedHolding } from "@/domain/calculations/peer-comparison";
import { resolvePeerSet, type PeerSelector } from "./institutional-peers.service";
import { getFollowScoreboard } from "./institutional-follow.service";
import { getExitLeadBoard } from "./institutional-exit-lead.service";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const DAY = 86_400_000;

function median(vals: number[]): number | null {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Build the ESTIMATED long-book return strip from the precomputed FundReturnSnapshot rows. */
async function computeReturnsBlock(fundId: string, benchmark: string): Promise<FundReturnsBlock | null> {
  const rows = await prisma.fundReturnSnapshot.findMany({
    where: { fundId },
    orderBy: { filingPeriod: "asc" },
    select: {
      filingPeriod: true,
      snapshotReturn: true,
      cloneReturn: true,
      benchReturnSnapshot: true,
      benchReturnClone: true,
      coveragePct: true,
      lowCoverage: true,
      confidence: true,
      contributionsJson: true,
    },
  });
  if (rows.length === 0) return null;
  const snap: QuarterReturn[] = rows.map((r) => ({ period: iso(r.filingPeriod), ret: r.snapshotReturn }));
  const bench: QuarterReturn[] = rows.map((r) => ({ period: iso(r.filingPeriod), ret: r.benchReturnSnapshot }));
  const clone: QuarterReturn[] = rows.map((r) => ({ period: iso(r.filingPeriod), ret: r.cloneReturn }));

  const windows: ReturnWindow[] = (["1Q", "6M", "1Y", "2Y"] as const).map((key) => {
    const q = WINDOW_QUARTERS[key]!;
    const f = trailingWindow(snap, q);
    const b = trailingWindow(bench, q);
    return { key, ret: f.ret, excess: windowExcess(f.ret, b.ret), annualized: f.annualized, insufficient: f.insufficient };
  });

  const latest = rows[rows.length - 1]!;
  const contribs = ((latest.contributionsJson as unknown) as Array<{ ticker: string; contribBps: number }> | null) ?? [];
  const positives = contribs.filter((c) => c.contribBps > 0).sort((a, b) => b.contribBps - a.contribBps).slice(0, 3);
  const negatives = contribs.filter((c) => c.contribBps < 0).sort((a, b) => a.contribBps - b.contribBps).slice(0, 3);

  const clone1Y = trailingWindow(clone, WINDOW_QUARTERS["1Y"]!);
  const snap1Y = windows.find((w) => w.key === "1Y")!;
  const lagCost1Y =
    snap1Y.ret != null && clone1Y.ret != null && !clone1Y.insufficient ? Math.round((snap1Y.ret - clone1Y.ret) * 1e4) / 1e4 : null;

  return {
    asOf: iso(latest.filingPeriod),
    windows,
    confidence: latest.confidence,
    coveragePct: latest.coveragePct,
    lowCoverage: latest.lowCoverage,
    benchmark,
    topContributors: positives.map((c) => ({ ticker: c.ticker, contribBps: c.contribBps })),
    detractors: negatives.map((c) => ({ ticker: c.ticker, contribBps: c.contribBps })),
    cloneReturn1Y: clone1Y.insufficient ? null : clone1Y.ret,
    lagCost1Y,
  };
}

/** VS PEERS: percentiles, overlap, differentiated ideas, twins against the selected set. */
async function computeVsPeers(
  fundId: string,
  category: string,
  period: string,
  periodDate: Date,
  self: WeightedHolding[],
  peerSel?: PeerSelector,
): Promise<FundVsPeersBlock | null> {
  // Resolve the selector; default to the seeded "My Funds" set, else CATEGORY.
  let sel: PeerSelector;
  let peerSetName: string;
  if (peerSel) {
    sel = peerSel;
    peerSetName = peerSel.mode === "CATEGORY" ? `Category: ${category}` : peerSel.mode === "STYLE_TWINS" ? "Style twins" : "peer set";
  } else {
    const def = await prisma.peerSet.findFirst({ where: { isDefault: true }, select: { id: true, name: true } });
    if (def) {
      sel = { mode: "SET", id: def.id };
      peerSetName = def.name;
    } else {
      sel = { mode: "CATEGORY" };
      peerSetName = `Category: ${category}`;
    }
  }
  if (sel.mode === "SET") {
    const s = await prisma.peerSet.findUnique({ where: { id: sel.id }, select: { name: true } });
    if (s) peerSetName = s.name;
  }

  const peerIds = await resolvePeerSet(sel, fundId, period);
  const idSet = [...new Set([fundId, ...peerIds])];
  const nameRows = await prisma.institutionalFund.findMany({ where: { id: { in: idSet } }, select: { id: true, name: true, cik: true } });
  const nameById = new Map(nameRows.map((r) => [r.id, { name: r.name, cik: r.cik }]));

  // Peer + self current-period books (ticker, value) → weighted holdings.
  const holdRows = await prisma.fundHoldingSnapshot.findMany({
    where: { fundId: { in: idSet }, filingPeriod: periodDate, shares: { gt: 0 } },
    select: { fundId: true, ticker: true, value: true },
  });
  const bookByFund = new Map<string, WeightedHolding[]>();
  const totalByFund = new Map<string, number>();
  for (const r of holdRows) totalByFund.set(r.fundId, (totalByFund.get(r.fundId) ?? 0) + Number(r.value));
  for (const r of holdRows) {
    const total = totalByFund.get(r.fundId)!;
    if (!(total > 0)) continue;
    (bookByFund.get(r.fundId) ?? bookByFund.set(r.fundId, []).get(r.fundId)!).push({ ticker: r.ticker, weight: Number(r.value) / total });
  }

  // Overlap (top 5) + differentiated ideas.
  const overlaps = peerIds
    .map((pid) => ({ pid, book: bookByFund.get(pid) ?? [] }))
    .filter((p) => p.book.length > 0)
    .map((p) => ({ cik: nameById.get(p.pid)?.cik ?? null, name: nameById.get(p.pid)?.name ?? "?", overlapPct: overlapScore(self, p.book) }))
    .sort((a, b) => b.overlapPct - a.overlapPct)
    .slice(0, 5);
  const peerBooks = peerIds.map((pid) => bookByFund.get(pid) ?? []).filter((b) => b.length > 0);
  const diffTickers = differentiatedIdeas(self, peerBooks);
  const selfWeightByTicker = new Map(self.map((h) => [h.ticker, h.weight]));
  const differentiated = diffTickers
    .slice(0, 8)
    .map((t) => ({ ticker: t, pctOfBook: Math.round((selfWeightByTicker.get(t) ?? 0) * 1000) / 10 }));

  // Percentiles: est-1Y return, concentration, median tenure, turnover, clone alpha.
  const [summaries, styles, retRows] = await Promise.all([
    prisma.fundReturnSummary.findMany({ where: { fundId: { in: idSet } }, select: { fundId: true, cloneAlpha: true } }),
    prisma.fundStyleVector.findMany({
      where: { fundId: { in: idSet }, filingPeriod: periodDate },
      select: { fundId: true, top10Concentration: true, turnover: true, medianTenure: true },
    }),
    prisma.fundReturnSnapshot.findMany({
      where: { fundId: { in: idSet } },
      orderBy: { filingPeriod: "asc" },
      select: { fundId: true, filingPeriod: true, snapshotReturn: true },
    }),
  ]);
  const cloneAlphaBy = new Map(summaries.map((s) => [s.fundId, s.cloneAlpha]));
  const styleBy = new Map(styles.map((s) => [s.fundId, s]));
  const snapByFund = new Map<string, QuarterReturn[]>();
  for (const r of retRows) (snapByFund.get(r.fundId) ?? snapByFund.set(r.fundId, []).get(r.fundId)!).push({ period: iso(r.filingPeriod), ret: r.snapshotReturn });
  const est1YBy = new Map<string, number | null>();
  for (const [fid, series] of snapByFund) {
    const w = trailingWindow(series, WINDOW_QUARTERS["1Y"]!);
    est1YBy.set(fid, w.insufficient ? null : w.ret);
  }

  const pctMetric = (key: string, valueOf: (id: string) => number | null): PeerPercentile => {
    const vals = idSet.map(valueOf).filter((v): v is number => v != null && Number.isFinite(v));
    const self = valueOf(fundId);
    if (self == null) return { key, percentile: null, tooSmall: vals.length < FUND_OVERVIEW_CONFIG.peer_min_size };
    const r = percentileInSet(self, vals);
    return { key, percentile: r.percentile, tooSmall: r.tooSmall };
  };
  const percentiles: PeerPercentile[] = [
    pctMetric("est. 1Y return", (id) => est1YBy.get(id) ?? null),
    pctMetric("concentration", (id) => styleBy.get(id)?.top10Concentration ?? null),
    pctMetric("median tenure", (id) => styleBy.get(id)?.medianTenure ?? null),
    pctMetric("turnover", (id) => styleBy.get(id)?.turnover ?? null),
    pctMetric("clone alpha", (id) => cloneAlphaBy.get(id) ?? null),
  ];

  // Twins from the fund's precomputed style vector.
  const sv = await prisma.fundStyleVector.findUnique({
    where: { fundId_filingPeriod: { fundId, filingPeriod: periodDate } },
    select: { twinsJson: true },
  });
  const rawTwins = ((sv?.twinsJson as unknown) as Array<{ fundId: string; similarity: number }> | null) ?? [];
  const twinNameRows = await prisma.institutionalFund.findMany({
    where: { id: { in: rawTwins.map((t) => t.fundId) } },
    select: { id: true, name: true, cik: true },
  });
  const twinName = new Map(twinNameRows.map((r) => [r.id, { name: r.name, cik: r.cik }]));
  const twins = rawTwins
    .map((t) => ({ cik: twinName.get(t.fundId)?.cik ?? null, name: twinName.get(t.fundId)?.name ?? "?", similarity: t.similarity }))
    .filter((t) => t.name !== "?");

  return { peerSetName, peerSetSize: peerIds.length, mode: sel.mode, percentiles, overlaps, differentiatedIdeas: differentiated, twins };
}

export interface FundInitiationOutcome {
  ticker: string;
  period: string;
  sizingMult: number;
  status: string; // followed | not_followed | pending | consensus_at_birth
  followerFunds: number;
  lead: number | null;
  fwd2q: number | null;
}

export interface ReturnWindow {
  key: string; // 1Q | 6M | 1Y | 2Y
  ret: number | null; // fraction; annualized for 2Y
  excess: number | null; // vs benchmark, same basis
  annualized: boolean;
  insufficient: boolean;
}
export interface FundReturnsBlock {
  asOf: string; // latest return quarter
  windows: ReturnWindow[];
  confidence: string | null;
  coveragePct: number | null;
  lowCoverage: boolean;
  benchmark: string;
  topContributors: Array<{ ticker: string; contribBps: number }>;
  detractors: Array<{ ticker: string; contribBps: number }>;
  cloneReturn1Y: number | null; // clone (filing-date entry) 1Y
  lagCost1Y: number | null; // snapshot 1Y − clone 1Y (fraction; the disclosure-lag cost)
}
export interface PeerPercentile {
  key: string;
  percentile: number | null;
  tooSmall: boolean;
}
export interface FundVsPeersBlock {
  peerSetName: string;
  peerSetSize: number;
  mode: string; // SET | CATEGORY | STYLE_TWINS
  percentiles: PeerPercentile[];
  overlaps: Array<{ cik: string | null; name: string; overlapPct: number }>;
  differentiatedIdeas: Array<{ ticker: string; pctOfBook: number }>;
  twins: Array<{ cik: string | null; name: string; similarity: number }>;
}

export interface FundPagePayload {
  cik: string;
  fundId: string;
  name: string;
  category: string;
  isElite: boolean;
  filingPeriod: string;
  /** "filed on day N of 45" — filingDate − period_end, in days. Null if unknown. */
  filingDayTell: number | null;
  stats: {
    aum13fUsd: number | null;
    positions: number | null;
    medianTenure: number | null;
    medianTenureCensored: boolean;
    turnover: number | null;
    top10ConcentrationPct: number | null;
    /** Effective number of positions = 1 / HHI of position weights. */
    effPositions: number | null;
    /** Annualized clone-alpha vs the benchmark (Fund Overview Part 1); null = insufficient. */
    cloneAlpha: number | null;
    cloneAlphaQuarters: number;
  };
  /** ESTIMATED long-book return strip (Fund Overview Part 1); null until the returns
   *  engine has ≥1 completed quarter for this fund. */
  returns: FundReturnsBlock | null;
  /** VS PEERS (Fund Overview Part 2) against the selected peer set. */
  vsPeers: FundVsPeersBlock | null;
  signalProfile: {
    followRate: number | null;
    followN: number;
    medianLead: number | null;
    fwd2q: number | null;
    hitRate2q: number | null;
    bestSector: string | null;
    bestSectorRate: number | null;
    exitLeadRate: number | null;
    exitLeadN: number;
    rateSufficient: boolean;
  };
  recentInitiations: FundInitiationOutcome[];
  ledExits: Array<{ ticker: string; quarter: string; clusterQuarter: string; isStasisBreak: boolean }>;
  reverseIndex: { freshCalls: number; ledExits: number; qualifiedInitiations: number };
}

export async function getFundPage(
  cik: string,
  config: FundsAttributionConfig = FUNDS_ATTRIBUTION_CONFIG,
  peerSel?: PeerSelector,
): Promise<FundPagePayload | null> {
  const normCik = cik.replace(/\D/g, "").padStart(10, "0");
  const fund = await prisma.institutionalFund.findUnique({
    where: { cik: normCik },
    select: { id: true, cik: true, name: true, category: true, isMostRespected: true },
  });
  if (!fund) return null;

  const [sb, xb] = await Promise.all([getFollowScoreboard(config), getExitLeadBoard(config)]);
  if (!sb) return null;
  const filingPeriod = sb.filingPeriod;
  const periodDate = new Date(`${filingPeriod}T00:00:00.000Z`);

  // ── Book / positions / tenure / concentration + filing-day tell (latest quarter). ──
  const [book, holdings, latestFiling] = await Promise.all([
    prisma.fundBookSnapshot.findUnique({ where: { fundId_filingPeriod: { fundId: fund.id, filingPeriod: periodDate } } }),
    prisma.fundHoldingSnapshot.findMany({
      where: { fundId: fund.id, filingPeriod: periodDate, shares: { gt: 0 } },
      select: { ticker: true, value: true, pctOfBook: true, tenureQuarters: true, tenureCensored: true, filingDate: true },
    }),
    prisma.fundHoldingSnapshot.findFirst({
      where: { fundId: fund.id, filingPeriod: periodDate, filingDate: { not: null } },
      select: { filingDate: true },
    }),
  ]);

  const pcts = holdings.map((h) => h.pctOfBook ?? 0).sort((a, b) => b - a);
  const top10 = pcts.slice(0, 10).reduce((a, b) => a + b, 0);
  const tenures = holdings.map((h) => h.tenureQuarters ?? 0).filter((t) => t > 0);
  const censoredFrac = holdings.length ? holdings.filter((h) => h.tenureCensored).length / holdings.length : 0;
  const filingDayTell =
    latestFiling?.filingDate != null ? Math.round((latestFiling.filingDate.getTime() - periodDate.getTime()) / DAY) : null;

  // ── Attribution stats from the boards. ──
  const followRow = sb.rows.find((r) => r.fundId === fund.id);
  const exitRow = xb?.rows.find((r) => r.fundId === fund.id);
  const outcomes = (sb.outcomesByFund.get(fund.id) ?? []).slice().sort((a, b) => b.quarter - a.quarter);
  const fwdByKey = new Map(sb.initiations.map((i) => [`${i.ticker}|${i.quarter}`, i.fwd2q ?? null]));

  // Most recent meaningful outcomes (fresh + resolved), excluding consensus-at-birth
  // (nobody led) so the list reads like the mockup: a mix of fresh calls and hits/misses.
  const recentInitiations: FundInitiationOutcome[] = outcomes
    .filter((o) => o.status !== "consensus_at_birth")
    .slice(0, 6)
    .map((o) => ({
    ticker: o.ticker,
    period: sb.periods[o.quarter] ?? "",
    sizingMult: o.strength,
    status: o.status,
    followerFunds: o.followerFunds,
    lead: o.lead,
    fwd2q: fwdByKey.get(`${o.ticker}|${o.quarter}`) ?? null,
  }));

  const freshCallsCount = outcomes.filter((o) => o.status === "pending" && o.followerFunds === 0).length;

  // ── Effective positions (1/HHI) + this fund's weighted current book. ──
  const selfTotalVal = holdings.reduce((a, h) => a + Number(h.value), 0);
  const selfWeighted: WeightedHolding[] = selfTotalVal > 0
    ? holdings.map((h) => ({ ticker: h.ticker, weight: Number(h.value) / selfTotalVal }))
    : [];
  const hhi = selfWeighted.reduce((a, w) => a + w.weight * w.weight, 0);
  const effPositions = hhi > 0 ? Math.round((1 / hhi) * 10) / 10 : null;

  // ── Returns strip (Fund Overview Part 1) + real clone alpha. ──
  const summary = await prisma.fundReturnSummary.findUnique({ where: { fundId: fund.id } });
  const returns = await computeReturnsBlock(fund.id, summary?.benchmark ?? FUND_OVERVIEW_CONFIG.benchmark_symbol);

  // ── VS PEERS (Fund Overview Part 2). ──
  const vsPeers = await computeVsPeers(fund.id, fund.category, filingPeriod, periodDate, selfWeighted, peerSel);

  return {
    cik: fund.cik,
    fundId: fund.id,
    name: fund.name,
    category: fund.category,
    isElite: fund.isMostRespected,
    filingPeriod,
    filingDayTell,
    stats: {
      aum13fUsd: book?.marketValue != null ? Number(book.marketValue) : null,
      positions: book?.portfolioSize ?? holdings.length,
      medianTenure: median(tenures),
      medianTenureCensored: censoredFrac > 0.3,
      turnover: book?.turnover ?? null,
      top10ConcentrationPct: pcts.length ? Math.round(top10 * 10) / 10 : null,
      effPositions,
      cloneAlpha: summary?.cloneAlpha ?? null,
      cloneAlphaQuarters: summary?.cloneAlphaQuarters ?? 0,
    },
    returns,
    vsPeers,
    signalProfile: {
      followRate: followRow?.followRate ?? null,
      followN: followRow?.n ?? 0,
      medianLead: followRow?.medianLead ?? null,
      fwd2q: followRow?.fwd2q ?? null,
      hitRate2q: followRow?.hitRate2q ?? null,
      bestSector: followRow?.bestSector ?? null,
      bestSectorRate: followRow?.bestSectorRate ?? null,
      exitLeadRate: exitRow?.exitLeadRate ?? null,
      exitLeadN: exitRow?.n ?? 0,
      rateSufficient: followRow?.rateSufficient ?? false,
    },
    recentInitiations,
    ledExits: (exitRow?.ledEpisodes ?? []).slice(0, 8),
    reverseIndex: {
      freshCalls: freshCallsCount,
      ledExits: exitRow?.led ?? 0,
      qualifiedInitiations: outcomes.length,
    },
  };
}
