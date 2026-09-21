/**
 * Pairs tab — the metric definition registry (brief §12.1). ONE typed
 * definition per metric/flag, shared across the Pair Map and Hedge Finder so
 * the same concise text renders in every tooltip. Every NUMBER a definition
 * cites is interpolated from PAIR_THRESHOLDS — the same object the services
 * read — so copy cannot drift from the code. Plain English first, formula
 * second, and a "Data used" provenance line where it clarifies (§12.1).
 */
import { PAIR_THRESHOLDS, type PairThresholds } from "@/lib/pairs/config";
import { PAIR_FLAG_IDS, pairFlagRule, type PairFlagId } from "@/lib/pairs/flags";
import type { MetricDef } from "@/lib/analysis/metric-def";

export type { MetricDef };

export const PAIR_METRIC_IDS = [
  "hedgeEff",
  "e1Breadth",
  "e1Gap",
  "e1Gap4wChange",
  "e2Breadth",
  "e2Gap",
  "e2Gap4wChange",
  "e3NetBuyerGap",
  "crowding",
  "crowdBreadth",
  "signalSparkline",
  "priceRatioSparkline",
  "relReturn1m",
  "relReturn3m",
  "unpricedGap",
  "unpricedGapEngines",
  "e2GapStep",
  "priceRatioZ",
  "valRatioPctile",
  "ewMinusCw1m",
  "residualShare",
  "topFactor",
  "topFactorVarPct",
  "betaNeutralRatio",
  "dispersion",
  // Hedge Finder
  "factorRiskRemoved",
  "totalRiskRemoved",
  "residualCorrelation",
  "hedgeRatio",
  "empiricalBeta",
  "splitHalfRatio",
  "rollingRatio",
  "containsTarget",
  "borrowFlag",
  // Tier 2 (single-stock pairs)
  "tier2",
  // Tier 3 (curated links)
  "tier3",
  "readThroughStatus",
  // Validation (pooled event study)
  "forwardRelReturn",
  "effectiveSample",
  "hitRate",
  "eventIC",
  "decayCurve",
  "headlineGate",
] as const;

export type PairMetricId = (typeof PAIR_METRIC_IDS)[number] | `flag.${PairFlagId}`;

/** Build the registry from the thresholds config; every cited number interpolates. */
export function buildPairMetricRegistry(t: PairThresholds): Record<PairMetricId, MetricDef> {
  const base: Record<(typeof PAIR_METRIC_IDS)[number], MetricDef> = {
    hedgeEff: {
      id: "hedgeEff",
      label: "hedge efficiency",
      short_def:
        "How much of the two legs' price risk cancels when held against each other. 1 = perfect, 0 = independent, negative = the hedge doubles risk.",
      calculation: "1 - Var(r_long - r_short) / (Var(r_long) + Var(r_short)) over ~2y weekly total returns.",
      caveats: `Below ${t.minHedgeEff} it is not a real pair (excluded from the default ranking, shown dimmed). It also penalises a volatility mismatch between the legs, which plain correlation does not.`,
      basis: "2 years weekly",
    },
    e1Breadth: {
      id: "e1Breadth",
      label: "revision breadth",
      short_def: "How many names in a group had net analyst target raises vs cuts — not how much any one moved.",
      calculation: "100 * (count raised - count cut) / N, in percentage points.",
      caveats: "Magnitude-blind by design: a 1% nudge counts the same as a 40% raise, so one huge revision cannot hijack it.",
    },
    e1Gap: {
      id: "e1Gap",
      label: "revision breadth gap",
      short_def: "Long-leg revision breadth minus short-leg breadth, in percentage points. The headline Engine 1 number for a pair.",
      calculation: "e1BreadthLong - e1BreadthShort (pp).",
    },
    e1Gap4wChange: {
      id: "e1Gap4wChange",
      label: "revision gap, 4-week change",
      short_def: "How much the revision gap moved over the last 4 grid weeks. The default sort — the tab is a change detector, the level is context.",
      calculation: `gap now minus gap ${t.gapChangeSteps} snapshots ago (pp).`,
    },
    e2Breadth: {
      id: "e2Breadth",
      label: "inflection breadth",
      short_def: "How many names in a group are inflecting up vs deteriorating on business fundamentals (margins, growth, FCF, ROIC, leverage).",
      calculation: "100 * (count inflecting up - count deteriorating) / N, from the raw inflection components.",
      caveats: "Quarterly and restated-basis: reconstructed as-of each quarter end from statement history, so it lags the weekly date and inherits restatement look-ahead. Directional only.",
      basis: "quarterly",
    },
    e2Gap: {
      id: "e2Gap",
      label: "inflection breadth gap",
      short_def: "Long-leg inflection breadth minus short-leg breadth (pp). The headline Engine 2 number for a pair.",
    },
    e2Gap4wChange: {
      id: "e2Gap4wChange",
      label: "inflection gap change",
      short_def:
        "Change in the inflection breadth gap over the trailing 4 grid weeks — the Engine-2 analogue of the E1 4-week change.",
      caveats:
        "Engine 2 is reconstructed on a QUARTERLY fundamentals cadence, so between refreshes the breadth is flat and this diff is legitimately 0 — shown as \"↺ Nw\" (weeks since the last refresh), not a bare 0. Because a flat series can't diverge, E2 also can't drive the unpriced gap in those weeks.",
      basis: "quarterly",
    },
    e3NetBuyerGap: {
      id: "e3NetBuyerGap",
      label: "net fund buyers, long - short",
      short_def: "Watchlist funds that added minus those that cut, differenced between the legs. A count, never a score.",
      caveats: "13F is ~45 days stale by construction. It confirms; it never leads.",
      basis: "quarterly, ~45d lag",
    },
    crowding: {
      id: "crowding",
      label: "crowding, long / short",
      short_def: "Percent of the watchlist funds holding each leg, kept separate (never netted). This is the basket AVERAGE — see crowding breadth for the concentration measure.",
      caveats: `Crowding above ${t.crowdedLongPct}% on the long is a late trade; above ${t.shortLegOwnedPct}% on the short means funds still own what you would short. A basket mean can look thin while a couple of names are heavily owned — the breadth column exists for exactly that case.`,
    },
    crowdBreadth: {
      id: "crowdBreadth",
      label: "crowding breadth, long / short",
      short_def: `Percent of a leg's names that more than ${t.crowdNameMinPct}% of watchlist funds hold — the CONCENTRATION measure, not the basket average.`,
      calculation: `100 * (count of names with pctOfFunds > ${t.crowdNameMinPct}) / N. The ${t.crowdNameMinPct}% floor is the universe's cross-sectional p90 (~5 of 120 funds), not a round number.`,
      caveats: "Deliberately not the mean, which averages a few heavily-held names down and hides how broadly the basket is owned. Null when no fund-holding data is known for the leg.",
      basis: "quarterly, ~45d lag",
    },
    signalSparkline: {
      id: "signalSparkline",
      label: "signal gap, 13 weeks",
      short_def: "The revision breadth gap over the last 13 weeks — distinguishes a durable trend from a one-week spike.",
    },
    priceRatioSparkline: {
      id: "priceRatioSparkline",
      label: "price ratio, 13 weeks",
      short_def: "The long/short price ratio over the last 13 weeks, drawn beside the signal gap — the adjacency is the point: has price reacted to the divergence yet?",
    },
    relReturn1m: {
      id: "relReturn1m",
      label: "relative return, 1 month",
      short_def: "Long-leg return minus short-leg return over the last month.",
    },
    relReturn3m: {
      id: "relReturn3m",
      label: "relative return, 3 months",
      short_def: "Long-leg return minus short-leg return over the last three months.",
    },
    unpricedGap: {
      id: "unpricedGap",
      label: "unpriced gap",
      short_def: "How far the signal gap has moved beyond what the price ratio has already moved, in standard deviations of the pair's own history. Large positive = signals diverged, price has not followed.",
      calculation: "z_own(4-week change in signal gap) - z_own(1-month relative return).",
      caveats: `Needs >=${t.calibrationMinWeeks} weeks of the pair's own history to standardise; below that the cell shows raw pp/% and is marked uncalibrated. We never fabricate a z-score from a short window. The displayed value is the larger-magnitude engine's z-difference; "driver" (E1/E2) is a magnitude tiebreak, NOT a claim that both engines fired.`,
    },
    unpricedGapEngines: {
      id: "unpricedGapEngines",
      label: "engines agree",
      short_def: "Whether BOTH engines independently produced a same-direction, calibrated unpriced gap — a real agreement predicate, not the display driver.",
      calculation: `True when Engine 1 and Engine 2 each have a calibrated z-difference of at least ${t.unpricedAgreeMinZ} pointing the same way. Replaces the old float-equality "BOTH" that could never fire.`,
      caveats: "The Engine-2 leg is restated-basis; agreement is a stronger reason to look, not a finding.",
    },
    e2GapStep: {
      id: "e2GapStep",
      label: "Engine-2 unpriced step",
      short_def: "The size (pp) of the most recent step in the Engine-2 inflection gap, carried forward until the next quarterly refresh.",
      calculation: `Change since the last refresh of the piecewise-constant E2 gap, carried forward and expiring after ${t.e2StepMaxCarryWeeks} grid weeks (one quarter) so a stale step cannot fire forever.`,
      caveats: "Restated-basis (reconstructed from restated statements) — drives the secondary E2_UNPRICED event and is never pooled with Leg B evidence.",
      basis: "quarterly",
    },
    priceRatioZ: {
      id: "priceRatioZ",
      label: "price-ratio z",
      short_def: "Today's price ratio vs its own long-run mean, in standard deviations. Context only.",
      caveats: "A stretched ratio WITH signal support means you are late (different from wrong); stretched WITHOUT signal support is the fade-or-find-out case.",
    },
    valRatioPctile: {
      id: "valRatioPctile",
      label: "valuation ratio percentile",
      short_def: "The long leg's median forward multiple divided by the short leg's, as a percentile of that ratio's own 5-year history.",
      caveats: "Self-referential and intra-pair — consistent with the platform's valuation-vs-own-history convention.",
    },
    ewMinusCw1m: {
      id: "ewMinusCw1m",
      label: "equal-weight - cap-weight return, 1m",
      short_def: "The pair's 1-month return equal-weighted minus the same cap-weighted. A large gap means a few mega-caps drive the cap-weighted picture while the typical stock says something different.",
    },
    residualShare: {
      id: "residualShare",
      label: "stock-specific share of spread risk",
      short_def: "Fraction of spread variance NOT explained by the 14 factors. High = the pair isolates something company/industry-specific; low = it is a factor bet in disguise.",
      calculation: "1 - R^2 of the weekly spread regressed on the 14 factors over 2 years.",
      caveats: `Below ${t.factorBetResidualPct}% the pair is flagged a factor bet — you are trading the top factor, not the thesis.`,
    },
    topFactor: {
      id: "topFactor",
      label: "largest net factor exposure",
      short_def: "The factor with the largest absolute net loading on the spread. Tells you what being long this pair is substantially a bet on.",
    },
    topFactorVarPct: {
      id: "topFactorVarPct",
      label: "top factor risk share",
      short_def: "The top factor's percent contribution to the spread's variance — its RISK weight, distinct from the raw loading.",
      calculation: "Euler decomposition: beta_top * (Sigma * beta)_top / Var(spread), over the same 2y weekly window as the factor regression.",
      caveats: "A large loading on a low-variance factor can carry little risk, and vice versa — this is the number that says how much the top factor actually matters.",
      basis: "2 years weekly",
    },
    betaNeutralRatio: {
      id: "betaNeutralRatio",
      label: "beta-neutral sizing",
      short_def: "Dollars of short per $1 long that equalises the two legs' market beta, shown alongside the dollar-neutral (1:1) sizing.",
    },
    dispersion: {
      id: "dispersion",
      label: "revision dispersion",
      short_def: "How split analyst revisions are INSIDE a subsector, as a percentile of its own 5-year history. Left = trade the basket (Tier 1); right = pick stocks inside it (Tier 2).",
      calculation: "Interquartile range of the raw winsorized revision values (never the within-subsector z-scores, which have unit variance by construction).",
    },
    factorRiskRemoved: {
      id: "factorRiskRemoved",
      label: "factor risk removed",
      short_def: "Share of the long's FACTOR variance cancelled by the hedge.",
    },
    totalRiskRemoved: {
      id: "totalRiskRemoved",
      label: "total risk removed",
      short_def: "Share of the long's TOTAL variance removed after adding the hedge's own idiosyncratic noise. The honest number.",
      caveats: "Diverges sharply from factor risk removed for single-name hedges — a name can cancel factor exposure almost perfectly while barely reducing total risk, or even increasing it. Negative values are shown, not clamped.",
    },
    residualCorrelation: {
      id: "residualCorrelation",
      label: "residual correlation",
      short_def: "Correlation of the long and hedge residuals (what remains after factors) — high residual correlation is what makes a hedge remove real risk.",
    },
    hedgeRatio: {
      id: "hedgeRatio",
      label: "hedge ratio",
      short_def: "Dollars short per $1 long.",
      calculation: "w = (b_L' S b_c) / (b_c' S b_c + sigma^2_c); keeping the hedge's idiosyncratic variance in the denominator penalises noisy hedges.",
    },
    empiricalBeta: {
      id: "empiricalBeta",
      label: "realized beta / R-squared",
      short_def: "The hedge's beta to the long and the fit, measured from 2 years of raw weekly returns — the empirical cross-check on the model number.",
    },
    splitHalfRatio: {
      id: "splitHalfRatio",
      label: "hedge ratio, first half / second half",
      short_def: "The empirical hedge ratio estimated separately on each half of the 2-year window.",
      caveats: "When the halves differ by more than ~0.2 the ratio is unstable — trust neither the model nor history.",
    },
    rollingRatio: {
      id: "rollingRatio",
      label: "hedge ratio, rolling 52 weeks",
      short_def: "The rolling 52-week empirical hedge ratio plotted against the model-implied constant.",
    },
    containsTarget: {
      id: "containsTarget",
      label: "contains target",
      short_def: "For an ETF hedge, the weight of the long target inside the ETF. Hedging with an ETF that holds the target partially cancels the position against itself.",
    },
    borrowFlag: {
      id: "borrowFlag",
      label: "borrow",
      short_def: "Ease-of-borrow proxy from float, market cap and liquidity.",
      caveats: "Short interest itself is not available from the data provider, so single-name short-interest gates are not shown; the short side leans on baskets and ETFs.",
    },
    tier2: {
      id: "tier2",
      label: "Tier 2 single-stock pair",
      short_def: `The top ${t.tier2K} names on a ranking engine (long) against the bottom ${t.tier2K} (short), within one subsector — a stock-picking spread inside a high-dispersion group.`,
      calculation: `Kill screens run first (a trap/accrual name is removed from the long leg, an Engine-3-accumulating name from the short), then top-${t.tier2K}/bottom-${t.tier2K} of the survivors. Requires >=${t.tier2MinSubsectorNames} names and dispersion >= the ${t.tier2MinDispersionPctile}th percentile of the subsector's own history.`,
      caveats: "Quality flags only exist from the fundamental job's first week; earlier weeks are UNSCREENED and never pooled with screened weeks in Validation. The short side is basket-scoped — single-name short interest / ADV / borrow are unavailable.",
    },
    tier3: {
      id: "tier3",
      label: "Tier 3 curated-link read-through",
      short_def:
        "A hand-curated link between two economically connected companies. A read-through fires when one side's signal moves decisively and the other has not yet followed — the tradeable gap is the lag before the second name reacts.",
      calculation: `Fires when one side's Engine-1 z >= ${t.tier3FiredZ} while the other is < ${t.tier3QuietZ}. Escalates to WATCH after ${t.tier3WatchWeeks} weeks, CONFIRMS when the second side moves the expected way (opposite way for input-cost links), and expires after ${t.tier3MaxWeeks} weeks unconfirmed.`,
      caveats: "Curated by hand, so coverage is deliberately narrow and starts empty. Supplier ▸ customer links are directional (only the supplier can lead); input-cost links expect a negative correlation.",
    },
    readThroughStatus: {
      id: "readThroughStatus",
      label: "read-through status",
      short_def: "NEW (a fresh lead), WATCH (the lead has persisted and is tradeable), or CONFIRMED (the second side has since followed).",
    },
    forwardRelReturn: {
      id: "forwardRelReturn",
      label: "forward relative return",
      short_def: "Long-leg return minus short-leg return over the horizon AFTER the event, versus the same pairs on their non-flagged weeks (the control).",
      calculation: "Mean over events of (r_long - r_short) at h weeks forward, minus the control mean.",
    },
    effectiveSample: {
      id: "effectiveSample",
      label: "effective sample",
      short_def: "The number of INDEPENDENT observations after collapsing to weekly means and accounting for overlapping forward windows — far smaller than the raw event count.",
      calculation: "Newey-West effective N on the weekly-mean series at lag = horizon - 1.",
      caveats: "Overlapping horizons and many pairs in the same week are not independent, so the raw event count massively overstates the evidence. The headline gates on this, not on events.",
    },
    hitRate: {
      id: "hitRate",
      label: "hit rate",
      short_def: "Share of events where the forward relative return had the expected sign.",
    },
    eventIC: {
      id: "eventIC",
      label: "information coefficient",
      short_def: "Rank correlation between the event signal (unpriced gap) and the forward relative return.",
    },
    decayCurve: {
      id: "decayCurve",
      label: "decay curve",
      short_def: "Cumulative forward relative return week by week after the event, with a ±1 standard-error band and the control line — shows when the edge appears and fades.",
    },
    headlineGate: {
      id: "headlineGate",
      label: "headline gate",
      short_def: "The headline shows a number only once the evidence clears three floors at once; otherwise it shows counts and targets, never a return.",
      calculation: `Requires effective weeks >= ${t.validationHeadlineMinWeeks}, distinct pairs >= ${t.validationHeadlineMinPairs}, and span >= ${t.validationHeadlineMinSpanMonths} months. Span is separate so a large sample concentrated in one regime cannot clear the gate.`,
    },
  };

  const withFlags = { ...base } as Record<PairMetricId, MetricDef>;
  for (const id of PAIR_FLAG_IDS) {
    const { label, rule } = pairFlagRule(id, t);
    withFlags[`flag.${id}`] = { id: `flag.${id}`, label, short_def: rule };
  }
  return withFlags;
}

export const PAIR_METRIC_REGISTRY = buildPairMetricRegistry(PAIR_THRESHOLDS);

export function pairMetric(id: PairMetricId): MetricDef {
  return PAIR_METRIC_REGISTRY[id] ?? { id: String(id), label: String(id), short_def: "" };
}
