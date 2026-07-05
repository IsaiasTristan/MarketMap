/**
 * Engine 3 — Exit-lead attribution read layer (FUNDS Part 2).
 *
 * Builds qualified trim/exit events (material, qualified-size positions per the
 * sizing framework, with a stasis-break tag from persisted tenure) and exit-cluster
 * occurrences across ALL quarters (mirrors getExitClusters: ≥3 high-conviction
 * holders trimming/exiting in one quarter), then runs the pure
 * computeExitLeadAttribution core. No heavy compute beyond the single holdings load.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import {
  computeExitLeadAttribution,
  isQualifiedTrimForProvenance,
  type QualifiedTrim,
  type ExitClusterOccurrence,
  type ExitLeadOutcome,
} from "@/domain/calculations/exit-lead-attribution";
import { tenureMult, CORE_HOLDINGS_CONFIG } from "@/domain/calculations/core-holdings";
import { FUNDS_ATTRIBUTION_CONFIG, type FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const HIGH_CONVICTION_PCT = 1; // matches getExitClusters — a "real" position (% of book)
const EXIT_CLUSTER_MIN = 3;

interface HoldRow {
  fundId: string;
  ticker: string;
  period: string;
  pct: number | null;
  shares: number;
  prevShares: number | null;
  action: string;
  tenure: number | null;
  elite: boolean;
}

function median(vals: number[]): number {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export interface ExitLeadRow {
  fundId: string;
  cik: string;
  name: string;
  category: string;
  isElite: boolean;
  n: number;
  led: number;
  exitLeadRate: number | null;
  stasisLed: number;
  rateSufficient: boolean;
  /** Led episodes for the fund page ("led exits — trims that preceded clusters"). */
  ledEpisodes: Array<{ ticker: string; quarter: string; clusterQuarter: string; isStasisBreak: boolean }>;
}

export interface ExitLeadBoard {
  filingPeriod: string;
  rows: ExitLeadRow[];
  outcomesByFund: Map<string, ExitLeadOutcome[]>;
}

export async function getExitLeadBoard(
  config: FundsAttributionConfig = FUNDS_ATTRIBUTION_CONFIG,
): Promise<ExitLeadBoard | null> {
  const periodRows = await prisma.institutionalNameAggregate.findMany({
    distinct: ["filingPeriod"],
    select: { filingPeriod: true },
    orderBy: { filingPeriod: "asc" },
  });
  const periods = periodRows.map((r) => iso(r.filingPeriod));
  if (!periods.length) return null;
  const periodIdx = new Map(periods.map((p, i) => [p, i]));
  const asOf = periods.length - 1;

  const raw = await prisma.$queryRaw<Array<Omit<HoldRow, "period"> & { period: Date }>>(Prisma.sql`
    SELECT h."fundId" AS "fundId", h.ticker, h."filingPeriod" AS period, h."pctOfBook" AS pct,
           h.shares::float8 AS shares, h."prevShares"::float8 AS "prevShares", h.action::text AS action,
           h."tenureQuarters" AS tenure, f."isMostRespected" AS elite
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'`);
  const rows: HoldRow[] = raw.map((r) => ({ ...r, period: iso(r.period) }));

  // Index by (fund|ticker|period) + per-fund-period book (pct + tenure) for medians.
  const byKey = new Map<string, HoldRow>();
  const fundBookPct = new Map<string, number[]>(); // `${fund}|${period}` → held pcts
  const fundBookTenure = new Map<string, number[]>();
  for (const r of rows) {
    byKey.set(`${r.fundId}|${r.ticker}|${r.period}`, r);
    if (r.shares > 0) {
      const bk = `${r.fundId}|${r.period}`;
      if (r.pct != null) (fundBookPct.get(bk) ?? fundBookPct.set(bk, []).get(bk)!).push(r.pct);
      if (r.tenure != null) (fundBookTenure.get(bk) ?? fundBookTenure.set(bk, []).get(bk)!).push(r.tenure);
    }
  }

  const trims: QualifiedTrim[] = [];
  const clusterCount = new Map<string, number>(); // `${ticker}|${period}` → conviction-exit count

  for (const r of rows) {
    if (r.action !== "TRIMMED" && r.action !== "EXITED") continue;
    const qi = periodIdx.get(r.period);
    if (qi == null || qi === 0) continue; // need a prior quarter
    const priorP = periods[qi - 1]!;
    const prior = byKey.get(`${r.fundId}|${r.ticker}|${priorP}`);
    if (!prior || prior.pct == null) continue; // can't assess prior materiality
    const priorPct = prior.pct;
    const exited = r.action === "EXITED" || r.shares <= 0;

    // Exit-cluster tally (mirrors getExitClusters): prior high-conviction holder that trimmed/exited.
    if (priorPct >= HIGH_CONVICTION_PCT || r.elite) {
      const ck = `${r.ticker}|${r.period}`;
      clusterCount.set(ck, (clusterCount.get(ck) ?? 0) + 1);
    }

    const reductionPct = prior.shares > 0 ? ((prior.shares - r.shares) / prior.shares) * 100 : exited ? 100 : 0;
    const fundMedianPct = median(fundBookPct.get(`${r.fundId}|${priorP}`) ?? []);
    if (!isQualifiedTrimForProvenance(priorPct, fundMedianPct, reductionPct, exited, config)) continue;

    // Stasis-break: departing fund's tenure_mult ≥ long_hold_mult at the prior quarter.
    const priorTenure = prior.tenure ?? 0;
    const fundMedianTenure = median(fundBookTenure.get(`${r.fundId}|${priorP}`) ?? []);
    const isStasisBreak = tenureMult(priorTenure, fundMedianTenure) >= CORE_HOLDINGS_CONFIG.long_hold_mult;

    trims.push({ fundId: r.fundId, ticker: r.ticker, quarter: qi, isStasisBreak });
  }

  const clusters: ExitClusterOccurrence[] = [];
  for (const [key, count] of clusterCount) {
    if (count < EXIT_CLUSTER_MIN) continue;
    const [ticker, period] = key.split("|");
    const qi = periodIdx.get(period!);
    if (qi != null) clusters.push({ ticker: ticker!, quarter: qi });
  }

  const attr = computeExitLeadAttribution(trims, clusters, config, asOf);

  const windowStart = asOf - config.stat_window + 1;
  const outcomesByFund = new Map<string, ExitLeadOutcome[]>();
  for (const o of attr.outcomes) {
    if (o.quarter < windowStart) continue;
    (outcomesByFund.get(o.fundId) ?? outcomesByFund.set(o.fundId, []).get(o.fundId)!).push(o);
  }

  const fundIds = attr.funds.map((f) => f.fundId);
  const meta = await prisma.institutionalFund.findMany({
    where: { id: { in: fundIds } },
    select: { id: true, cik: true, name: true, category: true, isMostRespected: true },
  });
  const metaById = new Map(meta.map((m) => [m.id, m]));

  const rowsOut: ExitLeadRow[] = attr.funds
    .map((f): ExitLeadRow | null => {
      const m = metaById.get(f.fundId);
      if (!m) return null;
      const led = (outcomesByFund.get(f.fundId) ?? [])
        .filter((o) => o.status === "exit_led" && o.clusterQuarter != null)
        .map((o) => ({ ticker: o.ticker, quarter: periods[o.quarter]!, clusterQuarter: periods[o.clusterQuarter!]!, isStasisBreak: o.isStasisBreak }));
      return {
        fundId: f.fundId,
        cik: m.cik,
        name: m.name,
        category: m.category,
        isElite: m.isMostRespected,
        n: f.n,
        led: f.led,
        exitLeadRate: f.exitLeadRate,
        stasisLed: f.stasisLed,
        rateSufficient: f.rateSufficient,
        ledEpisodes: led,
      };
    })
    .filter((r): r is ExitLeadRow => r !== null)
    .sort((a, b) => {
      if (a.rateSufficient !== b.rateSufficient) return a.rateSufficient ? -1 : 1;
      return (b.exitLeadRate ?? -1) - (a.exitLeadRate ?? -1) || b.n - a.n || a.name.localeCompare(b.name);
    });

  return { filingPeriod: periods[asOf]!, rows: rowsOut, outcomesByFund };
}
