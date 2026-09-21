/**
 * Pairs tab — Tier 3 curated-link read-through logic (brief §4.4, §6.3). No I/O.
 *
 * A curated link says two companies are economically connected. A read-through
 * FIRES when one side's signal moves decisively (|z| >= firedZ) while the OTHER
 * side has not yet followed (|z| < quietZ). Status then progresses:
 *   NEW       — no lead this week (or a lead too fresh to surface).
 *   WATCH     — a lead has persisted watchWeeks weeks, other side still quiet
 *               (the tradeable window).
 *   CONFIRMED — the other side has since moved the EXPECTED way.
 *
 * Directionality:
 *   SUPPLIER_CUSTOMER — directional: only side A (the mover-first supplier) can
 *                       lead; a move on B is not a read-through into A.
 *   SUBSTITUTE        — either side leads; expected correlation POSITIVE.
 *   INPUT_COST        — either side leads; expected correlation NEGATIVE, so
 *                       CONFIRMED requires the follower moving the OPPOSITE way.
 *                       A same-direction move is explicitly NOT confirmation.
 *
 * A lead that runs past maxWeeks without confirmation expires back to NEW.
 */
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";

export type PairLinkRelation = "SUPPLIER_CUSTOMER" | "SUBSTITUTE" | "INPUT_COST";
export type PairLinkStatus = "NEW" | "WATCH" | "CONFIRMED";
export type FiredSide = "A" | "B";

export interface ReadThroughThresholds {
  firedZ: number;
  quietZ: number;
  watchWeeks: number;
  maxWeeks: number;
}

export interface ReadThroughInput {
  relation: PairLinkRelation;
  /** Signal z on side A this week (Engine 1 or 2), or null if unavailable. */
  scoreA: number | null;
  /** Signal z on side B this week, or null. */
  scoreB: number | null;
  /** Last week's status for this link (defaults NEW). */
  priorStatus?: PairLinkStatus;
  /** Which side led last week (defaults null). */
  priorFiredSide?: FiredSide | null;
  /** Consecutive weeks a lead has persisted (0 when there was no lead). */
  priorWeeksElapsed?: number;
}

export interface ReadThroughResult {
  status: PairLinkStatus;
  firedSide: FiredSide | null;
  firedScore: number | null;
  otherScore: number | null;
  /** Updated lead streak (0 on NEW/CONFIRMED, else weeks the lead has run). */
  weeksElapsed: number;
}

const RESET: ReadThroughResult = { status: "NEW", firedSide: null, firedScore: null, otherScore: null, weeksElapsed: 0 };

function defaults(): ReadThroughThresholds {
  return {
    firedZ: PAIR_THRESHOLDS.tier3FiredZ,
    quietZ: PAIR_THRESHOLDS.tier3QuietZ,
    watchWeeks: PAIR_THRESHOLDS.tier3WatchWeeks,
    maxWeeks: PAIR_THRESHOLDS.tier3MaxWeeks,
  };
}

/** Does the follower's move confirm the leader's, given the relation's sign? */
function confirms(relation: PairLinkRelation, scoreA: number, scoreB: number): boolean {
  const sameDirection = Math.sign(scoreA) === Math.sign(scoreB);
  return relation === "INPUT_COST" ? !sameDirection : sameDirection;
}

/** Evaluate one link for one week. Pure and deterministic. */
export function evaluateReadThrough(input: ReadThroughInput, thresholds: ReadThroughThresholds = defaults()): ReadThroughResult {
  const { relation, scoreA, scoreB } = input;
  const priorFiredSide = input.priorFiredSide ?? null;
  const priorWeeks = input.priorWeeksElapsed ?? 0;
  const { firedZ, quietZ, watchWeeks, maxWeeks } = thresholds;

  const aFired = scoreA !== null && Number.isFinite(scoreA) && Math.abs(scoreA) >= firedZ;
  const bFired = scoreB !== null && Number.isFinite(scoreB) && Math.abs(scoreB) >= firedZ;
  const aQuiet = scoreA === null || !Number.isFinite(scoreA) || Math.abs(scoreA) < quietZ;
  const bQuiet = scoreB === null || !Number.isFinite(scoreB) || Math.abs(scoreB) < quietZ;

  // Confirmation: a lead was already running and the follower has now moved the
  // expected way (both sides finite and firing with the right sign relationship).
  if (
    priorWeeks > 0 &&
    priorFiredSide !== null &&
    aFired &&
    bFired &&
    confirms(relation, scoreA as number, scoreB as number)
  ) {
    const fired = priorFiredSide === "A" ? scoreA : scoreB;
    const other = priorFiredSide === "A" ? scoreB : scoreA;
    return { status: "CONFIRMED", firedSide: priorFiredSide, firedScore: fired, otherScore: other, weeksElapsed: 0 };
  }

  // Which side, if any, leads this week (other side still quiet).
  let leader: FiredSide | null = null;
  if (aFired && bQuiet) leader = "A";
  else if (bFired && aQuiet && relation !== "SUPPLIER_CUSTOMER") leader = "B";

  if (leader === null) return RESET;

  // A lead that switched sides restarts the streak; otherwise it accrues.
  const streak = priorFiredSide === leader ? priorWeeks + 1 : 1;
  if (streak > maxWeeks) return RESET; // window expired without confirmation

  const fired = leader === "A" ? scoreA : scoreB;
  const other = leader === "A" ? scoreB : scoreA;
  return {
    status: streak >= watchWeeks ? "WATCH" : "NEW",
    firedSide: leader,
    firedScore: fired,
    otherScore: other,
    weeksElapsed: streak,
  };
}
