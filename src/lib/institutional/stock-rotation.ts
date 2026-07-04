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
