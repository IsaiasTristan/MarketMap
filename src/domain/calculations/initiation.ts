/**
 * Initiation significance (Part 1b) — pure, DB-free.
 *
 * A new 13F position is NOT a binary +1 vote. It is scored by how large the
 * entry is RELATIVE to the initiating fund's own typical position:
 *
 *   entry_bps   = position weight in the fund's book at q (bps of book)
 *   sizing_mult = entry_bps / median position weight of the fund's book at q
 *   qualified   ⟺ entry_bps ≥ min_entry_bps AND sizing_mult ≥ min_sizing_mult
 *   strength    = min(sizing_mult, strength_cap)     (per-fund weight downstream)
 *
 * A concentrated fund entering at its own median size scores 1.0 (no boost); a
 * broad fund entering at 4× its median scores up to the cap. Concentration
 * alone is not conviction — RELATIVE sizing is.
 *
 * Guards (emit ZERO initiations): a fund's first-ever 13F; the first filing
 * after a > gap_quarters gap; any filing with < min_positions holdings.
 *
 * Consumed by the cluster detector, WHO chips, event feed, and trajectory
 * evidence chips. All thresholds live in INITIATION_CONFIG.
 */

export interface InitiationConfig {
  /** Minimum entry weight (bps of book) to count as a deliberate initiation. */
  min_entry_bps: number;
  /** Minimum entry-vs-median sizing ratio to qualify. */
  min_sizing_mult: number;
  /** A filing with fewer than this many long-equity positions emits none. */
  min_positions: number;
  /** initiation_strength is capped here. */
  strength_cap: number;
  /** First filing after a gap strictly greater than this (quarters) emits none. */
  gap_quarters: number;
}

export const INITIATION_CONFIG: InitiationConfig = {
  min_entry_bps: 25,
  min_sizing_mult: 0.5,
  min_positions: 8,
  strength_cap: 4.0,
  gap_quarters: 2,
};

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** Median of a numeric list (0 for empty). */
export function median(vals: number[]): number {
  const s = vals.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (s.length === 0) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/**
 * Sizing multiple of one position vs the median position of the same book.
 * Units cancel (both weights) so % or bps both work; 0 if the median is 0.
 * A position entered at the book's median size returns 1.0.
 */
export function sizingMult(positionWeight: number, bookWeights: number[]): number {
  const med = median(bookWeights);
  if (!(med > 0)) return 0;
  return round4(positionWeight / med);
}

/** One position in a fund's book at a quarter. `pctOfBook` is a percent (2 = 2%). */
export interface BookPosition {
  ticker: string;
  pctOfBook: number;
  isNew: boolean;
}

export interface InitiationInput {
  /** The fund's full long-equity book this quarter. */
  positions: BookPosition[];
  /** True if this is the fund's first-ever 13F in the tracked history. */
  isFirstFiling: boolean;
  /** Quarters since the fund's previous filing (null when first filing). */
  quartersSincePrevFiling: number | null;
}

export interface QualifiedInitiation {
  ticker: string;
  /** Entry weight in bps of book. */
  entryBps: number;
  sizingMult: number;
  /** min(sizingMult, strength_cap) — the per-fund weight in cluster/feed scores. */
  strength: number;
}

/**
 * Qualified initiations for one fund at one quarter, with per-fund weights.
 * Returns [] under any guard.
 */
export function detectInitiations(
  input: InitiationInput,
  config: InitiationConfig = INITIATION_CONFIG,
): QualifiedInitiation[] {
  const { positions, isFirstFiling, quartersSincePrevFiling } = input;
  // Guards: no prior baseline ⇒ every position looks "new".
  if (isFirstFiling) return [];
  if (quartersSincePrevFiling != null && quartersSincePrevFiling > config.gap_quarters) return [];
  if (positions.length < config.min_positions) return [];

  const bookWeights = positions.map((p) => p.pctOfBook).filter((w) => Number.isFinite(w) && w > 0);
  const medW = median(bookWeights);
  if (!(medW > 0)) return [];

  const out: QualifiedInitiation[] = [];
  for (const p of positions) {
    if (!p.isNew) continue;
    const entryBps = p.pctOfBook * 100;
    const mult = p.pctOfBook / medW;
    if (entryBps >= config.min_entry_bps && mult >= config.min_sizing_mult) {
      out.push({
        ticker: p.ticker,
        entryBps: round4(entryBps),
        sizingMult: round4(mult),
        strength: round4(Math.min(mult, config.strength_cap)),
      });
    }
  }
  return out;
}
