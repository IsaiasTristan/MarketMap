/**
 * Engine 1 — the metric definition registry.
 *
 * ONE typed definition per metric, shared across every research tab so the
 * same concise text renders in every tooltip. Every NUMBER a definition cites
 * (gap thresholds, streak lengths, ER window, IC windows) is INTERPOLATED from
 * REVISION_THRESHOLDS — the same object the detectors and services read — so
 * the copy physically cannot drift from the code. The registry is therefore a
 * FUNCTION of the config; `REV_METRIC_REGISTRY` is the default binding.
 * Definitions are plain English first, formula second.
 */
import { REVISION_THRESHOLDS, type RevisionThresholds } from "@/lib/revision/config";
import type { MetricDef } from "@/lib/analysis/metric-def";

export type { MetricDef };

/** All metric ids in the registry. Adding a metric here makes it available everywhere. */
export const REV_METRIC_IDS = [
  // Core scores
  "composite",
  "globalComposite",
  "rank",
  "decile",
  "newArrival",
  // Signal z's
  "epsRevisionZ",
  "revenueRevisionZ",
  "estimateBreadthZ",
  "ratingMomentumZ",
  "ptRevisionZ",
  "ratingNet",
  "epsDispersion",
  "dispTrend",
  "proximityWeight",
  // Gap machinery
  "px4wZ",
  "composite4wZ",
  "gapScore",
  "side",
  "streak",
  "streakSource",
  // Setup tags
  "setupUnpr",
  "setupStrk",
  "setupEr",
  "setupDomino",
  // Transitions
  "newLong",
  "newShort",
  "gapClosed",
  "streakBroken",
  "groupInflection",
  "groupRollover",
  "nextDomino",
  "erWithin7d",
  // Summary stats
  "signalIc",
  "mktBreadth",
  "actionable",
  "newCount",
  "exitCount",
  // Validation stats
  "rollingIc",
  "ic26wMean",
  "icTStat",
  "d10d1",
  "d10HitRate",
  "newFlagDrift",
  "perSignalIc",
  "regime",
  "decileChart",
  "effectiveWindow",
  "legBOnly",
  // Calendar
  "revZIn",
  "nextEr",
  "setupIntoPrint",
  // Decomp
  "groupZ",
  "idioZ",
  "grpIdioSplit",
  "implication",
] as const;

export type RevMetricId = (typeof REV_METRIC_IDS)[number];

/** Build the registry from the thresholds config; every cited number is interpolated. */
export function buildRevisionMetricRegistry(t: RevisionThresholds): Record<RevMetricId, MetricDef> {
  const gap = t.newFlagMinAbsGap.toFixed(1);
  const gapClose = t.gapClosedAbsGap.toFixed(1);
  const cross = t.groupCrossLevel.toFixed(1);
  const dominoBand = t.dominoOwnMaxAbsZ.toFixed(1);
  const w4 = `${t.composite4wWindow}w`;

  return {
    composite: {
      id: "composite",
      label: "rev composite z",
      short_def:
        "The name's overall revision score this week: the equal-weighted mean of its five signal z-scores (EPS, revenue, breadth, rating momentum, PT), each computed relative to its peer group. Positive = estimates and ratings improving faster than peers.",
      calculation: "comp = mean(z_eps, z_rev, z_brd, z_rtg, z_pt), each z within peer group",
      basis: "Point-in-time weekly. Peer group = subsector when it has ≥8 names, else sector.",
    },
    globalComposite: {
      id: "globalComposite",
      label: "universe composite z",
      short_def:
        "The same five-signal composite z-scored across the ENTIRE universe instead of within peer groups. Used for group-level analytics (decomp, group triggers) because the peer-relative composite averages to ~zero inside every peer group by construction.",
      basis: "Point-in-time weekly, universe-relative.",
    },
    rank: {
      id: "rank",
      label: "rank",
      short_def: "Position in the universe ordered by composite, 1 = strongest revision profile this week.",
    },
    decile: {
      id: "decile",
      label: "decile",
      short_def:
        "Composite decile within the name's peer group, 10 = strongest tenth, 1 = weakest. Drives the NEW LONG / NEW SHORT flags together with the gap score.",
    },
    newArrival: {
      id: "newArrival",
      label: "new arrival",
      short_def:
        "Entered the top peer-group decile this week from below it (or from absence) last week — a freshly-inflecting name, not one that has been strong for months.",
    },
    epsRevisionZ: {
      id: "epsRevisionZ",
      label: "EPS z",
      short_def:
        "Week-over-week change in the forward-period consensus EPS estimate, peer-group z-scored. Positive = analysts raising EPS faster than peers.",
      calculation: "z( (eps_now − eps_prior) / |eps_prior| ), proximity-weighted near earnings",
      basis: "Leg A (estimate snapshots) — accrues weekly.",
    },
    revenueRevisionZ: {
      id: "revenueRevisionZ",
      label: "Rev z",
      short_def:
        "Week-over-week change in the forward-period consensus revenue estimate, peer-group z-scored. Positive = revenue estimates rising faster than peers.",
      basis: "Leg A (estimate snapshots) — accrues weekly.",
    },
    estimateBreadthZ: {
      id: "estimateBreadthZ",
      label: "Brd z",
      short_def:
        "How one-sided this week's estimate moves are across tracked metrics (revenue, EPS, EBITDA, EBIT, net income): (up − down) / total, peer-group z-scored. +1 raw = every tracked metric moved up.",
      basis: "Leg A (estimate snapshots) — accrues weekly.",
    },
    ratingMomentumZ: {
      id: "ratingMomentumZ",
      label: "Rtg z",
      short_def:
        "Week-over-week change in net analyst rating stance ((buys − sells) / total), peer-group z-scored. Positive = the rating mix shifting bullish.",
      basis: "Leg B (ratings) — full history.",
    },
    ptRevisionZ: {
      id: "ptRevisionZ",
      label: "PT z",
      short_def:
        "Week-over-week change in the consensus price target, peer-group z-scored. Positive = targets being raised faster than peers.",
      basis: "Leg B (price targets) — full history.",
    },
    ratingNet: {
      id: "ratingNet",
      label: "rating net",
      short_def:
        "Level (not change) of the analyst stance: (strong buy + buy − sell − strong sell) / total ratings, in [−1, +1]. Context only — not in the composite.",
    },
    epsDispersion: {
      id: "epsDispersion",
      label: "EPS dispersion",
      short_def:
        "Analyst disagreement on forward EPS: (high estimate − low estimate) / |mean|. Wide dispersion = the print is genuinely contested; narrowing dispersion often precedes re-rating.",
      basis: "Leg A (estimate snapshots) — accrues weekly.",
    },
    dispTrend: {
      id: "dispTrend",
      label: "disp trend",
      short_def: `Direction of EPS dispersion over the trailing ${t.dispersionTrendWindow} weeks: NARROWING (analysts converging), WIDENING (diverging), or FLAT. Needs ≥3 weeks of dispersion history.`,
      calculation: "Sign of the least-squares slope of dispersion vs time, with a flat band.",
      basis: "Leg A — accruing; blank until enough weeks exist.",
    },
    proximityWeight: {
      id: "proximityWeight",
      label: "proximity weight",
      short_def:
        "Revisions inside 30 days of the next earnings date are amplified (up to 2× at the print) — a raise the week before earnings says more than one mid-quarter.",
      calculation: "w = 1 + (30 − daysToER)/30 inside the window, else 1",
    },
    px4wZ: {
      id: "px4wZ",
      label: "px z (4w)",
      short_def: `Trailing ${w4} price return, z-scored within the peer group — how much the market has ALREADY moved this name relative to peers. The price leg of the gap score.`,
      basis: "Weekly closes (FMP), grid-step returns. “4w” = 4 snapshot grid steps.",
    },
    composite4wZ: {
      id: "composite4wZ",
      label: "rev z (4w)",
      short_def: `Trailing ${w4} mean of the weekly revision composite — the sustained revision signal, less twitchy than a single week. Clamps to available history while Leg A accrues (the effective window is labeled).`,
    },
    gapScore: {
      id: "gapScore",
      label: "gap",
      short_def:
        "Unpriced revision gap: 4-wk revision composite z minus 4-wk peer-relative price return z. Positive = estimates rising faster than price has moved — potential long. Negative = price hasn't caught down to falling estimates — potential short.",
      calculation: "gap = revZ(4w) − pxZ(4w)",
    },
    side: {
      id: "side",
      label: "side",
      short_def: `Current flag: L (long set), S (short set), or W (watch). Entry needs an extreme peer decile AND |gap| ≥ ${gap}; the flag then holds until |gap| falls below ${gapClose} (hysteresis, so names don't flap).`,
    },
    streak: {
      id: "streak",
      label: "streak",
      short_def:
        "Consecutive weeks the composite has held one sign. Each cell in the strip is one week (green = positive, red = negative, empty = flat/no data), oldest on the left. Persistent streaks distinguish a genuine revision cycle from a one-week blip.",
      basis: "Composite sign, weekly.",
    },
    streakSource: {
      id: "streakSource",
      label: "streak source",
      short_def: `Which composite the streak reads. Lᴮ = Leg-B only (ratings + price targets, reconstructed point-in-time — full history). Switches to the full 5-signal composite once ${t.legAStreakMinWeeks} weeks of estimate history have accrued.`,
    },
    setupUnpr: {
      id: "setupUnpr",
      label: "UNPR",
      short_def: `Unpriced: |gap score| ≥ ${gap} — the revision move has not been matched by relative price. The core setup tag.`,
    },
    setupStrk: {
      id: "setupStrk",
      label: "STRK",
      short_def: `Streak: the composite has held one sign for ≥ ${t.streakBrokenMinLen} consecutive weeks — a sustained revision cycle, not a blip.`,
    },
    setupEr: {
      id: "setupEr",
      label: "ER",
      short_def: `Earnings soon: reports within ${t.erWindowDays} days. Setups into a print resolve fast, in either direction.`,
    },
    setupDomino: {
      id: "setupDomino",
      label: "DOMINO",
      short_def: `Next domino: the name's group is hot (|group mean z| ≥ ${t.dominoGroupMinAbsZ.toFixed(1)}) while its own z is still near zero (within ±${dominoBand}) — the laggard analysts often get to next.`,
    },
    newLong: {
      id: "newLong",
      label: "NEW LONG",
      short_def: `Entered the long set this week: reached the top peer decile with gap ≥ +${gap} and wasn't flagged last week.`,
    },
    newShort: {
      id: "newShort",
      label: "NEW SHORT",
      short_def: `Entered the short set this week: reached the bottom peer decile with gap ≤ −${gap} and wasn't flagged last week.`,
    },
    gapClosed: {
      id: "gapClosed",
      label: "GAP CLOSED",
      short_def: `A flagged name's |gap| fell below ${gapClose} — price has caught up with the revisions (or they faded). The setup is resolved; the flag clears.`,
    },
    streakBroken: {
      id: "streakBroken",
      label: "STREAK BROKEN",
      short_def: `A streak of ≥ ${t.streakBrokenMinLen} same-sign weeks printed its first opposite-sign week — the earliest sign a revision cycle is turning.`,
    },
    groupInflection: {
      id: "groupInflection",
      label: "GROUP INFLECTION",
      short_def: `A sector/subsector's mean universe-relative composite crossed UP through +${cross} — the group as a whole is inflecting positive.`,
    },
    groupRollover: {
      id: "groupRollover",
      label: "GROUP ROLLOVER",
      short_def: `A sector/subsector's mean universe-relative composite crossed DOWN through −${cross} — the group is rolling over.`,
    },
    nextDomino: {
      id: "nextDomino",
      label: "NEXT DOMINO",
      short_def: `A group is hot (|mean z| ≥ ${t.dominoGroupMinAbsZ.toFixed(1)}) while this member's own z is still within ±${dominoBand} — candidates for the catch-up revision.`,
    },
    erWithin7d: {
      id: "erWithin7d",
      label: "ER ≤7D",
      short_def: `Reports within ${t.erWindowDays} days with |composite z| ≥ ${t.erMinAbsRevisionZ.toFixed(1)} — a live revision signal heading into the print. Fires once per earnings event.`,
    },
    signalIc: {
      id: "signalIc",
      label: "SIGNAL IC",
      short_def: `Is the signal currently working? Rolling ${t.rollingIcWindow}-week mean of the weekly rank correlation (Spearman) between the composite and the next ${t.validationHorizonWeeks}-week peer-relative return. Positive = high-composite names have been outperforming. The ▲/▼ compares it to the ${t.icLongRunWeeks}-week average.`,
      caveats: "When IC ≤ 0 the composite is not predicting — treat the queue as a watchlist, not a signal.",
    },
    mktBreadth: {
      id: "mktBreadth",
      label: "MKT BREADTH",
      short_def:
        "Universe-wide mean estimate breadth this week: (metrics revised up − down) / total, averaged across all names. Positive = the estimate tide is rising broadly; deep negative = a broad cut cycle.",
    },
    actionable: {
      id: "actionable",
      label: "ACTIONABLE",
      short_def: `Names currently carrying a flag: in the top/bottom peer decile with |gap| ≥ ${gap} at entry, gap still open (≥ ${gapClose}). Split into longs (L) and shorts (S).`,
    },
    newCount: {
      id: "newCount",
      label: "NEW",
      short_def: "Names that entered the long or short set at this week's scoring pass.",
    },
    exitCount: {
      id: "exitCount",
      label: "EXITS",
      short_def: "Flags that resolved this week: gaps that closed plus streaks that broke.",
    },
    rollingIc: {
      id: "rollingIc",
      label: "rolling IC",
      short_def: `Weekly Spearman rank IC of composite vs forward ${t.validationHorizonWeeks}-week peer-relative return, smoothed over a trailing ${t.rollingIcWindow}-week window. The window clamps while history accrues.`,
    },
    ic26wMean: {
      id: "ic26wMean",
      label: `IC ${t.icLongRunWeeks}w mean`,
      short_def: `Mean weekly IC over the trailing ${t.icLongRunWeeks} weeks — the long-run health of the signal.`,
    },
    icTStat: {
      id: "icTStat",
      label: "t-stat",
      short_def:
        "Mean weekly IC divided by its standard error — is the average IC distinguishable from luck? |t| ≥ 2 is the usual bar.",
    },
    d10d1: {
      id: "d10d1",
      label: "D10−D1",
      short_def: `Mean forward ${t.validationHorizonWeeks}-week peer-relative return of the top composite decile minus the bottom decile — the gross long-short spread the ranking would have captured.`,
    },
    d10HitRate: {
      id: "d10HitRate",
      label: "D10 hit %",
      short_def: `Share of top-decile names whose forward ${t.validationHorizonWeeks}-week peer-relative return was positive. 50% = coin flip.`,
    },
    newFlagDrift: {
      id: "newFlagDrift",
      label: "new-flag drift",
      short_def:
        "Average price path AFTER a NEW LONG / NEW SHORT flag fired, at 1/2/4/8-week horizons. Tells you whether flags historically kept drifting or mean-reverted.",
      basis: "Accrues as flags age — mostly empty until flags have forward history.",
    },
    perSignalIc: {
      id: "perSignalIc",
      label: "per-signal IC",
      short_def:
        "Attribution: the mean weekly IC of each individual signal z (breadth, EPS, PT, rating, revenue) against forward peer-relative returns — which legs of the composite are pulling their weight.",
      basis: "Full composite only — needs Leg-A history; fills in as weeks accrue.",
    },
    regime: {
      id: "regime",
      label: "regime",
      short_def: `How many of the last ${t.icLongRunWeeks} weekly ICs were positive. A signal can have a good average and still be in a cold streak — this is the streakiness check.`,
    },
    decileChart: {
      id: "decileChart",
      label: "fwd return by decile",
      short_def: `Mean forward ${t.validationHorizonWeeks}-week peer-relative return per composite decile (1 = weakest, 10 = strongest), pooled across all validation weeks. A working signal slopes up left-to-right.`,
    },
    effectiveWindow: {
      id: "effectiveWindow",
      label: "effective window",
      short_def:
        "How many weeks of history this figure ACTUALLY reflects. Estimate snapshots only accrue forward, so every window clamps to what exists and deepens automatically each week.",
    },
    legBOnly: {
      id: "legBOnly",
      label: "LEG-B ONLY",
      short_def:
        "Computed from the ratings/price-target reconstruction alone (full backfilled history), not the full 5-signal composite. Full-composite variants replace these automatically as estimate history accrues.",
    },
    revZIn: {
      id: "revZIn",
      label: "rev z in",
      short_def:
        "The name's composite z heading into the print. Revisions near earnings are proximity-weighted (up to 2× at the print), so this is the amplified read.",
    },
    nextEr: {
      id: "nextEr",
      label: "next ER",
      short_def: "Next scheduled earnings date (FMP earnings calendar; earliest upcoming).",
    },
    setupIntoPrint: {
      id: "setupIntoPrint",
      label: "setup into print",
      short_def:
        "Generated one-liner summarizing the revision setup heading into earnings: streak status, unpriced gap, dispersion trend, and any live queue flag.",
    },
    groupZ: {
      id: "groupZ",
      label: "grp",
      short_def:
        "The group component of the name's universe composite: its group's mean composite, re-z-scored across groups. High = the whole group is moving, not just this name.",
    },
    idioZ: {
      id: "idioZ",
      label: "idio",
      short_def:
        "The idiosyncratic component: universe composite minus the group component. High = THIS name is moving beyond its group — the part you can size without taking a sector bet.",
      calculation: "idio = composite − grp",
    },
    grpIdioSplit: {
      id: "grpIdioSplit",
      label: "grp │ idio split",
      short_def:
        "Visual split of the composite into group (gray, left of axis) and idiosyncratic (amber, right) components. Center line = zero for each component; longer bar = larger magnitude.",
    },
    implication: {
      id: "implication",
      label: "implication",
      short_def:
        "Rule-generated read of the split: idio-driven names are clean single-name ideas; group-driven names are sector bets (hedge accordingly) or domino candidates; offsetting components warrant caution.",
    },
  };
}

/** Default binding to the live thresholds. */
export const REV_METRIC_REGISTRY: Record<RevMetricId, MetricDef> = buildRevisionMetricRegistry(REVISION_THRESHOLDS);

/** Accessor used by MetricTip. Throws in dev on unknown ids (registry coverage bug). */
export function revMetric(id: RevMetricId): MetricDef {
  const def = REV_METRIC_REGISTRY[id];
  if (!def) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(`revision metric-registry: unknown metric id "${id}"`);
    }
    return { id, label: id, short_def: "" };
  }
  return def;
}
