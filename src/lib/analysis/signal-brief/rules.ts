/**
 * Overview SIGNAL BRIEF — pure verdict + severity rules. No I/O, no Prisma:
 * the composing service (signal-brief.service) normalizes stored rows into the
 * inputs here. Every threshold comes from SIGNAL_BRIEF_THRESHOLDS via an
 * injectable parameter — no magic numbers here.
 */
import {
  SIGNAL_BRIEF_THRESHOLDS,
  type SignalBriefThresholds,
} from "./config";

// ─── Scatter verdict ────────────────────────────────────────────────────────

export type Verdict = "confirm" | "against" | "quiet";

export interface VerdictInput {
  /** Latest revision gap score; null = no revision coverage (never fabricate 0). */
  gapScore: number | null;
  /** Latest-quarter 13F net flow in bps; null = no 13F coverage. */
  netflowBps: number | null;
  /** Active NEW_LONG transition on the name. */
  positiveTransition: boolean;
  /** Active NEW_SHORT transition on the name (short-side entry). */
  negativeTransition: boolean;
  /** Qualifying stasis-break event on a core holding. */
  stasisBreak: boolean;
  /** Crowded quadrant AND holders leaving (crowded-and-distributing). */
  crowdedDistributing: boolean;
}

/** True when any flow/revision event actively argues against the name. */
export function hasNegativeEvent(x: VerdictInput): boolean {
  return x.negativeTransition || x.stasisBreak || x.crowdedDistributing;
}

/**
 * Verdict color for one holding on the scatter. QUIET is the expected majority
 * on a normal day — that is correct behavior, not a bug to tune away. A name
 * missing a leg can still be forced AGAINST by an event, but can never be
 * CONFIRM without both the gap and (flow or a positive transition).
 */
export function classifyVerdict(
  x: VerdictInput,
  t: SignalBriefThresholds = SIGNAL_BRIEF_THRESHOLDS,
): Verdict {
  const negative = hasNegativeEvent(x);
  if (negative) return "against";
  if (x.gapScore !== null && x.gapScore <= t.verdictAgainstMaxGap) return "against";
  const gapConfirms = x.gapScore !== null && x.gapScore >= t.verdictConfirmMinGap;
  const flowConfirms =
    (x.netflowBps !== null && x.netflowBps >= t.verdictConfirmMinFlowBps) ||
    x.positiveTransition;
  if (gapConfirms && flowConfirms) return "confirm";
  return "quiet";
}

// ─── Crowded-and-distributing (13F quadrant) ────────────────────────────────

/** The flows quadrant key for the crowded corner (see quadrantModel). */
export const CROWDED_QUADRANT = "crowded";

/** Pure: crowded quadrant with net holders leaving = distribution risk. */
export function isCrowdedDistributing(
  quadrant: string | null,
  deltaHolders: number | null,
): boolean {
  return quadrant === CROWDED_QUADRANT && deltaHolders !== null && deltaHolders < 0;
}

// ─── Stasis-break qualification ─────────────────────────────────────────────

/** Pure: a stasis break counts only at/above the significance floor. */
export function qualifiesStasisBreak(
  significance: number | null,
  t: SignalBriefThresholds = SIGNAL_BRIEF_THRESHOLDS,
): boolean {
  return significance !== null && significance >= t.stasisBreakMinSignificance;
}

// ─── What-changed feed: candidates, gating, severity sort ───────────────────

export type FeedSource = "REV" | "13F";

export interface FeedCandidate {
  source: FeedSource;
  /** Null only for the group-rotation row. */
  ticker: string | null;
  held: boolean;
  /** Portfolio weight fraction (0..1) when held. */
  weight: number | null;
  /** Direction of the event for severity bucketing. */
  positive: boolean;
  /** Transition type / event kind, for chips + links (e.g. NEW_LONG, stasis_break). */
  kind: string;
  /** One generated sentence from the event payload. */
  sentence: string;
  /** Within-bucket magnitude (|gap|, significance, |diffusion %|...). Higher = stronger. */
  severity: number;
  /** yyyy-MM-dd the event fired / was snapshotted. */
  date: string;
  /** Deep link to the relevant tab, pre-filtered. */
  href: string;
  /** Group-rotation row (at most one survives, extremity-gated). */
  isRotation?: boolean;
  /** Gap score for non-held new-idea gating (NEW_LONG / NEW_SHORT). */
  gapScore?: number | null;
}

/** Severity bucket: lower = shown first. */
export function severityBucket(c: FeedCandidate): number {
  if (c.isRotation) return 3;
  if (c.held) return c.positive ? 1 : 0;
  return 2;
}

/** Pure: does a non-held candidate qualify as a "strongest new idea" row? */
export function qualifiesAsNewIdea(
  c: FeedCandidate,
  t: SignalBriefThresholds = SIGNAL_BRIEF_THRESHOLDS,
): boolean {
  if (c.held || c.isRotation) return true; // gating only applies to non-held ideas
  if (c.kind === "NEW_LONG" || c.kind === "NEW_SHORT") {
    return c.gapScore !== null && c.gapScore !== undefined && Math.abs(c.gapScore) >= t.newIdeaMinAbsGap;
  }
  // Non-held flow-side candidates (e.g. leaderboard #1) are pre-qualified by the caller.
  return true;
}

/**
 * Severity-sort + gate + cap the feed: held-negative, then held-positive, then
 * strongest non-held new ideas, then at most ONE group-rotation row (only when
 * it clears the extremity threshold). Within a bucket, stronger first. One row
 * per (source, ticker) — the strongest wins. Hard-capped at feedMaxRows.
 */
export function buildFeed(
  candidates: FeedCandidate[],
  t: SignalBriefThresholds = SIGNAL_BRIEF_THRESHOLDS,
): FeedCandidate[] {
  const gated = candidates.filter((c) => {
    if (c.isRotation) return c.severity >= t.rotationRowMinAbsDiffusionPct;
    return qualifiesAsNewIdea(c, t);
  });

  // Dedupe per (source, ticker): keep the strongest (negative beats positive
  // for held names so risk is never hidden by a same-name positive row).
  const byKey = new Map<string, FeedCandidate>();
  for (const c of gated) {
    const key = c.isRotation ? "ROTATION" : `${c.source}:${c.ticker}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, c);
      continue;
    }
    const better =
      severityBucket(c) < severityBucket(prev) ||
      (severityBucket(c) === severityBucket(prev) && c.severity > prev.severity);
    if (better) byKey.set(key, c);
  }

  const rows = [...byKey.values()].sort(
    (a, b) => severityBucket(a) - severityBucket(b) || b.severity - a.severity,
  );

  // At most one rotation row (dedupe key already enforces it), and the cap.
  return rows.slice(0, t.feedMaxRows);
}
