/**
 * Pairs tab — raw, cross-group-comparable breadth. No I/O.
 *
 * WHY NOT z-scores (brief §3): the platform z-scores signals WITHIN subsector,
 * so every subsector averages ~0 and every cross-group differential of those
 * z's is ~0 — they cannot be compared across groups. Breadth counts HOW MANY
 * names are moving (not how much any one moved), is un-normalised, and is
 * therefore comparable: "71% of semis raised vs 38% of software" is a real
 * statement. Known tradeoff: breadth is magnitude-blind (one 40% raise counts
 * the same as a 1% nudge) — correct for a discovery screen that must not be
 * hijacked by a single revision. A magnitude column, if ever wanted, is a
 * SEPARATE column, never blended in (§3).
 */

/** A single name's direction within a group: +1 improving, -1 deteriorating, 0 flat. */
export type BreadthDirection = -1 | 0 | 1;

export interface BreadthMember {
  ticker: string;
  direction: BreadthDirection;
  /** Market cap for the cap-weighted variant; null names are dropped from CAP. */
  marketCap?: number | null;
}

export interface BreadthResult {
  /** 100 * (improving - deteriorating) / n, in percentage points. Null when n = 0. */
  breadth: number | null;
  n: number;
  improving: number;
  deteriorating: number;
  flat: number;
}

/** Equal-weighted breadth: one name, one vote (matches the small/mid-cap focus). */
export function groupBreadth(members: BreadthMember[]): BreadthResult {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const m of members) {
    if (m.direction > 0) up++;
    else if (m.direction < 0) down++;
    else flat++;
  }
  const n = members.length;
  return {
    breadth: n === 0 ? null : (100 * (up - down)) / n,
    n,
    improving: up,
    deteriorating: down,
    flat,
  };
}

/**
 * Cap-weighted breadth: each name's vote is weighted by market value, so a few
 * mega-caps can dominate. Stored beside the equal-weighted number; their
 * difference is a displayed column (§4.2). Names with no cap are dropped.
 */
export function capWeightedBreadth(members: BreadthMember[]): BreadthResult {
  const withCap = members.filter(
    (m) => m.marketCap !== null && m.marketCap !== undefined && Number.isFinite(m.marketCap) && m.marketCap! > 0,
  );
  const total = withCap.reduce((a, m) => a + (m.marketCap ?? 0), 0);
  let up = 0;
  let down = 0;
  let flat = 0;
  let signed = 0;
  for (const m of withCap) {
    const w = (m.marketCap ?? 0) / (total || 1);
    if (m.direction > 0) {
      up++;
      signed += w;
    } else if (m.direction < 0) {
      down++;
      signed -= w;
    } else flat++;
  }
  return {
    breadth: withCap.length === 0 || total <= 0 ? null : 100 * signed,
    n: withCap.length,
    improving: up,
    deteriorating: down,
    flat,
  };
}

/** Long-leg breadth minus short-leg breadth (pp). Null if either side is null. */
export function breadthGap(longBreadth: number | null, shortBreadth: number | null): number | null {
  if (longBreadth === null || shortBreadth === null) return null;
  if (!Number.isFinite(longBreadth) || !Number.isFinite(shortBreadth)) return null;
  return longBreadth - shortBreadth;
}

/**
 * Engine 1 direction from raw target-revision counts on RevisionScreenRow: a
 * name is improving when more analysts raised than cut its target this week.
 * This is a RAW count comparison, never a z-score.
 */
export function e1Direction(ptUp: number, ptDown: number): BreadthDirection {
  if (ptUp > ptDown) return 1;
  if (ptDown > ptUp) return -1;
  return 0;
}

/**
 * Breadth of crowding: the percent of a basket's names whose "% of tracked
 * funds" exceeds `minPct` (the universe p90) — the CONCENTRATION measure. This
 * is deliberately NOT the basket mean, which averages a couple of heavily-held
 * names down into a small number and hides how broadly the basket is crowded.
 * Non-finite / missing values are dropped; null when nothing is known (§3).
 */
export function crowdBreadthPct(pctOfFunds: Array<number | null | undefined>, minPct: number): number | null {
  const vals = pctOfFunds.filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  if (vals.length === 0) return null;
  return (100 * vals.filter((v) => v > minPct).length) / vals.length;
}

/** Share of a group that raised / cut (for the matrix hover arithmetic). */
export function upDownPct(members: BreadthMember[]): { upPct: number | null; downPct: number | null } {
  const n = members.length;
  if (n === 0) return { upPct: null, downPct: null };
  const up = members.filter((m) => m.direction > 0).length;
  const down = members.filter((m) => m.direction < 0).length;
  return { upPct: (100 * up) / n, downPct: (100 * down) / n };
}
