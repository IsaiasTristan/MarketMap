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

export interface FundInitiationOutcome {
  ticker: string;
  period: string;
  sizingMult: number;
  status: string; // followed | not_followed | pending | consensus_at_birth
  followerFunds: number;
  lead: number | null;
  fwd2q: number | null;
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
    /** STUB — pending the returns-engine clone-alpha ingredient. */
    cloneAlpha: null;
  };
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
      select: { pctOfBook: true, tenureQuarters: true, tenureCensored: true, filingDate: true },
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
      cloneAlpha: null, // TODO(returns-engine): clone-alpha stat
    },
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
