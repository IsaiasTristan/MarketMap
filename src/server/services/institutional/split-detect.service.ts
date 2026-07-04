/**
 * Engine 3 — self-healing split detection.
 *
 * 13F `shares` are RAW reported counts with no split adjustment, so a 2:1 split
 * makes every holder look like it doubled its position (a false wave of adders),
 * and a reverse split looks like mass trimming. We detect splits from the data
 * itself, corroborate them, and only then adjust:
 *
 *   1. Cross-sectional detector — for a (ticker, quarter) transition, ≥70% of
 *      continuing holders (min 5) share a common share ratio R outside [0.9, 1.1].
 *   2. Implied-price corroboration — the same holders' median implied-price ratio
 *      ip(q)/ip(q-1) (ip = value/shares) times R must land in a plausible quarterly
 *      gross-return band [0.5, 2.0]. A true split leaves economic value ~unchanged,
 *      so price moves inversely to the share ratio; genuine accumulation (shares AND
 *      value both up, price flat) fails this and is left alone.
 *
 * Both fingerprints agree ⇒ a `derived` CorporateAction with ratio R (adjust,
 * keep the name on the board, log for review). Detector fires but corroboration
 * fails / too few funds / weak agreement ⇒ an UNRESOLVED_SPLIT data hold; never
 * guess. The core here is pure & DB-free for unit testing; the loader/writer that
 * reads FundHoldingSnapshot and writes CorporateAction / DataQualityEvent is thin.
 */
import { FLOW_LEADERBOARD_CONFIG, type SplitDetectConfig } from "@/domain/calculations/flow-leaderboard-config";

/** One continuing holder's shares/value across the transition (q-1 → q). */
export interface ContinuingHolder {
  fundId: string;
  prevShares: number;
  curShares: number;
  prevValue: number;
  curValue: number;
}

export type SplitVerdict =
  | { kind: "none" } // detector never fired — no coordinated ratio
  | { kind: "split"; ratio: number; confidence: number; nFunds: number } // corroborated derived split
  | { kind: "unresolved"; ratio: number; agreement: number; nFunds: number; why: string }; // data hold

function median(vals: number[]): number | null {
  if (vals.length === 0) return null;
  const s = [...vals].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Round a share ratio to the nearest simple split ratio (2, 3, 1/2, 3/2, …). */
function snapRatio(r: number): number {
  // Candidate split ratios: N:1 and 1:N and 3:2 / 2:3 for N up to 10.
  const candidates: number[] = [];
  for (let n = 2; n <= 10; n++) {
    candidates.push(n, 1 / n);
  }
  candidates.push(3 / 2, 2 / 3, 5 / 2, 2 / 5, 5 / 4, 4 / 5);
  let best = r;
  let bestErr = Infinity;
  for (const c of candidates) {
    const err = Math.abs(Math.log(r / c));
    if (err < bestErr) {
      bestErr = err;
      best = c;
    }
  }
  // Only snap if within ~7% (log space); else keep the raw ratio.
  return bestErr <= 0.07 ? best : r;
}

/**
 * Detect a split for one (ticker, quarter) transition from its continuing holders.
 * Pure. `config` defaults to FLOW_LEADERBOARD_CONFIG.split_detect.
 */
export function detectSplit(
  holders: ContinuingHolder[],
  cfg: SplitDetectConfig = FLOW_LEADERBOARD_CONFIG.split_detect,
): SplitVerdict {
  const valid = holders.filter((h) => h.prevShares > 0 && h.curShares > 0);
  if (valid.length < cfg.min_funds) return { kind: "none" };

  const [loBand, hiBand] = cfg.ratio_band;
  // Per-holder share ratio, snapped to the nearest simple split ratio.
  const ratios = valid.map((h) => snapRatio(h.curShares / h.prevShares));
  // Group by snapped ratio; find the dominant one that is outside the no-change band.
  const groups = new Map<number, number>();
  for (const r of ratios) {
    if (r >= loBand && r <= hiBand) continue; // no-change holder
    groups.set(r, (groups.get(r) ?? 0) + 1);
  }
  if (groups.size === 0) return { kind: "none" };

  let R = 0;
  let count = 0;
  for (const [r, c] of groups) if (c > count) ((R = r), (count = c));

  const agreement = count / valid.length;
  if (agreement < 0.5) return { kind: "none" }; // scattered — not coordinated (e.g. a crash quarter)

  // Below the required super-majority but coordinated enough to be suspicious → hold.
  if (agreement < cfg.min_ratio_holders_pct) {
    return { kind: "unresolved", ratio: R, agreement, nFunds: count, why: `only ${(agreement * 100).toFixed(0)}% of holders share ratio ${R}` };
  }

  // ── Implied-price corroboration on the holders that share ratio R. ──
  const matching = valid.filter((h) => snapRatio(h.curShares / h.prevShares) === R);
  const priceRatios: number[] = [];
  for (const h of matching) {
    const ipPrev = h.prevValue / h.prevShares;
    const ipCur = h.curValue / h.curShares;
    if (ipPrev > 0 && ipCur > 0) priceRatios.push(ipCur / ipPrev);
  }
  const medPriceRatio = median(priceRatios);
  if (medPriceRatio === null) {
    return { kind: "unresolved", ratio: R, agreement, nFunds: count, why: "no implied prices to corroborate" };
  }

  // For a true split, economic value is ~conserved, so price scales by ~1/R and
  // medPriceRatio·R ≈ the quarter's real gross stock return — which must be
  // economically plausible. Three outcomes on the price fingerprint:
  //   • grossReturn plausible  → a real split: adjust.
  //   • price ~flat (value scaled WITH shares, medPriceRatio ≈ 1) → NOT a split,
  //     it's genuine coordinated accumulation/distribution: leave alone (real
  //     adders/reducers), no hold.
  //   • otherwise (implausible return AND price didn't scale cleanly) → truly
  //     ambiguous: UNRESOLVED_SPLIT data hold; never guess.
  const grossReturn = medPriceRatio * R;
  const [loRet, hiRet] = cfg.quarterly_return_band;
  if (grossReturn >= loRet && grossReturn <= hiRet) {
    const confidence = Math.min(1, agreement) * (count >= cfg.min_funds ? 1 : count / cfg.min_funds);
    return { kind: "split", ratio: R, confidence: Number(confidence.toFixed(3)), nFunds: count };
  }
  const priceIsFlat = Math.abs(Math.log(medPriceRatio)) < 0.15; // ≲15% either way
  if (priceIsFlat) {
    // Value moved with shares → a real position change, not a split.
    return { kind: "none" };
  }
  return {
    kind: "unresolved",
    ratio: R,
    agreement,
    nFunds: count,
    why: `share ratio ${R} but price fingerprint implies ${grossReturn.toFixed(2)}× gross return — ambiguous, holding for review`,
  };
}

/** Apply a split ratio to a raw share count (prior shares → adjusted comparable basis). */
export function adjustSharesForSplit(shares: number, ratio: number): number {
  return shares * ratio;
}
