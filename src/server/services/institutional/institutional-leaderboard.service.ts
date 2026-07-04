/**
 * Engine 3 — Flow Leaderboard read layer (thin loader over the pure core).
 *
 * Assembles TickerIngredients from the precomputed ingredients (per-fund columns
 * on FundHoldingSnapshot + per-name netflowBps / marketCapUsd on the name
 * aggregate) and calls computeLeaderboard. NO external calls and no heavy compute
 * at read time — everything config-independent was precomputed by the job. Results
 * are cached in-process keyed (period, config_hash, ingredients_version) so a
 * precompute (which bumps the version) invalidates them.
 */
import { prisma } from "@/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import {
  computeLeaderboard,
  type Leaderboard,
  type PositionStatus,
  type QuarterIngredient,
  type TickerIngredients,
  type FundPosition,
} from "@/domain/calculations/flow-leaderboard";
import { FLOW_LEADERBOARD_CONFIG, type FlowLeaderboardConfig } from "@/domain/calculations/flow-leaderboard-config";
import { signalFundFilter } from "./institutional-aggregate.service";
import { getIngredientsVersion } from "./institutional-ingredients.service";

const iso = (d: Date): string => d.toISOString().slice(0, 10);

/** Quarters of history to load: lookback + 5-cell display strip + a prior for
 *  relflow/streak context. Generous so streaks longer than the display resolve. */
const WINDOW = Math.max(FLOW_LEADERBOARD_CONFIG.lookback_quarters + 2, 8);

const STATUS: Record<string, PositionStatus> = {
  NEW: "new",
  ADDED: "added",
  HELD: "held",
  TRIMMED: "trimmed",
  EXITED: "exited",
};

export interface LeaderboardResult extends Leaderboard {
  filingPeriod: string;
  ingredientsVersion: number;
}

// Small in-process cache. Key-based invalidation only (TTL irrelevant).
const cache = new Map<string, LeaderboardResult>();

function configHash(config: FlowLeaderboardConfig): string {
  return JSON.stringify(config);
}

export async function getLeaderboard(period?: string, config: FlowLeaderboardConfig = FLOW_LEADERBOARD_CONFIG): Promise<LeaderboardResult | null> {
  // Resolve the target period (latest with aggregates if unspecified).
  const latest = await prisma.institutionalNameAggregate.findFirst({ orderBy: { filingPeriod: "desc" }, select: { filingPeriod: true } });
  if (!latest) return null;
  const target = period ?? iso(latest.filingPeriod);

  const version = await getIngredientsVersion();
  const key = `${target}|${version}|${configHash(config)}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // The window of periods up to and including `target`.
  const allPeriods = (
    await prisma.institutionalNameAggregate.findMany({ distinct: ["filingPeriod"], select: { filingPeriod: true }, orderBy: { filingPeriod: "asc" } })
  ).map((r) => iso(r.filingPeriod));
  const targetIdx = allPeriods.indexOf(target);
  if (targetIdx < 0) return null;
  const windowPeriods = allPeriods.slice(Math.max(0, targetIdx - WINDOW + 1), targetIdx + 1);
  const windowSet = new Set(windowPeriods);
  const dateList = windowPeriods.map((p) => new Date(`${p}T00:00:00.000Z`));
  // Raw-SQL date binding: Prisma serializes JS Date params as timestamptz, which
  // does NOT match a `date` column under a non-UTC session timezone (silently
  // returns zero rows). The typed `findMany` path binds `date` correctly, but the
  // `$queryRaw` blocks below must bind ISO strings cast per-element to `::date`.
  const periodSql = Prisma.join(windowPeriods.map((p) => Prisma.sql`${p}::date`));

  // ── Per-name aggregate rows over the window (holders, conviction, bps, mcap). ──
  const nameRows = await prisma.institutionalNameAggregate.findMany({
    where: { filingPeriod: { in: dateList } },
    select: {
      ticker: true,
      filingPeriod: true,
      companyName: true,
      fundsHolding: true,
      medianPctOfBook: true,
      netflowBps: true,
      marketCapUsd: true,
    },
  });

  // ── Per-fund positions over the window (signal-tier only). ──
  const posRows = await prisma.$queryRaw<
    Array<{ ticker: string; period: Date; fundId: string; isElite: boolean; action: string; adj: number | null; active: number | null; expected: number | null; pct: number | null }>
  >(Prisma.sql`
    SELECT h.ticker, h."filingPeriod" AS period, h."fundId" AS "fundId", f."isMostRespected" AS "isElite",
           h.action::text AS action, h."adjShareDeltaPct" AS adj, h."activeWeightBps" AS active,
           h."expectedWeightBps" AS expected, h."pctOfBook" AS pct
    FROM "FundHoldingSnapshot" h
    JOIN "InstitutionalFund" f ON f.id = h."fundId" AND f."isActive" = true AND f."tier" = 'signal'
    WHERE h."filingPeriod" IN (${periodSql})`);

  // Signal funds that filed each period (for the partial-data proxy).
  const filersRows = await prisma.$queryRaw<Array<{ period: Date; fundId: string }>>(Prisma.sql`
    SELECT DISTINCT h."filingPeriod" AS period, h."fundId" AS "fundId"
    FROM "FundHoldingSnapshot" h
    WHERE h."filingPeriod" IN (${periodSql}) AND h.shares > 0 AND ${signalFundFilter("h")}`);
  const filersByPeriod = new Map<string, Set<string>>();
  for (const r of filersRows) {
    const p = iso(r.period);
    (filersByPeriod.get(p) ?? filersByPeriod.set(p, new Set()).get(p)!).add(r.fundId);
  }

  // Group per-fund positions by ticker → period.
  type PosLite = FundPosition & { period: string };
  const posByTicker = new Map<string, PosLite[]>();
  const holdersFundsByKey = new Map<string, Set<string>>(); // `${ticker}|${period}` → fundIds holding (status != exited)
  for (const r of posRows) {
    const p = iso(r.period);
    if (!windowSet.has(p)) continue;
    const status = STATUS[r.action] ?? "held";
    const netBps = r.active != null && r.expected != null ? r.active - r.expected : null;
    const pos: PosLite = {
      period: p,
      fundId: r.fundId,
      isElite: r.isElite,
      status,
      adjShareDeltaPct: r.adj,
      netBps,
      pctOfBook: r.pct,
    };
    (posByTicker.get(r.ticker) ?? posByTicker.set(r.ticker, []).get(r.ticker)!).push(pos);
    if (status !== "exited") {
      const k = `${r.ticker}|${p}`;
      (holdersFundsByKey.get(k) ?? holdersFundsByKey.set(k, new Set()).get(k)!).add(r.fundId);
    }
  }

  // Index name-aggregate rows by ticker → period.
  interface NameLite {
    companyName: string | null;
    holders: number;
    medianPctOfBook: number | null;
    netflowBps: number;
    marketCapUsd: number | null;
  }
  const nameByTicker = new Map<string, Map<string, NameLite>>();
  for (const r of nameRows) {
    const p = iso(r.filingPeriod);
    const m = nameByTicker.get(r.ticker) ?? nameByTicker.set(r.ticker, new Map()).get(r.ticker)!;
    m.set(p, {
      companyName: r.companyName,
      holders: r.fundsHolding,
      medianPctOfBook: r.medianPctOfBook,
      netflowBps: r.netflowBps ?? 0,
      marketCapUsd: r.marketCapUsd != null ? Number(r.marketCapUsd) : null,
    });
  }

  // ── Assemble TickerIngredients. ──
  const tickers: TickerIngredients[] = [];
  for (const [ticker, nameSeries] of nameByTicker) {
    const posList = posByTicker.get(ticker) ?? [];
    const posByPeriod = new Map<string, FundPosition[]>();
    for (const p of posList) (posByPeriod.get(p.period) ?? posByPeriod.set(p.period, []).get(p.period)!).push(p);

    const series: QuarterIngredient[] = [];
    let companyName: string | null = null;
    windowPeriods.forEach((p, i) => {
      const n = nameSeries.get(p);
      if (!n) return; // ticker not present that quarter
      companyName = n.companyName ?? companyName;
      const priorP = i > 0 ? windowPeriods[i - 1]! : null;
      const priorHolders = priorP ? nameSeries.get(priorP)?.holders ?? 0 : 0;
      // Partial-data proxy: prior-quarter holders whose fund did not file this quarter.
      let missingHolders = 0;
      if (priorP) {
        const priorHolderFunds = holdersFundsByKey.get(`${ticker}|${priorP}`);
        const filed = filersByPeriod.get(p);
        if (priorHolderFunds && filed) for (const fid of priorHolderFunds) if (!filed.has(fid)) missingHolders++;
      }
      series.push({
        period: p,
        holders: n.holders,
        priorHolders,
        netflowBps: n.netflowBps,
        medianPctOfBook: n.medianPctOfBook,
        marketCapUsd: n.marketCapUsd,
        missingHolders,
        funds: posByPeriod.get(p) ?? [],
      });
    });
    if (series.length > 0) tickers.push({ ticker, companyName, series });
  }

  const board = computeLeaderboard(tickers, config);
  const result: LeaderboardResult = { ...board, filingPeriod: target, ingredientsVersion: version };
  cache.set(key, result);
  return result;
}
