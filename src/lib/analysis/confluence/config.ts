/**
 * CONFLUENCE — the single source for every state/stage threshold on the
 * cross-signal stacking board. The pure rules (rules.ts), the composing read
 * service, the weekly stage-history writer, AND the metric registry all read
 * this object, so tooltip copy interpolates the same numbers the code runs.
 * Follows the Engine-1 REVISION_THRESHOLDS / signal-brief pattern.
 *
 * Agreement is a COUNT (stack depth) and a LABEL (stage) — never a blended
 * score, displayed or internal. The three sources have different cadences
 * (weekly / weekly / quarterly ~45d-lagged) and different meanings; averaging
 * them would be a category error.
 */

export const CONFLUENCE_THRESHOLDS = {
  /** FUNDAMENTALS LONG requires the discovery peer decile (subsector, sector fallback) at or above this. */
  fundLongMinDecile: 9,
  /** FUNDAMENTALS SHORT requires the discovery peer decile at or below this. */
  fundShortMaxDecile: 2,
  /** 13F LONG fires on netflowBps at or above this (lifecycle FORMING/DURABLE also qualifies). */
  flowLongMinBps: 5,
  /** 13F SHORT fires on netflowBps at or below this (lifecycle BROKEN / exit cluster also qualify). */
  flowShortMaxBps: -5,
  /** Exit-cluster short signal: at least this many high-conviction holders trimming/exiting (matches getExitClusters). */
  exitClusterMinExits: 3,
  /** Idio share below this % renders in warning color — mostly factor-explained. Display only, never rank. */
  idioWarnPct: 40,
  /** Server cap on SINGLE-stage rows in the payload (rank-ordered, strongest kept; funnel counts stay full). */
  singleStageMaxRows: 300,
  /** 13F filings arrive up to ~this many days after quarter end (the lag caveat on every flow stamp). */
  flowLagDays: 45,
} as const;

/** Widened (all-number) shape so rules accept modified copies (tests, tuning). */
export type ConfluenceThresholds = {
  [K in keyof typeof CONFLUENCE_THRESHOLDS]: number;
};

/** Lifecycle stages that qualify the 13F leg LONG (accumulation building/confirmed). */
export const FLOW_LONG_STAGES: readonly string[] = ["FORMING", "DURABLE"];
/** Lifecycle stage that qualifies the 13F leg SHORT (accumulation streak ended). */
export const FLOW_SHORT_STAGE = "BROKEN";
