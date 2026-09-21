/**
 * Pairs tab — Tier 2 leg selection (brief §4.3, §6.2, §6.4). No I/O.
 *
 * Tier 2 is a single-subsector spread: the top-k names on a ranking engine
 * (the long leg) against the bottom-k (the short leg). Quality kills come
 * FIRST — a name is REMOVED from selection, not merely annotated (§6.2) — and
 * removed names are returned so the UI can strike them through with the reason
 * (§6.4). Kills are SIDE-AWARE: a trap/accrual flag disqualifies a name from
 * the LONG leg only (a trap is still a fine short), and Engine-3 accumulation
 * disqualifies it from the SHORT leg only (funds buying it is a bullish tell,
 * so it stays longable). Ties break on ticker so reruns are identical.
 */

export interface Tier2Member {
  ticker: string;
  /** Higher = stronger long candidate (e.g. ptRevOrthZ, or E2 magnitude). */
  score: number;
  /** Trap/accrual reason that bars this name from the LONG leg (null = eligible). */
  longKillReason?: string | null;
  /** Engine-3 accumulation reason that bars this name from the SHORT leg. */
  shortKillReason?: string | null;
}

export interface Tier2Killed {
  ticker: string;
  side: "LONG" | "SHORT";
  score: number;
  reason: string;
}

export interface Tier2Selection {
  /** Top-k eligible names, strongest first. */
  longLeg: string[];
  /** Bottom-k eligible names, weakest first. */
  shortLeg: string[];
  /** Names that would have ranked into a leg but were killed, for display. */
  killed: Tier2Killed[];
}

const byScoreThenTicker = (a: Tier2Member, b: Tier2Member): number =>
  b.score - a.score || a.ticker.localeCompare(b.ticker);

/**
 * Kill first (side-aware), then take the top-k eligible longs and bottom-k
 * eligible shorts (disjoint). Returns null when either leg cannot be filled to
 * `k` after kills, so a half-built leg never becomes a pair (§6.2). The killed
 * list holds only names that a kill actually displaced from a leg — i.e. names
 * hit while walking down to the k-th survivor — so the UI strikes through
 * exactly the names that would otherwise have been in that leg.
 */
export function selectTopBottomK(members: Tier2Member[], k: number): Tier2Selection | null {
  if (k <= 0) return null;

  const ranked = members.filter((m) => Number.isFinite(m.score)).sort(byScoreThenTicker);
  const killed: Tier2Killed[] = [];

  // Long leg: walk from the strongest, killing trap names encountered en route.
  const longLeg: string[] = [];
  for (const m of ranked) {
    if (longLeg.length >= k) break;
    if (m.longKillReason) killed.push({ ticker: m.ticker, side: "LONG", score: m.score, reason: m.longKillReason });
    else longLeg.push(m.ticker);
  }
  const longSet = new Set(longLeg);

  // Short leg: walk from the weakest, skipping anything taken long, killing
  // Engine-3-accumulating names encountered en route.
  const shortLeg: string[] = [];
  for (let i = ranked.length - 1; i >= 0; i--) {
    if (shortLeg.length >= k) break;
    const m = ranked[i]!;
    if (longSet.has(m.ticker)) continue;
    if (m.shortKillReason) killed.push({ ticker: m.ticker, side: "SHORT", score: m.score, reason: m.shortKillReason });
    else shortLeg.push(m.ticker);
  }

  if (longLeg.length < k || shortLeg.length < k) return null;
  return { longLeg, shortLeg, killed };
}
