/**
 * CONFLUENCE — the metric definition registry for the cross-signal stacking
 * board. ONE typed definition per metric; every NUMBER a definition cites is
 * INTERPOLATED from CONFLUENCE_THRESHOLDS — the same object the state/stage
 * rules read — so the copy physically cannot drift from the code. The registry
 * is a FUNCTION of the config; `CONFLUENCE_METRIC_REGISTRY` is the default
 * binding. No inline definition strings in components — everything renders
 * through ConfluenceMetricTip.
 */
import {
  CONFLUENCE_THRESHOLDS,
  FLOW_LONG_STAGES,
  FLOW_SHORT_STAGE,
  type ConfluenceThresholds,
} from "./config";
import type { MetricDef } from "@/lib/analysis/metric-def";

export type { MetricDef };

/** All metric ids in the registry. Adding a metric here makes it available everywhere. */
export const CONFLUENCE_METRIC_IDS = [
  "stackDepth",
  "stageFullStack",
  "stageCrowded",
  "stagePlusRevisions",
  "stageRPlus13F",
  "stageFPlus13F",
  "stageSingle",
  "stageConflict",
  "fundDecile",
  "trapFlag",
  "revGap",
  "flowBps",
  "lifecycleStage",
  "exitCluster",
  "idioShare",
  "noCoverage",
  "flowLag",
  "readSentence",
  "nextEr",
  "heldWeight",
] as const;

export type ConfluenceMetricId = (typeof CONFLUENCE_METRIC_IDS)[number];

/** Build the registry from the thresholds config; every cited number is interpolated. */
export function buildConfluenceRegistry(
  t: ConfluenceThresholds,
): Record<ConfluenceMetricId, MetricDef> {
  const longStages = FLOW_LONG_STAGES.join("/");
  return {
    stackDepth: {
      id: "stackDepth",
      label: "stack depth",
      short_def:
        "How many of the three independent systems (FUNDAMENTALS, REVISIONS, 13F FLOWS) currently agree on the name's direction. A COUNT, never a blended score — the sources have different cadences and meanings, so agreement is counted and labeled, not averaged. The table ranks by it.",
      caveats: "For CONFLICT rows, depth is the majority-direction count.",
    },
    stageFullStack: {
      id: "stageFullStack",
      label: "FULL STACK",
      short_def:
        "All three systems agree on the same direction: fundamentals inflected, analysts revised, and institutions are positioned. The end of the adoption sequence — maximum confirmation, least early.",
    },
    stageCrowded: {
      id: "stageCrowded",
      label: "CROWDED",
      short_def:
        "A long FULL STACK whose 13F breadth is at or above the quarter's 75th percentile — everyone already owns it. A demotion, not an achievement: the confirmation is complete but so is the adoption. Short stacks never demote (breadth is part of the short thesis).",
    },
    stagePlusRevisions: {
      id: "stagePlusRevisions",
      label: "+REVISIONS",
      short_def:
        "Fundamentals and analyst revisions agree while 13F funds are flat or uncovered — the sweet spot of the sequence: the business turned, the sell-side is reacting, and institutional money hasn't confirmed yet.",
    },
    stageRPlus13F: {
      id: "stageRPlus13F",
      label: "R+13F",
      short_def:
        "Revisions and 13F flows agree while fundamentals are flat — the story is running ahead of the statements. Either the fundamentals inflection hasn't printed yet, or the move is narrative-driven.",
    },
    stageFPlus13F: {
      id: "stageFPlus13F",
      label: "F+13F",
      short_def:
        "Fundamentals and 13F flows agree while analysts haven't moved — funds are positioned on an inflection the sell-side hasn't chased yet. Watch for the revision leg to fire.",
    },
    stageSingle: {
      id: "stageSingle",
      label: "single source",
      short_def:
        "Exactly one system fired (chip shows which: FUND ONLY / REV ONLY / 13F ONLY). The earliest — and least confirmed — bucket. On a cold start most rows land here; that is honest, not broken.",
    },
    stageConflict: {
      id: "stageConflict",
      label: "CONFLICT",
      short_def:
        "Two or more systems disagree in direction (e.g. fundamentals long while funds distribute). A first-class bucket, not an error: the sequence is broken and one side is stale — worth finding out which.",
    },
    fundDecile: {
      id: "fundDecile",
      label: "fund decile",
      short_def: `FUNDAMENTALS discovery composite decile within the name's peer group (subsector, sector fallback), 10 = strongest inflection profile. LONG at or above ${t.fundLongMinDecile}, SHORT at or below ${t.fundShortMaxDecile}.`,
    },
    trapFlag: {
      id: "trapFlag",
      label: "TRAP",
      short_def:
        "The fundamentals accruals-trap flag: earnings outrunning cash. A TRAP-flagged high decile still counts LONG for stacking — the flag rides along visibly so you can decide whether it's cheap for a reason.",
    },
    revGap: {
      id: "revGap",
      label: "rev gap",
      short_def:
        "REVISIONS unpriced gap: 4-wk revision composite z minus 4-wk peer-relative price return z. Positive = analyst moves the price hasn't matched. Carried for every name regardless of state; the rank tie-break within equal stack depth.",
    },
    flowBps: {
      id: "flowBps",
      label: "flow bps",
      short_def: `13F net ACTIVE flow over the latest filed quarter, in bps of tracked-fund books (price appreciation removed). LONG at or above +${t.flowLongMinBps}bps or lifecycle ${longStages}; SHORT at or below ${t.flowShortMaxBps}bps, lifecycle ${FLOW_SHORT_STAGE}, or a conviction exit cluster.`,
    },
    lifecycleStage: {
      id: "lifecycleStage",
      label: "lifecycle",
      short_def:
        "The name's 13F accumulation lifecycle stage: SPIKE (one-quarter jump), FORMING (streak building), DURABLE (persistent multi-quarter build), CORE (long-held stasis), BROKEN (streak ended). FORMING/DURABLE qualify the flow leg long; BROKEN qualifies it short.",
    },
    exitCluster: {
      id: "exitCluster",
      label: "exit cluster",
      short_def: `At least ${t.exitClusterMinExits} high-conviction holders trimmed or exited the name this quarter — a coordinated departure read that qualifies the 13F leg SHORT even when residual net flow is positive.`,
    },
    idioShare: {
      id: "idioShare",
      label: "idio %",
      short_def: `Share of the stock's return variance NOT explained by the factor model (MACRO14, 252d) — how much of the move is actually stock-specific. Below ${t.idioWarnPct}% renders in warning color: mostly factor-explained — the signal may be a factor bet, not a stock pick. Annotation only; never affects stage or rank.`,
      caveats: "“—” = no factor decomposition stored for the name.",
    },
    noCoverage: {
      id: "noCoverage",
      label: "no coverage",
      short_def:
        "Hollow/dashed cell: this source doesn't cover the name at all — different from the gray NEUTRAL cell, which means the source looked and reads flat. No-coverage can't agree or conflict; it simply isn't a vote.",
    },
    flowLag: {
      id: "flowLag",
      label: "13F lag",
      short_def: `13F filings arrive up to ~${t.flowLagDays} days after quarter end, so the flow leg describes the latest FILED quarter, not today's positioning. The slowest leg of the sequence by construction.`,
    },
    readSentence: {
      id: "readSentence",
      label: "read",
      short_def:
        "A generated one-liner assembled from the three states in causal order (fundamentals → analysts → funds) plus the carried numbers. Templated, not editorial — the same states always produce the same sentence.",
    },
    nextEr: {
      id: "nextEr",
      label: "next ER",
      short_def:
        "The name's next earnings date from the research snapshot. A print resolves setups fast in either direction — dimmed beyond 30 days.",
    },
    heldWeight: {
      id: "heldWeight",
      label: "weight",
      short_def:
        "The position's share of portfolio gross exposure (|shares × price| / Σ). Shown when the held-only filter is active.",
    },
  };
}

export const CONFLUENCE_METRIC_REGISTRY: Record<ConfluenceMetricId, MetricDef> =
  buildConfluenceRegistry(CONFLUENCE_THRESHOLDS);

/** Accessor used by ConfluenceMetricTip. Throws in dev on unknown ids (registry coverage bug). */
export function confluenceMetric(id: ConfluenceMetricId): MetricDef {
  const def = CONFLUENCE_METRIC_REGISTRY[id];
  if (!def) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`confluence metric-registry: unknown metric id "${id}"`);
    }
    return { id, label: id, short_def: "" };
  }
  return def;
}
