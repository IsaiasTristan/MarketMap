/**
 * Stock-rotation ranking (pure) — the single-name rotation board.
 *
 * Raw diffusion saturates: a 3-of-3 name reads 100% and ties dozens of others,
 * so the board degrades to DB (≈ alphabetical) order. This module fixes both:
 *
 *   - shrunk diffusion  sd = (in − out) / (n + k)   — a 3-of-3 name reads 43%,
 *     never 100%, so breadth is rewarded over tiny unanimity.
 *   - rank score        sd · ln(1 + n) · √|net_bps| — combines direction+breadth,
 *     participation, and move magnitude into one strictly-ordered score.
 *
 * Boards show only the TOP-N accumulation and BOTTOM-N distribution names; the
 * long tail is reachable via the searchable list. Sort is strict: rank score,
 * then |net $|, then ticker as a last resort — alphabetical order is impossible.
 */

export type SizeFilter = "all" | "ex-mega" | "mega-only";

export interface StockRotationInput {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  marketCapTier: string | null;
  fundsIn: number | null;
  fundsOut: number | null;
  fundsParticipating: number | null;
  /** Avg deliberate weight move (bps of book) — the magnitude term. */
  activeBpsAvg: number | null;
  dollarNetFlow: number | null;
  // Legacy holder counts kept for the tooltip.
  fundsBought: number;
  fundsSold: number;
  fundsHolding: number;
}

export interface RankedStockRow extends StockRotationInput {
  shrunkDiffusionPct: number;
  rankScore: number;
}

/** Shrunk diffusion %: (in − out) / (n + k) × 100, signed, |·| < 100 for k>0. */
export function shrunkDiffusionPct(inN: number, outN: number, participating: number, k: number): number {
  if (participating <= 0) return 0;
  return Math.round((((inN - outN) / (participating + k)) * 100) * 100) / 100;
}

/** Rank score = sd · ln(1 + n) · √|net_bps|. Sign carried by sd. */
export function stockRankScore(sd: number, participating: number, netBps: number): number {
  return sd * Math.log(1 + participating) * Math.sqrt(Math.abs(netBps));
}

/**
 * Rotation v3 Part 1a — participation-weighted mean of a set of diffusion values.
 * Rotation is inherently relative ("where is money going vs the average sector"),
 * so each sector's diffusion is reported as a deviation from this mean. Weighting
 * by participating funds keeps a thin sector from swinging the baseline. The
 * participation-weighted sum of `value − mean` is 0 by construction.
 */
export function participationWeightedMean(rows: Array<{ value: number; weight: number }>): number {
  let sw = 0;
  let swv = 0;
  for (const r of rows) {
    const w = Math.max(0, r.weight);
    sw += w;
    swv += r.value * w;
  }
  return sw > 0 ? swv / sw : 0;
}

/**
 * Rotation v3 Part 3 — rescale scores to a 0–100 board-relative index (leaderboard
 * convention) so the sort key is VISIBLE. Preserves order; the max |score| maps to
 * 100, everything else scales linearly by magnitude. Sign is dropped (accumulation
 * and distribution boards are separate), so a distribution row's 100 means "most
 * extreme outflow on the board". Returns 0 for an all-zero board.
 */
export function rescaleScore0to100(scores: number[]): number[] {
  const max = Math.max(0, ...scores.map((s) => Math.abs(s)));
  if (max <= 0) return scores.map(() => 0);
  return scores.map((s) => Math.round((Math.abs(s) / max) * 1000) / 10);
}

/**
 * Diffusion context for a bucket from its own quarterly series (ascending by
 * period): last quarter's value (ghost tick), the trailing 4-quarter history
 * (tooltip), and the percentile of the current |diffusion| within its trailing
 * 12-quarter |diffusion| distribution (how unusual this quarter's move is).
 */
export interface DiffusionContext {
  prior: number | null;
  history: number[];
  percentile: number | null;
}
export function diffusionContext(series: Array<{ period: string; value: number }>, currentPeriod: string): DiffusionContext {
  const sorted = [...series].sort((a, b) => (a.period < b.period ? -1 : a.period > b.period ? 1 : 0));
  const idx = sorted.findIndex((s) => s.period === currentPeriod);
  if (idx < 0) return { prior: null, history: [], percentile: null };
  const prior = idx > 0 ? sorted[idx - 1]!.value : null;
  const history = sorted.slice(Math.max(0, idx - 3), idx + 1).map((s) => s.value);
  const trailing = sorted.slice(Math.max(0, idx - 11), idx + 1).map((s) => Math.abs(s.value));
  const cur = Math.abs(sorted[idx]!.value);
  const pct =
    trailing.length >= 4 ? Math.round((trailing.filter((v) => v <= cur).length / trailing.length) * 100) : null;
  return { prior, history, percentile: pct };
}

/**
 * Part 4 — concentration flag: the single name carrying the largest share of a
 * bucket's |net $|, when that share meets the threshold. Returns null when the
 * bucket is empty/flat or no name dominates. (One dominant name means the bucket's
 * "diffusion" is really one trade, not a migration.)
 */
export function dominantConcentration(items: Array<{ ticker: string; dollarNetFlow: number | null }>, thresholdPct: number): { ticker: string; pct: number } | null {
  const total = items.reduce((s, r) => s + Math.abs(r.dollarNetFlow ?? 0), 0);
  if (total <= 0) return null;
  const top = items.reduce((a, b) => (Math.abs(b.dollarNetFlow ?? 0) > Math.abs(a.dollarNetFlow ?? 0) ? b : a));
  const pct = Math.round((Math.abs(top.dollarNetFlow ?? 0) / total) * 100);
  return pct >= thresholdPct ? { ticker: top.ticker, pct } : null;
}

/**
 * Part 5 — divergence marker: breadth (diffusion) and dollars disagree, and BOTH
 * clear their noise floors. A broad migration whose dollars are dominated by one
 * whale's opposite trade (or vice-versa) — the ⇄ marker. Below either floor there
 * is no marker (rounding noise shouldn't flag).
 */
export function diffusionDollarsDiverge(diffusionPct: number, dollarNetFlow: number, minDiffPct: number, minDollars: number): boolean {
  const sd = Math.sign(diffusionPct);
  const dd = Math.sign(dollarNetFlow);
  return sd !== 0 && dd !== 0 && sd !== dd && Math.abs(diffusionPct) >= minDiffPct && Math.abs(dollarNetFlow) >= minDollars;
}

function passesSize(tier: string | null, filter: SizeFilter): boolean {
  if (filter === "ex-mega") return tier !== "mega";
  if (filter === "mega-only") return tier === "mega";
  return true;
}

/** Strict comparator: rank score, then |net $|, then ticker (last resort only). */
function byRank(dir: "desc" | "asc") {
  return (a: RankedStockRow, b: RankedStockRow): number => {
    const s = dir === "desc" ? b.rankScore - a.rankScore : a.rankScore - b.rankScore;
    if (s !== 0) return s;
    const d = Math.abs(b.dollarNetFlow ?? 0) - Math.abs(a.dollarNetFlow ?? 0);
    if (d !== 0) return d;
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  };
}

export interface StockRotationResult {
  accumulation: RankedStockRow[];
  distribution: RankedStockRow[];
  /** All non-vehicle names scored (for the search box), sorted by |rank score|. */
  searchable: RankedStockRow[];
  /** Count of names meeting the participation + size floor (board eligible). */
  qualifying: number;
}

export interface RankStockOptions {
  minParticipants: number;
  k: number;
  boardSize: number;
  sizeFilter: SizeFilter;
}

export function rankStockRotation(rows: StockRotationInput[], opts: RankStockOptions): StockRotationResult {
  const { minParticipants, k, boardSize, sizeFilter } = opts;
  const scored: RankedStockRow[] = rows
    .filter((r) => passesSize(r.marketCapTier, sizeFilter))
    .map((r) => {
      const n = r.fundsParticipating ?? 0;
      const sd = shrunkDiffusionPct(r.fundsIn ?? 0, r.fundsOut ?? 0, n, k);
      const rankScore = stockRankScore(sd, n, r.activeBpsAvg ?? 0);
      return { ...r, shrunkDiffusionPct: sd, rankScore };
    });

  const eligible = scored.filter((r) => (r.fundsParticipating ?? 0) >= minParticipants);
  const accumulation = eligible.filter((r) => r.shrunkDiffusionPct > 0).sort(byRank("desc")).slice(0, boardSize);
  const distribution = eligible.filter((r) => r.shrunkDiffusionPct < 0).sort(byRank("asc")).slice(0, boardSize);
  // Searchable: everything scored (incl. below-threshold), most-active first.
  const searchable = scored.slice().sort((a, b) => Math.abs(b.rankScore) - Math.abs(a.rankScore));
  return { accumulation, distribution, searchable, qualifying: eligible.length };
}
