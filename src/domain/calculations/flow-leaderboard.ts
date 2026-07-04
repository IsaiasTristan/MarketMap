/**
 * Flow Leaderboard — pure scoring core.
 *
 * DB-free and deterministic: `computeLeaderboard(tickers, config)` takes the
 * precomputed, config-INDEPENDENT ingredients (per-fund adjusted-share deltas,
 * per-name capital-flow bps, point-in-time market caps) and applies the
 * config-DEPENDENT scoring (adder/reducer classification at the config
 * threshold, recency-weighted flows, cross-sectional z-scores over the gated
 * set, streak / conviction / elite multipliers, 0-100 rescale, reason strings).
 *
 * Mirrors the computeActiveFlowPair pure-core pattern so it is unit-tested
 * directly (tests/analysis/flow-leaderboard.test.ts). The thin Prisma loader
 * lives in the server service; the config playground and backtests call THIS
 * function so there is never a second scoring implementation.
 */
import { zScore } from "@/domain/calculations/factor-scoring";
import type { FlowLeaderboardConfig } from "@/domain/calculations/flow-leaderboard-config";

/** A signal-tier fund's position in one (ticker, quarter), post split-adjustment. */
export type PositionStatus = "new" | "added" | "held" | "trimmed" | "exited";
export interface FundPosition {
  fundId: string;
  isElite: boolean;
  status: PositionStatus;
  /** Split-adjusted QoQ share delta %. Null for `new` / `exited` (no ratio). */
  adjShareDeltaPct: number | null;
  /** This fund's deliberate weight move this quarter, bps (active − expected). */
  netBps: number | null;
  /** Position weight (value / book) this quarter, %. */
  pctOfBook: number | null;
}

/** One quarter of a ticker's ingredients (ascending order; latest last). */
export interface QuarterIngredient {
  period: string; // YYYY-MM-DD quarter-end
  /** Signal-tier funds holding (shares > 0) this quarter. */
  holders: number;
  /** Signal-tier funds holding the immediately-prior quarter (relflow denominator). */
  priorHolders: number;
  /** Precomputed capital-flow: mean (active − expected) weight over ALL signal
   *  funds (non-holders = 0), in bps. */
  netflowBps: number;
  /** Median position weight among holders this quarter, % (conviction). */
  medianPctOfBook: number | null;
  /** Point-in-time market cap (USD) as of this quarter-end; null = unknown. */
  marketCapUsd: number | null;
  /** Latest-quarter data completeness: holders whose filing is missing. */
  missingHolders: number;
  /** Per-fund position changes (signal-tier) this quarter. */
  funds: FundPosition[];
}

export interface TickerIngredients {
  ticker: string;
  companyName?: string | null;
  /** Ascending by period; must cover at least the display window (5) + any
   *  streak history. The core slices what it needs. */
  series: QuarterIngredient[];
}

export interface HeatCell {
  period: string;
  netflow: number; // adders − reducers (printed value)
  netflowBps: number; // net capital move (tooltip)
  adders: number;
  reducers: number;
  holders: number;
  /** Fund-level moves for the hover tooltip (loader attaches names). */
  movers: Array<{ fundId: string; status: PositionStatus; deltaPct: number | null; netBps: number | null }>;
}

export interface ScoredRow {
  rank: number;
  ticker: string;
  companyName: string | null;
  score: number; // 0-100 within its board
  rawScore: number;
  flowz: number;
  flowzCounts: number;
  flowzCap: number;
  wflow: number;
  wflowBps: number;
  streak: number; // signed run length (+ accumulation / − distribution)
  convictionPct: number; // 0-1 cross-sectional percentile of median weight
  medianWeight: number | null;
  holders: number;
  eliteAdders2: number;
  reason: string;
  partialData: boolean;
  marketCapUsd: number | null;
  cells: HeatCell[]; // trailing 5 quarters, ascending
}

export interface GatedOutRow {
  ticker: string;
  companyName: string | null;
  holders: number;
  wflow: number;
  wflowBps: number;
  reason: string; // why it's below threshold
}

export interface Leaderboard {
  accumulation: ScoredRow[];
  distribution: ScoredRow[];
  gatedOut: GatedOutRow[];
}

const DISPLAY_QUARTERS = 5;
const MOVER_EPS_BPS = 1; // a fund's move below this bps is rebalancing dust
const round = (n: number, p = 2): number => {
  const f = 10 ** p;
  return Math.round(n * f) / f;
};
const sign = (n: number): number => (n > 0 ? 1 : n < 0 ? -1 : 0);

/** Classify one fund's position change into the count-flow buckets. */
function classify(f: FundPosition, thresholdPct: number): "adder" | "reducer" | null {
  if (f.status === "new") return "adder";
  if (f.status === "exited") return "reducer";
  if (f.adjShareDeltaPct == null) return null;
  if (f.adjShareDeltaPct >= thresholdPct) return "adder";
  if (f.adjShareDeltaPct <= -thresholdPct) return "reducer";
  return null;
}

interface QuarterFlow {
  adders: number;
  reducers: number;
  eliteAdders: number;
  netflow: number;
  netflowBps: number;
  holders: number;
  priorHolders: number;
  moverCount: number; // funds with a non-trivial capital move
}

function quarterFlow(q: QuarterIngredient, thresholdPct: number): QuarterFlow {
  let adders = 0;
  let reducers = 0;
  let eliteAdders = 0;
  let moverCount = 0;
  for (const f of q.funds) {
    const cls = classify(f, thresholdPct);
    if (cls === "adder") {
      adders++;
      if (f.isElite) eliteAdders++;
    } else if (cls === "reducer") reducers++;
    if (f.netBps != null && Math.abs(f.netBps) > MOVER_EPS_BPS) moverCount++;
  }
  return {
    adders,
    reducers,
    eliteAdders,
    netflow: adders - reducers,
    netflowBps: q.netflowBps,
    holders: q.holders,
    priorHolders: q.priorHolders,
    moverCount,
  };
}

/** Per-ticker intermediate computed before the cross-sectional pass. Exported
 *  (via computeTickerCalc) so streak / wflow math is unit-testable in isolation. */
export interface TickerCalc {
  t: TickerIngredients;
  latest: QuarterIngredient;
  flows: QuarterFlow[]; // full series, ascending (aligned with t.series)
  wflow: number;
  relflow: number;
  wflowBps: number;
  streak: number; // signed run length from latest backward
  eliteAdders2: number;
  medianWeight: number | null;
  medianWeightLookbackAgo: number | null;
  holders: number;
  holdersLookbackAgo: number;
  partialData: boolean;
  singleFundCapital: boolean;
}

export function computeTickerCalc(t: TickerIngredients, config: FlowLeaderboardConfig): TickerCalc | null {
  const { series } = t;
  if (series.length === 0) return null;
  const flows = series.map((q) => quarterFlow(q, config.adder_threshold_pct));
  const n = series.length;
  const L = config.lookback_quarters;
  const w = config.recency_weights;

  let wflow = 0;
  let relflow = 0;
  let wflowBps = 0;
  for (let i = 0; i < L; i++) {
    const idx = n - 1 - i; // q0 = latest
    if (idx < 0) break;
    const fl = flows[idx]!;
    const wi = w[i] ?? 0;
    wflow += wi * fl.netflow;
    relflow += (wi * fl.netflow) / Math.max(fl.priorHolders, 5);
    wflowBps += wi * fl.netflowBps;
  }

  // Streak: consecutive quarters from latest backward with the same signed flow.
  // Sign is netflow_bps sign, falling back to count sign inside the bps dead-zone.
  const signOf = (fl: QuarterFlow): number =>
    Math.abs(fl.netflowBps) > config.bps_deadzone ? sign(fl.netflowBps) : sign(fl.netflow);
  let streak = 0;
  let streakSign = 0;
  for (let idx = n - 1; idx >= 0; idx--) {
    const s = signOf(flows[idx]!);
    if (idx === n - 1) {
      if (s === 0) break;
      streakSign = s;
      streak = 1;
    } else if (s === streakSign) {
      streak += 1;
    } else break;
  }

  const latest = series[n - 1]!;
  const eliteAdders2 = (flows[n - 1]?.eliteAdders ?? 0) + (flows[n - 2]?.eliteAdders ?? 0);
  const lookbackIdx = Math.max(0, n - L);
  const holdersLookbackAgo = series[lookbackIdx]?.holders ?? latest.holders;
  const medianWeightLookbackAgo = series[lookbackIdx]?.medianPctOfBook ?? null;
  const partialData =
    latest.holders > 0 && latest.missingHolders / (latest.holders + latest.missingHolders) > config.gates.partial_data_pct;

  // Single-fund capital: the latest capital move is essentially ONE fund and the
  // count-flow is ~flat (net adders ≤ 1). Used for the "single-fund" reason flag.
  const latestFlow = flows[n - 1]!;
  const singleFundCapital = latestFlow.moverCount === 1 && Math.abs(latestFlow.netflow) <= 1 && Math.abs(wflowBps) > 0;

  return {
    t,
    latest,
    flows,
    wflow: round(wflow, 4),
    relflow: round(relflow, 6),
    wflowBps: round(wflowBps, 4),
    streak: streakSign * streak,
    eliteAdders2,
    medianWeight: latest.medianPctOfBook,
    medianWeightLookbackAgo,
    holders: latest.holders,
    holdersLookbackAgo,
    partialData,
    singleFundCapital,
  };
}

/** Build the trailing-5-quarter heat strip (ascending). */
function heatCells(calc: TickerCalc, thresholdPct: number): HeatCell[] {
  const { t, flows } = calc;
  const start = Math.max(0, t.series.length - DISPLAY_QUARTERS);
  const cells: HeatCell[] = [];
  for (let idx = start; idx < t.series.length; idx++) {
    const q = t.series[idx]!;
    const fl = flows[idx]!;
    const movers = q.funds
      .filter((f) => classify(f, thresholdPct) !== null || (f.netBps != null && Math.abs(f.netBps) > MOVER_EPS_BPS))
      .map((f) => ({ fundId: f.fundId, status: f.status, deltaPct: f.adjShareDeltaPct, netBps: f.netBps }));
    cells.push({
      period: q.period,
      netflow: fl.netflow,
      netflowBps: round(fl.netflowBps),
      adders: fl.adders,
      reducers: fl.reducers,
      holders: fl.holders,
      movers,
    });
  }
  return cells;
}

/** Linear map of a 0-1 percentile onto [lo, hi]. */
function mapRange(pct: number, [lo, hi]: readonly [number, number]): number {
  return lo + (hi - lo) * Math.min(1, Math.max(0, pct));
}

/** Cross-sectional percentile (0-1) of `value` within `sortedAsc`. */
function percentileOf(sortedAsc: number[], value: number): number {
  if (sortedAsc.length <= 1) return 0.5;
  let below = 0;
  for (const v of sortedAsc) if (v < value) below++;
  return below / (sortedAsc.length - 1 <= 0 ? 1 : sortedAsc.length - 1);
}

function buildReason(calc: TickerCalc, flowzCounts: number, flowzCap: number, convictionPct: number, convictionPctLookback: number): string {
  const parts: string[] = [];
  const streakMag = Math.abs(calc.streak);
  const flowSign = sign(flowzCounts + flowzCap);

  // reversal: sign flipped within lookback AND current streak ≥ 2.
  let flipped = false;
  const recent = calc.flows.slice(-4); // lookback window (latest 4)
  const signs = recent.map((fl) => (fl.netflow !== 0 ? sign(fl.netflow) : 0)).filter((s) => s !== 0);
  for (let i = 1; i < signs.length; i++) if (signs[i] !== signs[i - 1]) flipped = true;

  if (flipped && streakMag >= 2) {
    parts.push(`reversal ${calc.streak > 0 ? "+" : "−"}${streakMag} qtrs`);
  } else if (streakMag >= 3) {
    parts.push(`${streakMag}-qtr streak`);
  }

  if (calc.eliteAdders2 >= 2) parts.push(`${calc.eliteAdders2} elite adds`);

  // weight trend: cross-sectional conviction percentile moved ≥ 15 pts over lookback.
  if (Math.abs(convictionPct - convictionPctLookback) >= 0.15 && calc.medianWeight != null && calc.medianWeightLookbackAgo != null) {
    parts.push(`wt ${round(calc.medianWeightLookbackAgo, 1)}→${round(calc.medianWeight, 1)}%`);
  }

  // capital dominates: |flowz_cap| meaningfully exceeds |flowz_counts|.
  const capDominates = Math.abs(flowzCap) > Math.abs(flowzCounts) * 1.5 && Math.abs(calc.wflowBps) >= 1;
  const flatHolders = Math.abs(calc.holders - calc.holdersLookbackAgo) <= 1;
  if (calc.singleFundCapital) {
    parts.push("single-fund");
  } else if (capDominates) {
    const bps = Math.round(calc.wflowBps);
    parts.push(`${flowSign >= 0 ? "deepening" : "trimming"}: ${bps > 0 ? "+" : ""}${bps} bps${flatHolders ? ", flat holders" : ""}`);
  }

  // Fallbacks so a row is never blank.
  if (parts.length === 0) {
    const initiations = calc.flows[calc.flows.length - 1]?.adders ?? 0;
    if (initiations > 0) parts.push(`${initiations} adders`);
    else parts.push(flowSign >= 0 ? "net accumulation" : "net distribution");
  }

  // Trim to ~8 words.
  const joined = parts.join(" · ");
  const words = joined.split(/\s+/);
  return words.length > 8 ? words.slice(0, 8).join(" ") : joined;
}

/** Min-max rescale of magnitudes to 0-100. Empty/degenerate → all 100. */
function rescale(mags: number[]): number[] {
  if (mags.length === 0) return [];
  const min = Math.min(...mags);
  const max = Math.max(...mags);
  if (max === min) return mags.map(() => 100);
  return mags.map((m) => round((100 * (m - min)) / (max - min)));
}

export function computeLeaderboard(tickers: TickerIngredients[], config: FlowLeaderboardConfig): Leaderboard {
  const calcs = tickers.map((t) => computeTickerCalc(t, config)).filter((c): c is TickerCalc => c !== null);

  // ── Mega-cap gate: exclude the top-N names by point-in-time market cap. ──
  const withMcap = calcs.filter((c) => c.latest.marketCapUsd != null && Number.isFinite(c.latest.marketCapUsd));
  const megaCapExcluded = new Set(
    [...withMcap]
      .sort((a, b) => (b.latest.marketCapUsd! - a.latest.marketCapUsd!) || a.t.ticker.localeCompare(b.t.ticker))
      .slice(0, config.gates.exclude_top_n_by_mcap)
      .map((c) => c.t.ticker),
  );

  const gatedOut: GatedOutRow[] = [];
  const gated: TickerCalc[] = [];
  for (const c of calcs) {
    const reasons: string[] = [];
    if (c.holders < config.gates.min_holders) reasons.push(`only ${c.holders} holders`);
    const passesFlow = Math.abs(c.wflow) >= config.gates.min_abs_wflow || Math.abs(c.wflowBps) >= config.gates.min_abs_wflow_bps;
    if (!passesFlow) reasons.push("flow below threshold");
    if (megaCapExcluded.has(c.t.ticker)) reasons.push("mega-cap (flow is noise)");
    if (reasons.length === 0) gated.push(c);
    else gatedOut.push({ ticker: c.t.ticker, companyName: c.t.companyName ?? null, holders: c.holders, wflow: c.wflow, wflowBps: c.wflowBps, reason: reasons.join("; ") });
  }

  if (gated.length === 0) return { accumulation: [], distribution: [], gatedOut };

  // ── Cross-sectional z-scores over the GATED set this quarter. ──
  const wflowZ = zScore(gated.map((c) => c.wflow));
  const relflowZ = zScore(gated.map((c) => c.relflow));
  const wflowBpsZ = zScore(gated.map((c) => c.wflowBps));

  // Conviction percentile (cross-sectional, latest and lookback-ago).
  const medWeights = gated.map((c) => c.medianWeight).filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);
  const medWeightsLb = gated.map((c) => c.medianWeightLookbackAgo).filter((v): v is number => v != null && Number.isFinite(v)).sort((a, b) => a - b);

  const cb = config.count_vs_capital_blend;
  const rb = config.raw_vs_relative_blend;

  interface Scored extends TickerCalc {
    flowzCounts: number;
    flowzCap: number;
    flowz: number;
    convictionPct: number;
    convictionPctLb: number;
    rawScore: number;
    reason: string;
  }
  const scored: Scored[] = gated.map((c, i) => {
    const flowzCounts = rb * (wflowZ[i] ?? 0) + (1 - rb) * (relflowZ[i] ?? 0);
    const flowzCap = wflowBpsZ[i] ?? 0;
    const flowz = cb * flowzCounts + (1 - cb) * flowzCap;

    const convictionPct = c.medianWeight != null ? percentileOf(medWeights, c.medianWeight) : 0.5;
    const convictionPctLb = c.medianWeightLookbackAgo != null ? percentileOf(medWeightsLb, c.medianWeightLookbackAgo) : convictionPct;

    const streakMag = Math.abs(c.streak);
    const streakMult = streakMag >= 2 ? Math.min(1 + config.streak_bonus_per_qtr * (streakMag - 1), config.streak_bonus_cap) : 1;
    const convict = mapRange(convictionPct, config.conviction_mult_range);
    const elite = Math.min(1 + config.elite_bonus_per_fund * c.eliteAdders2, config.elite_bonus_cap);
    const rawScore = flowz * streakMult * convict * elite;

    const reason = buildReason(c, flowzCounts, flowzCap, convictionPct, convictionPctLb);
    return { ...c, flowzCounts: round(flowzCounts, 4), flowzCap: round(flowzCap, 4), flowz: round(flowz, 4), convictionPct: round(convictionPct, 4), convictionPctLb, rawScore, reason };
  });

  const accRaw = scored.filter((s) => s.flowz > 0);
  const disRaw = scored.filter((s) => s.flowz < 0);

  const finalize = (rows: Scored[], size: number): ScoredRow[] => {
    const scores = rescale(rows.map((r) => Math.abs(r.rawScore)));
    const withScore = rows.map((r, i) => ({ r, score: scores[i]! }));
    // Fixed sort by score desc; deterministic ticker tiebreak.
    withScore.sort((a, b) => b.score - a.score || Math.abs(b.r.rawScore) - Math.abs(a.r.rawScore) || a.r.t.ticker.localeCompare(b.r.t.ticker));
    return withScore.slice(0, size).map(({ r, score }, i) => ({
      rank: i + 1,
      ticker: r.t.ticker,
      companyName: r.t.companyName ?? null,
      score,
      rawScore: round(r.rawScore, 4),
      flowz: r.flowz,
      flowzCounts: r.flowzCounts,
      flowzCap: r.flowzCap,
      wflow: r.wflow,
      wflowBps: r.wflowBps,
      streak: r.streak,
      convictionPct: r.convictionPct,
      medianWeight: r.medianWeight,
      holders: r.holders,
      eliteAdders2: r.eliteAdders2,
      reason: r.reason,
      partialData: r.partialData,
      marketCapUsd: r.latest.marketCapUsd,
      cells: heatCells(r, config.adder_threshold_pct),
    }));
  };

  return {
    accumulation: finalize(accRaw, config.board_size.accumulation),
    distribution: finalize(disRaw, config.board_size.distribution),
    gatedOut,
  };
}
