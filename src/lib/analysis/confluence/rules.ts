/**
 * CONFLUENCE — pure state/stage rules. No I/O, no Prisma: the composing
 * service (confluence.service) normalizes stored rows into the inputs here,
 * and the weekly stage-history writer reuses the exact same functions. Every
 * threshold comes from CONFLUENCE_THRESHOLDS via an injectable parameter — no
 * magic numbers here.
 *
 * Stack depth is a COUNT of agreeing non-neutral sources; the stage is a
 * LABEL. Nothing in this module blends the three sources into a number.
 */
import {
  CONFLUENCE_THRESHOLDS,
  FLOW_LONG_STAGES,
  FLOW_SHORT_STAGE,
  type ConfluenceThresholds,
} from "./config";

// ─── Signal states ───────────────────────────────────────────────────────────

export type SignalState = "LONG" | "SHORT" | "NEUTRAL" | "NO_COVERAGE";
export type Direction = "LONG" | "SHORT";
export type SourceKey = "F" | "R" | "F13";

/**
 * FUNDAMENTALS leg: discovery peer decile (subsector primary, sector
 * fallback — the same precedence the Discovery Rank table renders). The trap
 * flag is deliberately NOT an input: a TRAP-flagged D9/D10 still counts LONG;
 * the flag passes through to the row for visible display.
 */
export function classifyFundamentals(
  x: { covered: boolean; subsectorDecile: number | null; sectorDecile: number | null },
  t: ConfluenceThresholds = CONFLUENCE_THRESHOLDS,
): SignalState {
  if (!x.covered) return "NO_COVERAGE";
  const decile = x.subsectorDecile ?? x.sectorDecile;
  if (decile === null) return "NEUTRAL";
  if (decile >= t.fundLongMinDecile) return "LONG";
  if (decile <= t.fundShortMaxDecile) return "SHORT";
  return "NEUTRAL";
}

/** REVISIONS leg: the queue side from the transition state machine. */
export function classifyRevisions(x: { covered: boolean; side: string | null }): SignalState {
  if (!x.covered) return "NO_COVERAGE";
  if (x.side === "LONG") return "LONG";
  if (x.side === "SHORT") return "SHORT";
  return "NEUTRAL";
}

/**
 * 13F leg: broad net flow OR a lifecycle read. SHORT wins when both fire —
 * a BROKEN streak or a conviction exit cluster with residual positive bps is
 * a distribution read (the departures are the information).
 */
export function classifyFlows(
  x: {
    covered: boolean;
    netflowBps: number | null;
    lifecycleStage: string | null;
    inExitCluster: boolean;
  },
  t: ConfluenceThresholds = CONFLUENCE_THRESHOLDS,
): SignalState {
  if (!x.covered) return "NO_COVERAGE";
  const short =
    (x.netflowBps !== null && x.netflowBps <= t.flowShortMaxBps) ||
    x.lifecycleStage === FLOW_SHORT_STAGE ||
    x.inExitCluster;
  if (short) return "SHORT";
  const long =
    (x.netflowBps !== null && x.netflowBps >= t.flowLongMinBps) ||
    (x.lifecycleStage !== null && FLOW_LONG_STAGES.includes(x.lifecycleStage));
  if (long) return "LONG";
  return "NEUTRAL";
}

// ─── Stage classification ────────────────────────────────────────────────────

export type Stage =
  | "FULL_STACK"
  | "CROWDED"
  | "PLUS_REVISIONS"
  | "R_PLUS_13F"
  | "F_PLUS_13F"
  | "SINGLE"
  | "CONFLICT";

/** Funnel/display order — adoption sequence first, conflicts last. */
export const STAGE_ORDER: readonly Stage[] = [
  "FULL_STACK",
  "CROWDED",
  "PLUS_REVISIONS",
  "R_PLUS_13F",
  "F_PLUS_13F",
  "SINGLE",
  "CONFLICT",
];

export interface StackStates {
  f: SignalState;
  r: SignalState;
  f13: SignalState;
}

export interface StageResult {
  /** null = zero non-neutral states → the name doesn't belong on the board. */
  stage: Stage | null;
  /** null only for a 1–1 CONFLICT tie. */
  direction: Direction | null;
  /** Agreeing non-neutral count; CONFLICT → the majority-direction count. */
  stackDepth: number;
  /** Which single source fired — set only for SINGLE. */
  singleSource: SourceKey | null;
}

/**
 * Stage per name. NO_COVERAGE is treated exactly like NEUTRAL here (it can't
 * agree or conflict); the display layer keeps them distinct. CROWDED is a
 * demotion of a LONG full stack only — a crowded short stack stays FULL_STACK
 * (breadth was already the short thesis's company).
 */
export function classifyStage(s: StackStates, crowded: boolean): StageResult {
  const states: Array<[SourceKey, SignalState]> = [
    ["F", s.f],
    ["R", s.r],
    ["F13", s.f13],
  ];
  const longs = states.filter(([, st]) => st === "LONG").map(([k]) => k);
  const shorts = states.filter(([, st]) => st === "SHORT").map(([k]) => k);

  if (longs.length === 0 && shorts.length === 0) {
    return { stage: null, direction: null, stackDepth: 0, singleSource: null };
  }

  if (longs.length > 0 && shorts.length > 0) {
    const depth = Math.max(longs.length, shorts.length);
    const direction: Direction | null =
      longs.length > shorts.length ? "LONG" : shorts.length > longs.length ? "SHORT" : null;
    return { stage: "CONFLICT", direction, stackDepth: depth, singleSource: null };
  }

  const agreeing = longs.length > 0 ? longs : shorts;
  const direction: Direction = longs.length > 0 ? "LONG" : "SHORT";

  if (agreeing.length === 3) {
    const stage: Stage = direction === "LONG" && crowded ? "CROWDED" : "FULL_STACK";
    return { stage, direction, stackDepth: 3, singleSource: null };
  }
  if (agreeing.length === 2) {
    const has = (k: SourceKey) => agreeing.includes(k);
    const stage: Stage =
      has("F") && has("R") ? "PLUS_REVISIONS" : has("R") && has("F13") ? "R_PLUS_13F" : "F_PLUS_13F";
    return { stage, direction, stackDepth: 2, singleSource: null };
  }
  return { stage: "SINGLE", direction, stackDepth: 1, singleSource: agreeing[0]! };
}

/** Stage chip label; SINGLE is labeled by which source fired (generic "SINGLE" without one — e.g. the funnel segment). */
export function stageChipLabel(stage: Stage, singleSource: SourceKey | null): string {
  switch (stage) {
    case "FULL_STACK":
      return "FULL STACK";
    case "CROWDED":
      return "CROWDED";
    case "PLUS_REVISIONS":
      return "+REVISIONS";
    case "R_PLUS_13F":
      return "R+13F";
    case "F_PLUS_13F":
      return "F+13F";
    case "CONFLICT":
      return "CONFLICT";
    case "SINGLE":
      switch (singleSource) {
        case "F":
          return "FUND ONLY";
        case "R":
          return "REV ONLY";
        case "F13":
          return "13F ONLY";
        default:
          return "SINGLE";
      }
  }
}

// ─── Ranking (never a blended score) ─────────────────────────────────────────

export interface RankableRow {
  stackDepth: number;
  gapScore: number | null;
  ticker: string;
}

/** Stack depth desc → |gapScore| desc with null gap last → ticker asc. */
export function compareConfluenceRows(a: RankableRow, b: RankableRow): number {
  if (a.stackDepth !== b.stackDepth) return b.stackDepth - a.stackDepth;
  const ag = a.gapScore === null ? -1 : Math.abs(a.gapScore);
  const bg = b.gapScore === null ? -1 : Math.abs(b.gapScore);
  if (ag !== bg) return bg - ag;
  return a.ticker.localeCompare(b.ticker);
}

// ─── READ sentence templating ────────────────────────────────────────────────

export interface ReadSentenceInput {
  stage: Stage;
  direction: Direction | null;
  f: SignalState;
  r: SignalState;
  f13: SignalState;
  decile: number | null;
  gapScore: number | null;
  netflowBps: number | null;
  lifecycleStage: string | null;
  trapFlag: boolean;
  crowded: boolean;
  inExitCluster: boolean;
}

const fmtGap = (v: number | null): string =>
  v === null ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(1)}σ`;
const fmtBps = (v: number | null): string =>
  v === null ? "n/a" : `${v >= 0 ? "+" : ""}${Math.round(v)}BPS`;

function fundamentalsPhrase(x: ReadSentenceInput): string {
  switch (x.f) {
    case "LONG":
      return `FUNDAMENTALS INFLECTED (D${x.decile ?? "?"})${x.trapFlag ? " — TRAP FLAG, CHEAP FOR A REASON?" : ""}`;
    case "SHORT":
      return `FUNDAMENTALS DETERIORATING (D${x.decile ?? "?"})`;
    case "NEUTRAL":
      return "FUNDAMENTALS FLAT";
    case "NO_COVERAGE":
      return "NO FUNDAMENTALS COVERAGE";
  }
}

function revisionsPhrase(x: ReadSentenceInput): string {
  switch (x.r) {
    case "LONG":
      return `ANALYSTS CHASING (GAP ${fmtGap(x.gapScore)} UNPRICED)`;
    case "SHORT":
      return `ANALYSTS CUTTING (GAP ${fmtGap(x.gapScore)})`;
    case "NEUTRAL":
      return x.direction === "LONG" ? "ANALYSTS NOT MOVED YET" : "ANALYSTS QUIET";
    case "NO_COVERAGE":
      return "NO REVISIONS COVERAGE";
  }
}

function flowsPhrase(x: ReadSentenceInput): string {
  switch (x.f13) {
    case "LONG":
      return `FUNDS ACCUMULATING (${x.lifecycleStage ? `${x.lifecycleStage}, ` : ""}${fmtBps(x.netflowBps)})`;
    case "SHORT":
      return x.inExitCluster
        ? `CONVICTION EXIT CLUSTER (${fmtBps(x.netflowBps)})`
        : `FUNDS DISTRIBUTING (${x.lifecycleStage === "BROKEN" ? "BROKEN, " : ""}${fmtBps(x.netflowBps)})`;
    case "NEUTRAL":
      return x.direction === "LONG" ? "FUNDS NOT IN YET" : "FUNDS STILL HOLDING";
    case "NO_COVERAGE":
      return "NO 13F COVERAGE";
  }
}

/**
 * One generated line per row, templated purely from the states + carried
 * numbers, in causal order (fundamentals → revisions → funds). Never contains
 * internal engine codenames.
 */
export function buildReadSentence(x: ReadSentenceInput): string {
  const parts = [fundamentalsPhrase(x), revisionsPhrase(x), flowsPhrase(x)];
  let sentence = parts.join(" · ");
  if (x.stage === "CROWDED") sentence += " — CROWDED (BREADTH ≥ P75), LATE-STAGE";
  if (x.stage === "CONFLICT") sentence += " — CONFLICT: VERIFY WHICH SIDE IS STALE";
  return sentence;
}
