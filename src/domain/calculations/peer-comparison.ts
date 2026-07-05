/**
 * Fund Overview — peer comparisons (Part 2), pure & DB-free.
 *
 * Style twins (cosine similarity over a z-scored, group-weighted style vector),
 * book overlap, percentile-within-set (with a too-small guard), and differentiated
 * ideas. The loader supplies aligned inputs (same sector/size-band column order
 * across funds) and reads the knobs from FUND_OVERVIEW_CONFIG.
 */
import { type FundOverviewConfig, FUND_OVERVIEW_CONFIG } from "./fund-overview-config";

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
/** A column whose stddev is below this carries no signal → z of 0 (no NaN division). */
const DEGENERATE_STD_EPS = 1e-9;

/** One holding as a fraction of the fund's book. */
export interface WeightedHolding {
  ticker: string;
  weight: number; // fraction of book (0..1)
}

/** A fund's raw style ingredients. sectorMix / sizeBandMix are aligned across funds. */
export interface StyleComponents {
  sectorMix: number[]; // partition weights (sum ≈ 1), fixed sector column order
  sizeBandMix: number[]; // band weights (sum ≈ 1), fixed band order
  top10: number; // top-10 concentration (fraction)
  turnover: number; // %/q (or fraction — caller must be consistent)
  medianTenure: number; // quarters
}

export type StyleWeights = FundOverviewConfig["style_vector"];

/** Z-score each column across rows; a degenerate (near-constant) column → all zeros. */
export function zScoreColumns(rows: number[][], eps: number = DEGENERATE_STD_EPS): number[][] {
  const n = rows.length;
  if (n === 0) return [];
  const cols = rows[0]!.length;
  const out = rows.map(() => new Array<number>(cols).fill(0));
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (let r = 0; r < n; r++) sum += rows[r]![c]!;
    const mean = sum / n;
    let variance = 0;
    for (let r = 0; r < n; r++) variance += (rows[r]![c]! - mean) ** 2;
    const std = Math.sqrt(variance / n);
    if (std < eps) continue; // degenerate → leave as 0
    for (let r = 0; r < n; r++) out[r]![c] = (rows[r]![c]! - mean) / std;
  }
  return out;
}

/**
 * Build the z-scored, group-weighted style matrix (one row per fund, aligned columns).
 * Each group's columns are scaled by √(weight/columnsInGroup) so a group's contribution
 * to cosine similarity is proportional to its configured weight regardless of how many
 * sectors/bands it spans (cosine sees squared magnitudes → the √).
 */
export function styleMatrix(
  funds: StyleComponents[],
  w: StyleWeights,
  eps: number = DEGENERATE_STD_EPS,
): number[][] {
  if (funds.length === 0) return [];
  const nSectors = funds[0]!.sectorMix.length;
  const nBands = funds[0]!.sizeBandMix.length;
  const raw = funds.map((f) => [...f.sectorMix, ...f.sizeBandMix, f.top10, f.turnover, f.medianTenure]);
  const z = zScoreColumns(raw, eps);
  const sSector = nSectors > 0 ? Math.sqrt(w.sectorMix / nSectors) : 0;
  const sBand = nBands > 0 ? Math.sqrt(w.sizeBand / nBands) : 0;
  const sTop10 = Math.sqrt(w.top10);
  const sTurn = Math.sqrt(w.turnover);
  const sTen = Math.sqrt(w.tenure);
  return z.map((row) => {
    const scaled = row.slice();
    let i = 0;
    for (let k = 0; k < nSectors; k++, i++) scaled[i]! *= sSector;
    for (let k = 0; k < nBands; k++, i++) scaled[i]! *= sBand;
    scaled[i]! *= sTop10;
    i++;
    scaled[i]! *= sTurn;
    i++;
    scaled[i]! *= sTen;
    return scaled;
  });
}

/** Cosine similarity; 0 if either vector has zero norm. */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na <= 0 || nb <= 0) return 0;
  return round4(dot / (Math.sqrt(na) * Math.sqrt(nb)));
}

export interface Twin {
  fundId: string;
  similarity: number;
}

/**
 * Top-k nearest style neighbors of `selfId`, excluding self, deterministic
 * (ties broken by fundId). `vectors` maps fundId → style vector (same basis).
 */
export function topTwins(selfId: string, vectors: Map<string, number[]>, k: number): Twin[] {
  const self = vectors.get(selfId);
  if (!self) return [];
  const sims: Twin[] = [];
  for (const [fundId, vec] of vectors) {
    if (fundId === selfId) continue;
    sims.push({ fundId, similarity: cosineSimilarity(self, vec) });
  }
  sims.sort((a, b) => (b.similarity !== a.similarity ? b.similarity - a.similarity : a.fundId < b.fundId ? -1 : 1));
  return sims.slice(0, k);
}

/**
 * Value-weighted share of common holdings = Σ over shared names of
 * min(weight_A, weight_B), ×100. Symmetric, bounded [0, 100].
 */
export function overlapScore(a: WeightedHolding[], b: WeightedHolding[]): number {
  const wa = new Map(a.map((h) => [h.ticker, h.weight]));
  let sum = 0;
  for (const h of b) {
    const other = wa.get(h.ticker);
    if (other != null) sum += Math.min(other, h.weight);
  }
  return round2(Math.max(0, Math.min(1, sum)) * 100);
}

export interface PercentileResult {
  percentile: number | null; // 0..100, or null when the set is too small
  tooSmall: boolean;
}

/**
 * Percentile rank of `value` within `setValues`. Sets smaller than peer_min_size
 * render "too small to rank" (null) rather than a misleading percentile.
 */
export function percentileInSet(
  value: number,
  setValues: number[],
  cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG,
): PercentileResult {
  const xs = setValues.filter((v) => Number.isFinite(v));
  if (xs.length < cfg.peer_min_size) return { percentile: null, tooSmall: true };
  let below = 0;
  let equal = 0;
  for (const v of xs) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  const rank = below + 0.5 * equal;
  return { percentile: Math.round((rank / xs.length) * 100), tooSmall: false };
}

/**
 * Names this fund holds at ≥ diff_ideas_min_bps that NO fund in the peer set holds
 * at ≥ the same floor. Returned descending by this fund's weight.
 */
export function differentiatedIdeas(
  fund: WeightedHolding[],
  peers: WeightedHolding[][],
  cfg: FundOverviewConfig = FUND_OVERVIEW_CONFIG,
): string[] {
  const floor = cfg.diff_ideas_min_bps / 10_000; // bps → fraction
  const peerHeld = new Set<string>();
  for (const p of peers) {
    for (const h of p) if (h.weight >= floor) peerHeld.add(h.ticker);
  }
  return fund
    .filter((h) => h.weight >= floor && !peerHeld.has(h.ticker))
    .sort((a, b) => b.weight - a.weight)
    .map((h) => h.ticker);
}
