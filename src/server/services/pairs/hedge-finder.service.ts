/**
 * Pairs tab — Hedge Finder (on-demand, read + solve, no writes).
 *
 * For a given long ticker it builds a risk-only short basket that neutralises
 * the long's MACRO14 factor exposure, using:
 *   - per-name MACRO14 betas + idiosyncratic variance from the precomputed
 *     PerStockGrid (readPerStockGridCache("MACRO14", 252)),
 *   - the annualised factor covariance Σ from daily FactorReturnDaily,
 *   - subsector beta shrinkage (small-cap noise control),
 *   - a signal GATE (never an objective term): candidates must be weak on
 *     Engine 1 (bottom decile) or Engine 2 (TRAP tag) with no Engine 3
 *     accumulation — so the shorts are names there is a reason to be short.
 *
 * The optimiser (Cholesky + Lawson-Hanson NNLS + per-name cap + greedy forward
 * selection) minimises residual spread variance. An empirical cross-check then
 * reports the REALISED hedge ratio, R², a split-half re-estimate and the
 * rolling 52-week ratio from actual weekly prices — the model's promise vs what
 * the tape delivered. Short-side scope is basket/ETF-shortable names only (the
 * Phase-0 probe found no single-name short-interest feed and empty volume).
 */
import { prisma } from "@/infrastructure/db/client";
import type { FactorCode } from "@/types/factors";
import { MACRO14_FACTORS } from "@/lib/factors/definitions/model-presets";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import { matVec } from "@/lib/factors/regression/matrix";
import { readPerStockGridCache } from "@/server/services/factor-per-stock-cache.service";
import type { PerStockRow } from "@/server/services/factor-per-stock.service";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { shrinkBetasByGroup } from "@/lib/pairs/hedge/shrink";
import { buildHedgeBasket, type HedgeCandidate } from "@/lib/pairs/hedge/nnls";
import { weeklyCloseSeries, type EodBarLike } from "@/lib/revision/prices";

const RATIO_WINDOW_WEEKS = PAIR_THRESHOLDS.hedgeEffWeeks; // 104
const ROLLING_WEEKS = 52;
const FACTOR_COV_DAYS = 504;
/** Max candidates returned with the full empirical cross-check (map + table). */
const CANDIDATE_LIMIT = 40;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function dot(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}

/** The MACRO14 factor a beta vector loads on most (by |beta|). */
function largestBetaFactor(beta: number[]): string | null {
  let best: string | null = null;
  let bestAbs = 0;
  MACRO14_FACTORS.forEach((code, i) => {
    const v = Math.abs(beta[i] ?? 0);
    if (v > bestAbs) {
      bestAbs = v;
      best = code;
    }
  });
  return best;
}

/** Univariate OLS slope of y on x over paired samples (>= 8). */
function betaOLS(x: number[], y: number[]): number | null {
  const n = Math.min(x.length, y.length);
  if (n < 8) return null;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i]! - mx) * (y[i]! - my);
    vx += (x[i]! - mx) ** 2;
  }
  return vx < 1e-18 ? null : cov / vx;
}

function r2OLS(x: number[], y: number[]): number | null {
  const b = betaOLS(x, y);
  if (b === null) return null;
  const n = x.length;
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  const a = my - b * mx;
  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const pred = a + b * x[i]!;
    ssRes += (y[i]! - pred) ** 2;
    ssTot += (y[i]! - my) ** 2;
  }
  return ssTot < 1e-18 ? null : 1 - ssRes / ssTot;
}

/** Trailing weekly Friday grid of `weeks` ISO dates, oldest first. */
function fridayGrid(weeks: number): string[] {
  const grid: string[] = [];
  const now = new Date();
  const day = now.getUTCDay();
  const lastFri = new Date(now.getTime() - ((day - 5 + 7) % 7) * 86_400_000);
  for (let w = weeks - 1; w >= 0; w--) {
    grid.push(isoOf(new Date(lastFri.getTime() - w * 7 * 86_400_000)));
  }
  return grid;
}

/** Load a weekly-return series (aligned to `grid`) for each ticker. */
async function loadWeeklyReturns(
  tickers: string[],
  grid: string[],
): Promise<Map<string, Array<number | null>>> {
  const uniq = [...new Set(tickers)];
  const secs = await prisma.security.findMany({
    where: { ticker: { in: uniq } },
    select: { id: true, ticker: true },
  });
  const idToTicker = new Map(secs.map((s) => [s.id, s.ticker]));
  const from = new Date(Date.now() - (grid.length + 8) * 7 * 86_400_000);
  const bars = await prisma.priceHistory.findMany({
    where: { securityId: { in: secs.map((s) => s.id) }, tradeDate: { gte: from } },
    orderBy: [{ securityId: "asc" }, { tradeDate: "asc" }],
    select: { securityId: true, tradeDate: true, adjClose: true },
  });
  const byTicker = new Map<string, EodBarLike[]>();
  for (const b of bars) {
    const t = idToTicker.get(b.securityId);
    if (!t) continue;
    const arr = byTicker.get(t) ?? byTicker.set(t, []).get(t)!;
    arr.push({ date: isoOf(b.tradeDate), close: Number(b.adjClose) });
  }
  const out = new Map<string, Array<number | null>>();
  for (const t of uniq) {
    const closes = weeklyCloseSeries(byTicker.get(t) ?? [], grid).map((c) => c.close);
    out.set(
      t,
      closes.map((c, i) => {
        const prev = closes[i - 1];
        return c !== null && prev !== null && prev > 0 ? c / prev - 1 : null;
      }),
    );
  }
  return out;
}

export type HedgeMode = "neutralize" | "express";

export interface HedgeLeg {
  ticker: string;
  name: string;
  weight: number;
  decile: number | null;
  e2Tag: string | null;
  e3Tag: string | null;
  /** Days until the short's next report (borrow / event risk). */
  daysToEarnings: number | null;
  /** The leg's own Engine-1 revision z (weak = good for a short). */
  signalZ: number | null;
  /** The factor this leg offsets most (largest |beta| component). */
  offsetsFactor: string | null;
}

export type HedgeCandidateType = "NAME" | "BASKET" | "ETF";

/** One row of the candidates table / hedge map (model + realised metrics). */
export interface HedgeCandidateRow {
  type: HedgeCandidateType;
  key: string;
  name: string;
  bestMode: HedgeMode | "either";
  /** Variance-minimising single-name short weight per $1 long. */
  hedgeRatio: number;
  factorRiskRemovedPct: number;
  totalVarRemovedPct: number;
  /** Annualised vol of the long after shorting this candidate alone. */
  volAfter: number;
  /** Model correlation of the long with this candidate (co-movement). */
  corrLongCand: number;
  /** Hedge-map y — the candidate's own Engine-1 revision z (lower = weaker). */
  signalZ: number | null;
  decile: number | null;
  e2Tag: string | null;
  e3Tag: string | null;
  /** Passes the short-side signal gate (hollow marker / dimmed row if not). */
  gatePass: boolean;
  daysToEarnings: number | null;
  realizedBeta: number | null;
  realizedR2: number | null;
  betaFirstHalf: number | null;
  betaSecondHalf: number | null;
  rolling52: Array<number | null>;
  /** On the risk-removed vs signal-weakness Pareto frontier. */
  paretoFrontier: boolean;
  /** Is a leg of the currently selected NNLS basket. */
  inBasket: boolean;
  flags: string[];
}

export interface HedgeFinderResult {
  target: {
    ticker: string;
    name: string;
    sector: string;
    subsector: string;
    rSquared: number;
    modelVol: number;
  };
  mode: HedgeMode;
  gates: {
    weakMaxDecile: number;
    requireNoAccumulation: boolean;
    minHedgeEff: number;
    betaShrinkLambda: number;
    maxNames: number;
    nameCap: number;
  };
  candidatePoolSize: number;
  gatedOut: number;
  legs: HedgeLeg[];
  /** Every candidate (names + baskets), sorted by total risk removed. */
  candidates: HedgeCandidateRow[];
  /** Universe-z of the target's beta per factor (for the target factor bars). */
  targetFactorZ: Record<string, number>;
  /** Net factor loadings before / after the hedge. */
  factorBefore: Record<string, number>;
  factorAfter: Record<string, number>;
  factorRiskRemovedPct: number;
  totalVarRemovedPct: number;
  residualSharePct: number;
  /** One-sentence statement of the largest surviving exposure. */
  survivorStatement: string;
  empirical: {
    realizedBeta: number | null;
    realizedR2: number | null;
    betaFirstHalf: number | null;
    betaSecondHalf: number | null;
    splitHalfRatio: number | null;
    rolling52: Array<number | null>;
    weeksUsed: number;
  };
  hedgedVsUnhedged: {
    weeks: string[];
    longIndex: number[];
    hedgedIndex: number[];
  };
  subtitle: string;
}

export async function findHedge(opts: {
  target: string;
  mode?: HedgeMode;
  maxNames?: number;
}): Promise<HedgeFinderResult | null> {
  const target = opts.target.trim().toUpperCase();
  const mode: HedgeMode = opts.mode ?? "neutralize";
  const maxNames = opts.maxNames ?? PAIR_THRESHOLDS.basketMaxNames;

  const grid = await readPerStockGridCache("MACRO14", 252);
  if (!grid) return null;
  const byTicker = new Map(grid.rows.map((r) => [r.ticker, r]));
  const targetRow = byTicker.get(target);
  if (!targetRow) return null;

  // Latest signal tags per ticker for the gate + subsector shrink groups.
  const latest = await prisma.pairUniverseWeek.aggregate({ _max: { snapshotDate: true } });
  const signalDate =
    latest._max.snapshotDate ??
    (await prisma.revisionScreenRow.aggregate({ _max: { snapshotDate: true } }))._max.snapshotDate;
  const signalRows = signalDate
    ? await prisma.revisionScreenRow.findMany({
        where: { snapshotDate: signalDate },
        select: {
          ticker: true,
          subsector: true,
          sector: true,
          decile: true,
          e2Tag: true,
          e3Tag: true,
          ptRevOrthZ: true,
          daysToEarnings: true,
        },
      })
    : [];
  const signalByTicker = new Map(signalRows.map((r) => [r.ticker, r]));

  const targetSignal = signalByTicker.get(target);
  const targetSector = targetSignal?.sector ?? targetRow.sector ?? "Unclassified";
  const targetSub = targetSignal?.subsector ?? "Unclassified";

  const betaVec = (row: PerStockRow): number[] => MACRO14_FACTORS.map((c) => row.cells[c]?.beta ?? 0);
  const idioVar = (row: PerStockRow): number =>
    Math.max(0, row.idiosyncraticShare) * row.modelImpliedAnnualizedVol ** 2;

  // Candidate pool: same-sector peers (economically meaningful hedges), gated.
  const poolRows = grid.rows.filter((r) => r.ticker !== target && (r.sector ?? "") === targetSector);
  const candidatePoolSize = poolRows.length;

  const passesGate = (t: string): boolean => {
    const s = signalByTicker.get(t);
    if (!s) return mode === "neutralize"; // no signal → allowed only in pure-risk mode
    if (s.e3Tag === "ACCUM") return false; // never short a name funds are accumulating
    if (mode === "neutralize") return true; // risk-only: gate on E3 alone
    const weakE1 = s.decile !== null && s.decile <= PAIR_THRESHOLDS.hedgeWeakMaxDecile;
    const weakE2 = s.e2Tag === "TRAP";
    return weakE1 || weakE2;
  };
  const gated = poolRows.filter((r) => passesGate(r.ticker));
  const gatedOut = candidatePoolSize - gated.length;

  // Beta shrinkage toward subsector mean (target + WHOLE pool, so gated-out
  // context candidates also get shrunk betas for the map).
  const shrinkEntries = [targetRow, ...poolRows].map((r) => ({
    key: r.ticker,
    group: signalByTicker.get(r.ticker)?.subsector ?? "Unclassified",
    beta: betaVec(r),
  }));
  const shrunk = shrinkBetasByGroup(shrinkEntries, PAIR_THRESHOLDS.betaShrinkLambda);
  const betaLong = shrunk.get(target) ?? betaVec(targetRow);

  const cov = await loadFactorCovariance();

  const candidates: HedgeCandidate[] = gated.map((r) => ({
    key: r.ticker,
    beta: shrunk.get(r.ticker) ?? betaVec(r),
    sigmaIdio2: idioVar(r),
  }));

  const basket = buildHedgeBasket({
    betaLong,
    candidates,
    cov,
    sigmaLongIdio2: idioVar(targetRow),
    maxNames,
    nameCap: PAIR_THRESHOLDS.basketNameCap,
  });

  const legWeight = new Map(basket.legs.map((l) => [l.key, l.weight]));
  const legs: HedgeLeg[] = basket.legs.map((l) => {
    const s = signalByTicker.get(l.key);
    const row = byTicker.get(l.key);
    const legBeta = shrunk.get(l.key) ?? (row ? betaVec(row) : []);
    return {
      ticker: l.key,
      name: row?.name ?? l.key,
      weight: l.weight,
      decile: s?.decile ?? null,
      e2Tag: s?.e2Tag ?? null,
      e3Tag: s?.e3Tag ?? null,
      daysToEarnings: s?.daysToEarnings ?? null,
      signalZ: s?.ptRevOrthZ ?? null,
      offsetsFactor: largestBetaFactor(legBeta),
    };
  });

  // Before / after net factor loadings + universe-z of the target's betas.
  const factorBefore: Record<string, number> = {};
  const factorAfter: Record<string, number> = {};
  const targetFactorZ: Record<string, number> = {};
  const poolZStats = betaZStats(poolRows.map((r) => shrunk.get(r.ticker) ?? betaVec(r)));
  MACRO14_FACTORS.forEach((code, i) => {
    const before = betaLong[i] ?? 0;
    let net = before;
    for (const l of basket.legs) {
      const cand = candidates.find((c) => c.key === l.key);
      net -= (legWeight.get(l.key) ?? 0) * (cand?.beta[i] ?? 0);
    }
    factorBefore[code] = before;
    factorAfter[code] = net;
    const { mean, sd } = poolZStats[i]!;
    targetFactorZ[code] = sd > 1e-12 ? (before - mean) / sd : 0;
  });

  // Survivor statement: the largest surviving |net loading|.
  let survivorFactor: FactorCode | null = null;
  let survivorAbs = -1;
  let survivorVal = 0;
  MACRO14_FACTORS.forEach((code) => {
    const v = factorAfter[code] ?? 0;
    if (Math.abs(v) > survivorAbs) {
      survivorAbs = Math.abs(v);
      survivorFactor = code;
      survivorVal = v;
    }
  });
  const survivorStatement =
    survivorFactor === null || survivorAbs < 1e-6
      ? "The hedge neutralises essentially all systematic factor exposure; what remains is idiosyncratic."
      : `After hedging, the largest surviving exposure is a ${survivorVal >= 0 ? "long" : "short"} ${survivorFactor} loading of ${survivorVal.toFixed(2)} — the residual bet.`;

  // ---- Candidate universe (names + sector/subsector baskets) --------------
  const sigmaBetaLong = matVec(cov, betaLong);
  const factorVarLong = dot(betaLong, sigmaBetaLong);
  const totalVarLong = factorVarLong + idioVar(targetRow);

  const modelMetrics = (
    betaCand: number[],
    idioCand: number,
  ): { hedgeRatio: number; factorRiskRemovedPct: number; totalVarRemovedPct: number; volAfter: number; corr: number } => {
    const sigmaBetaCand = matVec(cov, betaCand);
    const covLC = dot(betaLong, sigmaBetaCand);
    const factorVarCand = dot(betaCand, sigmaBetaCand);
    const totalVarCand = factorVarCand + Math.max(0, idioCand);
    const w = totalVarCand > 1e-18 ? covLC / totalVarCand : 0;
    const net = betaLong.map((b, j) => b - w * (betaCand[j] ?? 0));
    const netFactorVar = dot(net, matVec(cov, net));
    const factorRiskRemovedPct = factorVarLong > 1e-18 ? 1 - netFactorVar / factorVarLong : 0;
    const totalVarRemoved = 2 * w * covLC - w * w * totalVarCand;
    const totalVarRemovedPct = totalVarLong > 1e-18 ? totalVarRemoved / totalVarLong : 0;
    const volAfter = Math.sqrt(Math.max(0, totalVarLong - totalVarRemoved));
    const corr = totalVarLong > 0 && totalVarCand > 0 ? covLC / Math.sqrt(totalVarLong * totalVarCand) : 0;
    return { hedgeRatio: w, factorRiskRemovedPct, totalVarRemovedPct, volAfter, corr };
  };

  // Sector + subsector equal-weighted baskets as BASKET candidates (Amendment 2:
  // stand-ins for the deferred single-ticker ETF pool; betas = mean of members).
  const signalZByTicker = new Map<string, number | null>(
    signalRows.map((r) => [r.ticker, r.ptRevOrthZ]),
  );
  const baskets = await loadBasketCandidates(
    targetSector,
    targetSub,
    byTicker,
    betaVec,
    idioVar,
    target,
    signalZByTicker,
  );

  const nameRows: HedgeCandidateRow[] = poolRows.map((r) => {
    const s = signalByTicker.get(r.ticker);
    const m = modelMetrics(shrunk.get(r.ticker) ?? betaVec(r), idioVar(r));
    const gatePass = passesGate(r.ticker);
    const weakSignal =
      (s?.decile != null && s.decile <= PAIR_THRESHOLDS.hedgeWeakMaxDecile) || s?.e2Tag === "TRAP";
    return {
      type: "NAME" as const,
      key: r.ticker,
      name: r.name,
      bestMode: weakSignal ? ("express" as const) : ("neutralize" as const),
      hedgeRatio: m.hedgeRatio,
      factorRiskRemovedPct: m.factorRiskRemovedPct,
      totalVarRemovedPct: m.totalVarRemovedPct,
      volAfter: m.volAfter,
      corrLongCand: m.corr,
      signalZ: s?.ptRevOrthZ ?? null,
      decile: s?.decile ?? null,
      e2Tag: s?.e2Tag ?? null,
      e3Tag: s?.e3Tag ?? null,
      gatePass,
      daysToEarnings: s?.daysToEarnings ?? null,
      realizedBeta: null,
      realizedR2: null,
      betaFirstHalf: null,
      betaSecondHalf: null,
      rolling52: [],
      paretoFrontier: false,
      inBasket: legWeight.has(r.ticker),
      flags: [],
    };
  });

  const basketRows: HedgeCandidateRow[] = baskets.map((b) => {
    const m = modelMetrics(b.beta, b.idio);
    return {
      type: "BASKET" as const,
      key: b.key,
      name: b.name,
      bestMode: "neutralize" as const,
      hedgeRatio: m.hedgeRatio,
      factorRiskRemovedPct: m.factorRiskRemovedPct,
      totalVarRemovedPct: m.totalVarRemovedPct,
      volAfter: m.volAfter,
      corrLongCand: m.corr,
      signalZ: b.signalZ,
      decile: null,
      e2Tag: null,
      e3Tag: null,
      gatePass: true,
      daysToEarnings: null,
      realizedBeta: null,
      realizedR2: null,
      betaFirstHalf: null,
      betaSecondHalf: null,
      rolling52: [],
      paretoFrontier: false,
      inBasket: false,
      flags: b.containsTarget ? ["CONTAINS TARGET"] : [],
    };
  });

  const allCandidates = [...basketRows, ...nameRows];
  markParetoFrontier(allCandidates);
  allCandidates.sort((a, b) => b.totalVarRemovedPct - a.totalVarRemovedPct);
  const candidateRows = allCandidates.slice(0, CANDIDATE_LIMIT);

  await attachCandidateEmpirical(target, candidateRows, baskets);
  for (const c of candidateRows) {
    if (c.paretoFrontier) c.flags.push("ON FRONTIER");
    if (
      c.betaFirstHalf !== null &&
      c.betaSecondHalf !== null &&
      Math.abs(c.betaFirstHalf - c.betaSecondHalf) > 0.2
    )
      c.flags.push("UNSTABLE RATIO");
    if (c.realizedR2 !== null && c.realizedR2 < 0.1) c.flags.push("LOW R²");
  }

  const empirical = await empiricalCrossCheck(target, legs);

  const subtitle =
    "Short side is basket/ETF-shortable names only — no single-name short-interest feed was available at build (Phase-0 probe). Red is good: a short's own weak signals are what you want.";

  return {
    target: {
      ticker: target,
      name: targetRow.name,
      sector: targetSector,
      subsector: targetSub,
      rSquared: targetRow.rSquared,
      modelVol: targetRow.modelImpliedAnnualizedVol,
    },
    mode,
    gates: {
      weakMaxDecile: PAIR_THRESHOLDS.hedgeWeakMaxDecile,
      requireNoAccumulation: true,
      minHedgeEff: PAIR_THRESHOLDS.minHedgeEff,
      betaShrinkLambda: PAIR_THRESHOLDS.betaShrinkLambda,
      maxNames,
      nameCap: PAIR_THRESHOLDS.basketNameCap,
    },
    candidatePoolSize,
    gatedOut,
    legs,
    candidates: candidateRows,
    targetFactorZ,
    factorBefore,
    factorAfter,
    factorRiskRemovedPct: basket.factorRiskRemovedPct,
    totalVarRemovedPct: basket.totalVarRemovedPct,
    residualSharePct: basket.residualSharePct,
    survivorStatement,
    empirical: empirical.stats,
    hedgedVsUnhedged: empirical.series,
    subtitle,
  };
}

/** Annualised MACRO14 factor covariance from the trailing daily factor returns. */
async function loadFactorCovariance(): Promise<number[][]> {
  const rows = await prisma.factorReturnDaily.findMany({
    where: { factorCode: { in: MACRO14_FACTORS } },
    orderBy: { tradeDate: "desc" },
    take: FACTOR_COV_DAYS * MACRO14_FACTORS.length,
    select: { tradeDate: true, factorCode: true, value: true },
  });
  const byDate = new Map<string, Map<FactorCode, number>>();
  for (const r of rows) {
    const d = isoOf(r.tradeDate);
    const m = byDate.get(d) ?? byDate.set(d, new Map()).get(d)!;
    m.set(r.factorCode as FactorCode, Number(r.value));
  }
  const dates = [...byDate.keys()].sort();
  const series: number[][] = MACRO14_FACTORS.map(() => []);
  for (const d of dates) {
    const m = byDate.get(d)!;
    if (MACRO14_FACTORS.some((c) => !m.has(c) || !Number.isFinite(m.get(c)!))) continue;
    MACRO14_FACTORS.forEach((c, i) => series[i]!.push(m.get(c)!));
  }
  return factorCovarianceMatrix(series, null, true);
}

/** Per-factor mean/sd of a set of beta vectors (universe z reference). */
function betaZStats(vectors: number[][]): Array<{ mean: number; sd: number }> {
  const k = MACRO14_FACTORS.length;
  const out: Array<{ mean: number; sd: number }> = [];
  for (let j = 0; j < k; j++) {
    const col = vectors.map((v) => v[j] ?? 0);
    const n = col.length || 1;
    const mean = col.reduce((s, v) => s + v, 0) / n;
    const varr = col.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    out.push({ mean, sd: Math.sqrt(varr) });
  }
  return out;
}

interface EmpiricalResult {
  stats: HedgeFinderResult["empirical"];
  series: HedgeFinderResult["hedgedVsUnhedged"];
}

/** Split-half + rolling-52 diagnostics from paired weekly returns (cand=x, long=y). */
function pairDiagnostics(xs: number[], ys: number[]) {
  const half = Math.floor(xs.length / 2);
  const betaFirstHalf = betaOLS(xs.slice(0, half), ys.slice(0, half));
  const betaSecondHalf = betaOLS(xs.slice(half), ys.slice(half));
  const splitHalfRatio =
    betaFirstHalf !== null && betaSecondHalf !== null && Math.abs(betaFirstHalf) > 1e-9
      ? betaSecondHalf / betaFirstHalf
      : null;
  const rolling52: Array<number | null> = [];
  for (let i = 0; i < xs.length; i++) {
    if (i < ROLLING_WEEKS - 1) {
      rolling52.push(null);
      continue;
    }
    rolling52.push(betaOLS(xs.slice(i - ROLLING_WEEKS + 1, i + 1), ys.slice(i - ROLLING_WEEKS + 1, i + 1)));
  }
  return {
    realizedBeta: betaOLS(xs, ys),
    realizedR2: r2OLS(xs, ys),
    betaFirstHalf,
    betaSecondHalf,
    splitHalfRatio,
    rolling52,
    weeksUsed: xs.length,
  };
}

/** Realised hedge diagnostics for the selected basket from actual weekly prices. */
async function empiricalCrossCheck(target: string, legs: HedgeLeg[]): Promise<EmpiricalResult> {
  const grid = fridayGrid(RATIO_WINDOW_WEEKS);
  const retByTicker = await loadWeeklyReturns([target, ...legs.map((l) => l.ticker)], grid);

  const longRet = retByTicker.get(target) ?? grid.map(() => null);
  const legRets = legs.map((l) => ({ w: l.weight, r: retByTicker.get(l.ticker) ?? grid.map(() => null) }));
  const grossShort = legs.reduce((s, l) => s + l.weight, 0) || 1;
  const basketRet = grid.map((_, i) => {
    let acc = 0;
    let ok = true;
    for (const leg of legRets) {
      const v = leg.r[i];
      if (v === null) {
        ok = false;
        break;
      }
      acc += (leg.w / grossShort) * v;
    }
    return ok ? acc : null;
  });

  // Paired samples: long vs basket weekly return.
  const xs: number[] = [];
  const ys: number[] = [];
  const weeks: string[] = [];
  const longIndexArr: number[] = [];
  const hedgedIndexArr: number[] = [];
  let longIdx = 1;
  let hedgedIdx = 1;
  grid.forEach((wk, i) => {
    const l = longRet[i];
    const b = basketRet[i];
    if (l === null || l === undefined || b === null) return;
    xs.push(b);
    ys.push(l);
    longIdx *= 1 + l;
    hedgedIdx *= 1 + (l - b);
    weeks.push(wk);
    longIndexArr.push(longIdx);
    hedgedIndexArr.push(hedgedIdx);
  });

  const d = pairDiagnostics(xs, ys);
  return {
    stats: {
      realizedBeta: d.realizedBeta,
      realizedR2: d.realizedR2,
      betaFirstHalf: d.betaFirstHalf,
      betaSecondHalf: d.betaSecondHalf,
      splitHalfRatio: d.splitHalfRatio,
      rolling52: d.rolling52,
      weeksUsed: d.weeksUsed,
    },
    series: { weeks, longIndex: longIndexArr, hedgedIndex: hedgedIndexArr },
  };
}

interface BasketCandidate {
  key: string;
  name: string;
  beta: number[];
  idio: number;
  signalZ: number | null;
  containsTarget: boolean;
  members: string[];
}

/** Sector + subsector equal-weighted baskets as risk-only hedge candidates. */
async function loadBasketCandidates(
  sector: string,
  subsector: string,
  byTicker: Map<string, PerStockRow>,
  betaVec: (row: PerStockRow) => number[],
  idioVar: (row: PerStockRow) => number,
  target: string,
  signalZByTicker: Map<string, number | null>,
): Promise<BasketCandidate[]> {
  const latest = await prisma.pairGroupSnapshot.aggregate({
    where: { weighting: "EQUAL" },
    _max: { snapshotDate: true },
  });
  const date = latest._max.snapshotDate;
  if (!date) return [];
  const groups = await prisma.pairGroupSnapshot.findMany({
    where: {
      weighting: "EQUAL",
      snapshotDate: date,
      OR: [
        { groupType: "SUBSECTOR", groupKey: subsector },
        { groupType: "SECTOR", groupKey: sector },
      ],
    },
    select: { groupType: true, groupKey: true, members: true },
  });
  const out: BasketCandidate[] = [];
  for (const g of groups) {
    const present = g.members.filter((t) => t !== target && byTicker.has(t));
    if (present.length < 2) continue;
    const n = present.length;
    const beta = MACRO14_FACTORS.map(
      (_, j) => present.reduce((s, t) => s + (betaVec(byTicker.get(t)!)[j] ?? 0), 0) / n,
    );
    const idio = present.reduce((s, t) => s + (1 / n) ** 2 * idioVar(byTicker.get(t)!), 0);
    const zs = present.map((t) => signalZByTicker.get(t)).filter((z): z is number => z != null);
    const signalZ = zs.length ? zs.reduce((s, z) => s + z, 0) / zs.length : null;
    const label = g.groupType === "SECTOR" ? "sector" : "subsector";
    out.push({
      key: `${g.groupKey} basket`,
      name: `${g.groupKey} (${label} basket, n=${n})`,
      beta,
      idio,
      signalZ,
      containsTarget: g.members.includes(target),
      members: present,
    });
  }
  return out;
}

/**
 * Flag the risk-removed vs signal-weakness Pareto frontier over gate-pass
 * candidates: a point is on it if no other beats it on BOTH axes (more total
 * risk removed AND a weaker own signal).
 */
function markParetoFrontier(candidates: HedgeCandidateRow[]): void {
  const eligible = candidates.filter((c) => c.gatePass);
  for (const c of eligible) {
    const y = c.signalZ ?? 0;
    const dominated = eligible.some((o) => {
      if (o === c) return false;
      const oy = o.signalZ ?? 0;
      const better = o.totalVarRemovedPct >= c.totalVarRemovedPct && oy <= y;
      const strict = o.totalVarRemovedPct > c.totalVarRemovedPct || oy < y;
      return better && strict;
    });
    c.paretoFrontier = !dominated;
  }
}

/** Attach realised β / R² / split-half / rolling-52 to each returned candidate. */
async function attachCandidateEmpirical(
  target: string,
  candidates: HedgeCandidateRow[],
  baskets: BasketCandidate[],
): Promise<void> {
  const basketByKey = new Map(baskets.map((b) => [b.key, b]));
  const memberTickers = baskets.flatMap((b) => b.members);
  const nameTickers = candidates.filter((c) => c.type === "NAME").map((c) => c.key);
  const grid = fridayGrid(RATIO_WINDOW_WEEKS);
  const retByTicker = await loadWeeklyReturns([target, ...nameTickers, ...memberTickers], grid);
  const longRet = retByTicker.get(target) ?? grid.map(() => null);

  for (const c of candidates) {
    let candRet: Array<number | null>;
    if (c.type === "BASKET") {
      const b = basketByKey.get(c.key);
      if (!b) continue;
      const memberRets = b.members.map((t) => retByTicker.get(t) ?? grid.map(() => null));
      candRet = grid.map((_, i) => {
        let acc = 0;
        let cnt = 0;
        for (const r of memberRets) {
          const v = r[i];
          if (v === null || v === undefined) continue;
          acc += v;
          cnt++;
        }
        return cnt > 0 ? acc / cnt : null;
      });
    } else {
      candRet = retByTicker.get(c.key) ?? grid.map(() => null);
    }
    const xs: number[] = [];
    const ys: number[] = [];
    grid.forEach((_, i) => {
      const l = longRet[i];
      const x = candRet[i];
      if (l === null || l === undefined || x === null || x === undefined) return;
      xs.push(x);
      ys.push(l);
    });
    const d = pairDiagnostics(xs, ys);
    c.realizedBeta = d.realizedBeta;
    c.realizedR2 = d.realizedR2;
    c.betaFirstHalf = d.betaFirstHalf;
    c.betaSecondHalf = d.betaSecondHalf;
    c.rolling52 = d.rolling52;
  }
}
