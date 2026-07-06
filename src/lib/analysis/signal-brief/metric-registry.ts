/**
 * Overview SIGNAL BRIEF — the metric definition registry for the three
 * portfolio-lens modules (revisions × 13F scatter, earnings timeline,
 * what-changed feed).
 *
 * ONE typed definition per metric; every NUMBER a definition cites is
 * INTERPOLATED from SIGNAL_BRIEF_THRESHOLDS — the same object the verdict /
 * severity rules read — so the copy physically cannot drift from the code.
 * The registry is a FUNCTION of the config; `SIGNAL_METRIC_REGISTRY` is the
 * default binding. Definitions are plain English first, formula second.
 * No inline definition strings in components — everything renders through
 * SignalMetricTip.
 */
import {
  SIGNAL_BRIEF_THRESHOLDS,
  type SignalBriefThresholds,
} from "./config";
import type { MetricDef } from "@/lib/analysis/metric-def";

export type { MetricDef };

/** All metric ids in the registry. Adding a metric here makes it available everywhere. */
export const SIGNAL_METRIC_IDS = [
  "revisionGap",
  "netFlowBps",
  "verdictConfirm",
  "verdictAgainst",
  "verdictQuiet",
  "severityOrder",
  "flowLag",
  "revZIntoPrint",
  "positionWeight",
] as const;

export type SignalMetricId = (typeof SIGNAL_METRIC_IDS)[number];

/** Build the registry from the thresholds config; every cited number is interpolated. */
export function buildSignalBriefRegistry(
  t: SignalBriefThresholds,
): Record<SignalMetricId, MetricDef> {
  const confirmGap = t.verdictConfirmMinGap.toFixed(1);
  const confirmFlow = Math.round(t.verdictConfirmMinFlowBps);
  const againstGap = t.verdictAgainstMaxGap.toFixed(1);

  return {
    revisionGap: {
      id: "revisionGap",
      label: "revision gap — 4w",
      short_def:
        "Unpriced revision gap from the REVISIONS engine: 4-wk revision composite z minus 4-wk peer-relative price return z. Positive = analyst estimates rising faster than price has moved — potential long. Negative = price hasn't caught down to falling estimates — potential short.",
      calculation: "gap = revZ(4w) − pxZ(4w)",
      basis: "Weekly research snapshot; the effective window clamps while history accrues.",
    },
    netFlowBps: {
      id: "netFlowBps",
      label: "13F net flow bps",
      short_def:
        "Institutional net ACTIVE flow into the name over the latest filed quarter, in basis points of tracked-fund books, from 13F filings. Price appreciation is removed — a positive number means funds actually bought, not that the stock rallied.",
      calculation: "mean(active weight − expected weight) across signal-tier funds, in bps",
      caveats: `13Fs lag quarter end by up to ~${t.flowLagDays} days — a lagging confirmation signal, not live flow.`,
    },
    verdictConfirm: {
      id: "verdictConfirm",
      label: "signals confirm",
      short_def: `Green: both legs agree with the position — revision gap ≥ +${confirmGap} AND 13F net flow ≥ +${confirmFlow}bps (or an active NEW LONG flag), with no negative event on the name. Agreement is a label, never a blended score.`,
    },
    verdictAgainst: {
      id: "verdictAgainst",
      label: "signals against",
      short_def: `Red: the signals argue against the name — revision gap ≤ ${againstGap}, OR an active negative event (short-side entry, core-holder stasis break, crowded-and-distributing quadrant). Review the position.`,
    },
    verdictQuiet: {
      id: "verdictQuiet",
      label: "quiet",
      short_def:
        "Gray: neither engine has a strong view — no qualifying gap, flow, or event. Most of the book is gray on a normal day; that is correct behavior, not missing data.",
    },
    severityOrder: {
      id: "severityOrder",
      label: "severity order",
      short_def: `Feed ordering: held-name negative events first, then held-name positive events, then the strongest non-held new ideas (|gap| ≥ ${t.newIdeaMinAbsGap.toFixed(1)}), then at most one group-rotation line (only when |net diffusion| ≥ ${Math.round(t.rotationRowMinAbsDiffusionPct)}%). Capped at ${t.feedMaxRows} rows.`,
    },
    flowLag: {
      id: "flowLag",
      label: "13F lag",
      short_def: `13F filings arrive up to ~${t.flowLagDays} days after quarter end, so the flow leg describes the latest FILED quarter, not today's positioning. Treat it as lagging confirmation, never as live flow.`,
    },
    revZIntoPrint: {
      id: "revZIntoPrint",
      label: "rev z into print",
      short_def:
        "The name's revision composite z heading into its earnings report, proximity-weighted (revisions just before the print count up to 2×). A strong z into the print is a live setup that resolves fast — in either direction.",
    },
    positionWeight: {
      id: "positionWeight",
      label: "weight",
      short_def:
        "The position's share of portfolio gross exposure: |shares × price| / Σ|shares × price|. Scatter dot size scales with it (clamped) so the biggest positions read first.",
    },
  };
}

export const SIGNAL_METRIC_REGISTRY: Record<SignalMetricId, MetricDef> =
  buildSignalBriefRegistry(SIGNAL_BRIEF_THRESHOLDS);

/** Accessor used by SignalMetricTip. Throws in dev on unknown ids (registry coverage bug). */
export function signalMetric(id: SignalMetricId): MetricDef {
  const def = SIGNAL_METRIC_REGISTRY[id];
  if (!def) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`signal-brief metric-registry: unknown metric id "${id}"`);
    }
    return { id, label: id, short_def: "" };
  }
  return def;
}
