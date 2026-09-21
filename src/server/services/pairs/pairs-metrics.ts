/**
 * Pairs tab — shared per-pair metric math, used identically by Tier 1
 * (subsector/sector baskets, pairs-snapshot.service) and Tier 2 (single-stock
 * top-k/bottom-k legs, pairs-tier2.service). Extracted so both tiers produce
 * DIRECTLY COMPARABLE numbers rather than two dialects of the same metric.
 *
 * The only I/O here is loadWeeklyFactorReturns (the MACRO14 daily tape sampled
 * onto the weekly grid); everything else is pure given already-aligned series.
 */
import { prisma } from "@/infrastructure/db/client";
import type { FactorCode } from "@/types/factors";
import { MACRO14_FACTORS } from "@/lib/factors/definitions/model-presets";
import { multivariateOls } from "@/lib/factors/regression/ols";
import { factorCovarianceMatrix } from "@/lib/factors/risk/covariance";
import { matVec } from "@/lib/factors/regression/matrix";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Trailing series of `PAIR_THRESHOLDS.seriesWeeks` values ending at index w. */
export function tailSeries(full: Array<number | null>, w: number): number[] {
  const from = Math.max(0, w - PAIR_THRESHOLDS.seriesWeeks + 1);
  return full.slice(from, w + 1).map((v) => (v === null || !Number.isFinite(v) ? 0 : v));
}

/** Long-minus-short compound return over the trailing `weeks` ending at index w. */
export function trailingRel(
  long: Array<number | null>,
  short: Array<number | null>,
  w: number,
  weeks: number,
): number | null {
  let lAcc = 1;
  let sAcc = 1;
  let seen = 0;
  for (let i = Math.max(0, w - weeks + 1); i <= w; i++) {
    const l = long[i];
    const s = short[i];
    if (l !== null && Number.isFinite(l)) {
      lAcc *= 1 + l;
      seen++;
    }
    if (s !== null && Number.isFinite(s)) sAcc *= 1 + s;
  }
  return seen === 0 ? null : lAcc - 1 - (sAcc - 1);
}

/** Everything up to and including index w. */
export function sliceWin(s: Array<number | null>, w: number): Array<number | null> {
  return s.slice(0, w + 1);
}

export interface Decomp {
  residualSharePct: number | null;
  loadings: Record<string, number> | null;
  topFactor: string | null;
  topFactorLoading: number | null;
  /** The top factor's percent contribution to spread variance (Euler), which
   *  answers "how much RISK is this factor" — distinct from its raw loading. */
  topFactorVarPct: number | null;
  betaNeutralRatio: number | null;
}

/**
 * Regress the trailing weekly spread on the 14 MACRO14 factors, returning the
 * residual share (1 − R²), the net factor loadings, the largest absolute one,
 * and a beta-neutral sizing ratio (the legs' market betas over the same window).
 */
export function decomposeSpread(
  spread: Array<number | null>,
  longReturns: Array<number | null>,
  shortReturns: Array<number | null>,
  factorWeekly: Map<FactorCode, Array<number | null>>,
  w: number,
): Decomp {
  const from = Math.max(0, w - PAIR_THRESHOLDS.hedgeEffWeeks + 1);
  const y: number[] = [];
  const X: number[][] = [];
  const yLong: number[] = [];
  const yShort: number[] = [];
  const mkt: number[] = [];
  for (let i = from; i <= w; i++) {
    const sp = spread[i];
    if (sp === null || !Number.isFinite(sp)) continue;
    const row: number[] = [];
    let ok = true;
    for (const code of MACRO14_FACTORS) {
      const v = factorWeekly.get(code)?.[i];
      if (v === null || v === undefined || !Number.isFinite(v)) {
        ok = false;
        break;
      }
      row.push(v);
    }
    if (!ok) continue;
    y.push(sp);
    X.push(row);
    const l = longReturns[i];
    const s = shortReturns[i];
    const m = factorWeekly.get("EQ")?.[i];
    if (l !== null && s !== null && m !== null && m !== undefined && Number.isFinite(l) && Number.isFinite(s)) {
      yLong.push(l);
      yShort.push(s);
      mkt.push(m);
    }
  }
  if (y.length < MACRO14_FACTORS.length + 5) {
    return { residualSharePct: null, loadings: null, topFactor: null, topFactorLoading: null, topFactorVarPct: null, betaNeutralRatio: null };
  }
  const fit = multivariateOls(y, X);
  const residualSharePct = fit.failed ? null : 100 * (1 - fit.rSquared);
  const loadings: Record<string, number> = {};
  let topFactor: string | null = null;
  let topIdx = -1;
  let topAbs = -1;
  let topVal = 0;
  MACRO14_FACTORS.forEach((code, i) => {
    const b = fit.betas[i] ?? 0;
    loadings[code] = b;
    if (Math.abs(b) > topAbs) {
      topAbs = Math.abs(b);
      topFactor = code;
      topVal = b;
      topIdx = i;
    }
  });
  // Top factor's variance contribution via the Euler decomposition:
  // pctVar_f = beta_f (Sigma beta)_f / Var(spread). A share, so weekly Sigma is
  // fine (annualisation cancels). Answers RISK, not loading.
  let topFactorVarPct: number | null = null;
  if (!fit.failed && topIdx >= 0) {
    const factorSeries = MACRO14_FACTORS.map((_, j) => X.map((row) => row[j] ?? 0));
    const sigma = factorCovarianceMatrix(factorSeries, null, false);
    const sigmaBeta = matVec(sigma, fit.betas);
    const my = y.reduce((a, b) => a + b, 0) / y.length;
    const varY = y.reduce((a, b) => a + (b - my) ** 2, 0) / y.length;
    if (varY > 1e-18) topFactorVarPct = 100 * ((fit.betas[topIdx] ?? 0) * (sigmaBeta[topIdx] ?? 0)) / varY;
  }
  let betaNeutralRatio: number | null = null;
  if (mkt.length >= 10) {
    const bL = univariateBeta(yLong, mkt);
    const bS = univariateBeta(yShort, mkt);
    if (bL !== null && bS !== null && Math.abs(bS) > 1e-6) betaNeutralRatio = bL / bS;
  }
  return { residualSharePct, loadings, topFactor, topFactorLoading: topFactor ? topVal : null, topFactorVarPct, betaNeutralRatio };
}

export function univariateBeta(y: number[], x: number[]): number | null {
  const n = Math.min(y.length, x.length);
  if (n < 3) return null;
  const mx = x.reduce((a, b) => a + b, 0) / n;
  const my = y.reduce((a, b) => a + b, 0) / n;
  let cov = 0;
  let vx = 0;
  for (let i = 0; i < n; i++) {
    cov += (x[i]! - mx) * (y[i]! - my);
    vx += (x[i]! - mx) ** 2;
  }
  return vx < 1e-18 ? null : cov / vx;
}

/** Long-median-multiple / short-median-multiple, as a percentile of that ratio's own history. */
export function valuationPercentile(
  longMult: Array<number | null>,
  shortMult: Array<number | null>,
  w: number,
): number | null {
  const ratioHist: number[] = [];
  for (let i = 0; i <= w; i++) {
    const l = longMult[i];
    const s = shortMult[i];
    if (l !== null && s !== null && Number.isFinite(l) && Number.isFinite(s) && s > 0) ratioHist.push(l / s);
  }
  if (ratioHist.length < 8) return null;
  const last = ratioHist[ratioHist.length - 1]!;
  const below = ratioHist.filter((v) => v <= last).length;
  return (100 * (below - 0.5)) / ratioHist.length;
}

/** Weekly compounded MACRO14 factor returns aligned to the grid (index 0 is null). */
export async function loadWeeklyFactorReturns(grid: string[]): Promise<Map<FactorCode, Array<number | null>>> {
  const out = new Map<FactorCode, Array<number | null>>();
  const rows = await prisma.factorReturnDaily.findMany({
    where: { factorCode: { in: MACRO14_FACTORS } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, factorCode: true, value: true },
  });
  const byCode = new Map<FactorCode, Array<{ d: string; r: number }>>();
  for (const r of rows) {
    const code = r.factorCode as FactorCode;
    const arr = byCode.get(code) ?? byCode.set(code, []).get(code)!;
    arr.push({ d: isoOf(r.tradeDate), r: Number(r.value) });
  }
  for (const code of MACRO14_FACTORS) {
    const daily = byCode.get(code) ?? [];
    const weekly: Array<number | null> = new Array(grid.length).fill(null);
    for (let w = 1; w < grid.length; w++) {
      const from = grid[w - 1]!;
      const to = grid[w]!;
      let acc = 1;
      let seen = 0;
      let j = lowerBound(daily, from);
      while (j < daily.length && daily[j]!.d <= to) {
        acc *= 1 + daily[j]!.r;
        seen++;
        j++;
      }
      weekly[w] = seen > 0 ? acc - 1 : null;
    }
    out.set(code, weekly);
  }
  return out;
}

function lowerBound(arr: Array<{ d: string }>, dateExclusive: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]!.d <= dateExclusive) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
