/**
 * Engine 1 — pure transition detection: given this week's computed metrics and
 * last week's persisted state, emit the threshold-crossing events that power
 * the SUMMARY tab (and the SignalTransition audit log). All thresholds come
 * from REVISION_THRESHOLDS — no magic numbers here. No I/O.
 *
 * Sign convention: gapScore = composite4wZ - px4wZ; positive = bullish
 * revisions the price hasn't matched (potential long).
 */
import type { RevisionGroupType, RevisionTransitionType } from "@prisma/client";
import { REVISION_THRESHOLDS, type RevisionThresholds } from "@/lib/revision/config";
import type { Streak } from "@/lib/revision/derived";

export type Side = "LONG" | "SHORT" | null;

export interface StockWeekMetrics {
  ticker: string;
  /** Decile within the PRIMARY peer group (matches newArrival semantics). */
  primaryDecile: number | null;
  gapScore: number | null;
  compositeZ: number | null;
  streak: Streak;
  priorSide: Side;
  priorStreak: Streak | null;
  daysToEarnings: number | null;
  peerGroupType: RevisionGroupType;
  peerGroupKey: string;
}

export interface GroupWeekMetrics {
  groupType: RevisionGroupType;
  groupKey: string;
  meanZ: number | null;
  priorMeanZ: number | null;
}

export interface TransitionDraft {
  type: RevisionTransitionType;
  ticker?: string;
  groupType?: RevisionGroupType;
  groupKey?: string;
  payload: Record<string, unknown>;
}

/**
 * Sticky side state machine. Entry needs BOTH the extreme primary decile and a
 * wide-enough gap; exit is the |gap| < gapClosedAbsGap hysteresis band, so a
 * name doesn't flap in and out on noise between 0.5 and 1.5.
 */
export function nextSide(
  priorSide: Side,
  primaryDecile: number | null,
  gapScore: number | null,
  t: RevisionThresholds = REVISION_THRESHOLDS,
): Side {
  if (priorSide === null) {
    if (primaryDecile === null || gapScore === null) return null;
    if (primaryDecile >= t.newFlagDecile && gapScore >= t.newFlagMinAbsGap) return "LONG";
    if (primaryDecile <= 11 - t.newFlagDecile && gapScore <= -t.newFlagMinAbsGap) return "SHORT";
    return null;
  }
  // Flagged: hold until the gap closes. A null gap (missing prices this week)
  // keeps the flag rather than silently exiting.
  if (gapScore !== null && Math.abs(gapScore) < t.gapClosedAbsGap) return null;
  return priorSide;
}

/** NEW_LONG / NEW_SHORT / GAP_CLOSED / STREAK_BROKEN for one week's cross-section. */
export function detectStockTransitions(
  rows: StockWeekMetrics[],
  t: RevisionThresholds = REVISION_THRESHOLDS,
): TransitionDraft[] {
  const out: TransitionDraft[] = [];
  for (const r of rows) {
    const side = nextSide(r.priorSide, r.primaryDecile, r.gapScore, t);
    if (r.priorSide === null && side !== null) {
      out.push({
        type: side === "LONG" ? "NEW_LONG" : "NEW_SHORT",
        ticker: r.ticker,
        payload: {
          gapScore: r.gapScore,
          primaryDecile: r.primaryDecile,
          compositeZ: r.compositeZ,
          peerGroupKey: r.peerGroupKey,
        },
      });
    } else if (r.priorSide !== null && side === null) {
      out.push({
        type: "GAP_CLOSED",
        ticker: r.ticker,
        payload: { gapScore: r.gapScore, priorSide: r.priorSide, compositeZ: r.compositeZ },
      });
    }
    if (
      r.priorStreak &&
      r.priorStreak.len >= t.streakBrokenMinLen &&
      r.priorStreak.sign !== 0 &&
      r.streak.sign !== 0 &&
      r.streak.sign !== r.priorStreak.sign
    ) {
      out.push({
        type: "STREAK_BROKEN",
        ticker: r.ticker,
        payload: {
          priorLen: r.priorStreak.len,
          priorSign: r.priorStreak.sign,
          compositeZ: r.compositeZ,
        },
      });
    }
  }
  return out;
}

/** GROUP_INFLECTION / GROUP_ROLLOVER on level crossings, plus NEXT_DOMINO members. */
export function detectGroupTransitions(
  groups: GroupWeekMetrics[],
  stocks: StockWeekMetrics[],
  t: RevisionThresholds = REVISION_THRESHOLDS,
): TransitionDraft[] {
  const out: TransitionDraft[] = [];
  const hotGroups = new Map<string, { groupType: RevisionGroupType; meanZ: number }>();
  for (const g of groups) {
    if (g.meanZ === null) continue;
    if (g.priorMeanZ !== null) {
      if (g.priorMeanZ < t.groupCrossLevel && g.meanZ >= t.groupCrossLevel) {
        out.push({
          type: "GROUP_INFLECTION",
          groupType: g.groupType,
          groupKey: g.groupKey,
          payload: { meanZ: g.meanZ, priorMeanZ: g.priorMeanZ, level: t.groupCrossLevel },
        });
      }
      if (g.priorMeanZ > -t.groupCrossLevel && g.meanZ <= -t.groupCrossLevel) {
        out.push({
          type: "GROUP_ROLLOVER",
          groupType: g.groupType,
          groupKey: g.groupKey,
          payload: { meanZ: g.meanZ, priorMeanZ: g.priorMeanZ, level: -t.groupCrossLevel },
        });
      }
    }
    if (Math.abs(g.meanZ) >= t.dominoGroupMinAbsZ) {
      hotGroups.set(`${g.groupType}:${g.groupKey}`, { groupType: g.groupType, meanZ: g.meanZ });
    }
  }
  for (const s of stocks) {
    const hot = hotGroups.get(`${s.peerGroupType}:${s.peerGroupKey}`);
    if (!hot) continue;
    if (s.compositeZ === null || Math.abs(s.compositeZ) > t.dominoOwnMaxAbsZ) continue;
    out.push({
      type: "NEXT_DOMINO",
      ticker: s.ticker,
      groupType: s.peerGroupType,
      groupKey: s.peerGroupKey,
      payload: { groupMeanZ: hot.meanZ, ownZ: s.compositeZ, direction: hot.meanZ > 0 ? "LONG" : "SHORT" },
    });
  }
  return out;
}

/** ER_WITHIN_7D: reporting inside the window with a live revision signal into the print. */
export function detectEarningsTransitions(
  rows: Array<Pick<StockWeekMetrics, "ticker" | "compositeZ" | "daysToEarnings">>,
  t: RevisionThresholds = REVISION_THRESHOLDS,
): TransitionDraft[] {
  const out: TransitionDraft[] = [];
  for (const r of rows) {
    if (r.daysToEarnings === null || r.daysToEarnings < 0 || r.daysToEarnings > t.erWindowDays) continue;
    if (r.compositeZ === null || Math.abs(r.compositeZ) < t.erMinAbsRevisionZ) continue;
    out.push({
      type: "ER_WITHIN_7D",
      ticker: r.ticker,
      payload: { daysToEarnings: r.daysToEarnings, compositeZ: r.compositeZ },
    });
  }
  return out;
}
