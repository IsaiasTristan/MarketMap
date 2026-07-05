/**
 * Flow data-quality flags — the CANONICAL registry (Rotation v3 Part 5).
 *
 * One entry per flag type: its badge glyph, severity tone, and tooltip copy. Every
 * Flows view (leaderboard, rotation stock board + drill-downs, and later
 * scatter/trajectories/FUNDS) renders data-quality flags from THIS module and
 * nowhere else, so a name shows the same glyph + tooltip wherever it appears. Pure
 * and dependency-free (importable by server assembly and client rendering alike).
 *
 * The boolean signals themselves are computed once, in the leaderboard core
 * (flow-leaderboard.ts → flagsByTicker), and fanned out to consumers — this module
 * owns only the DISPLAY contract.
 */

export type FlowFlagId = "verify-weights" | "partial-data" | "unresolved-split" | "tenure-verify";

export interface FlowFlagDef {
  id: FlowFlagId;
  /** Short badge text shown in the row. */
  glyph: string;
  /** Severity tone → CSS var. `negative` = data likely wrong; `accent` = caveat. */
  tone: "negative" | "accent";
  /** Hover copy — identical everywhere the flag renders. */
  tooltip: string;
}

/** The single source of truth for flag display. */
export const FLOW_FLAGS: Record<FlowFlagId, FlowFlagDef> = {
  "verify-weights": {
    id: "verify-weights",
    glyph: "VERIFY",
    tone: "negative",
    tooltip: "Median holder weight implausibly high or a suspected reported-value unit error — conviction not counted pending review",
  },
  "partial-data": {
    id: "partial-data",
    glyph: "PARTIAL",
    tone: "accent",
    tooltip: "Some holders' filings are missing this quarter — score may be incomplete",
  },
  "unresolved-split": {
    id: "unresolved-split",
    glyph: "SPLIT?",
    tone: "negative",
    tooltip: "An unresolved share-count jump (possible split) is held for review — flow may be distorted",
  },
  "tenure-verify": {
    id: "tenure-verify",
    glyph: "TENURE",
    tone: "accent",
    tooltip: "Holder tenure is left-censored (history truncated) — streak / tenure reads are lower bounds",
  },
};

export const FLOW_FLAG_IDS = Object.keys(FLOW_FLAGS) as FlowFlagId[];

/** CSS var for a flag's tone (badge text + border). */
export function flowFlagColor(def: FlowFlagDef): string {
  return def.tone === "negative" ? "var(--color-negative)" : "var(--color-accent)";
}

/** The boolean flag bag carried on a row (mirrors the leaderboard's computed flags). */
export interface FlowFlagState {
  verifyData?: boolean;
  partialData?: boolean;
  unresolvedSplit?: boolean;
  tenureVerify?: boolean;
}

/** Ordered active flag defs for a row's flag state (registry order). */
export function activeFlowFlags(state: FlowFlagState | null | undefined): FlowFlagDef[] {
  if (!state) return [];
  const out: FlowFlagDef[] = [];
  if (state.verifyData) out.push(FLOW_FLAGS["verify-weights"]);
  if (state.partialData) out.push(FLOW_FLAGS["partial-data"]);
  if (state.unresolvedSplit) out.push(FLOW_FLAGS["unresolved-split"]);
  if (state.tenureVerify) out.push(FLOW_FLAGS["tenure-verify"]);
  return out;
}
