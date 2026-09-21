/**
 * Pairs tab — rule-based pair flags (brief §6.1). No I/O. Each flag is a label
 * plus a plain-English rule (its tooltip) whose numbers interpolate from
 * PAIR_THRESHOLDS, and `computePairFlags` returns the fired flag ids for a
 * snapshot. ENGINES_DISAGREE is deliberately NOT suppressed — analysts and
 * statements pointing opposite ways is the variant-perception setup (§6.1).
 */
import { PAIR_THRESHOLDS, type PairThresholds } from "@/lib/pairs/config";

export const PAIR_FLAG_IDS = [
  "NEW",
  "UNPRICED",
  "CONTRARY",
  "E2_UNPRICED",
  "TRIANGULATED",
  "THIN_GAP",
  "PRICED",
  "FACTOR_BET",
  "CROWDED_LONG",
  "NARROWING",
  "ENGINES_DISAGREE",
  "SHORT_LEG_OWNED",
  "LOW_HEDGE_EFF",
] as const;

export type PairFlagId = (typeof PAIR_FLAG_IDS)[number];

export interface PairFlagInputs {
  /** Entered the top decile by unpriced gap this week. */
  isNewTopDecile: boolean;
  e1Gap: number | null;
  e1Gap4wChange: number | null;
  e2Gap: number | null;
  /** Size (pp) of the most recent Engine-2 gap step — drives E2_UNPRICED. */
  e2GapStepPp: number | null;
  relReturn1m: number | null;
  relReturn3m: number | null;
  priceRatioZ: number | null;
  residualSharePct: number | null;
  crowdingLong: number | null;
  crowdingShort: number | null;
  hedgeEff: number | null;
  /** Name counts of the two legs — feed the THIN_GAP noise floor. */
  longNameCount: number | null;
  shortNameCount: number | null;
}

const isNum = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

/**
 * The gap noise floor in pp: the larger of a fixed pp floor and the breadth a
 * SINGLE name flipping cut-to-raise would move on the smaller leg (200/n). A
 * |gap| below this is less than one analyst changing their mind — noise.
 */
export function gapNoiseFloorPp(
  nLong: number | null,
  nShort: number | null,
  t: PairThresholds = PAIR_THRESHOLDS,
): number {
  const nL = isNum(nLong) && nLong > 0 ? nLong : Infinity;
  const nS = isNum(nShort) && nShort > 0 ? nShort : Infinity;
  const n = Math.min(nL, nS);
  const nameEquiv = Number.isFinite(n) ? t.thinGapNameEquivPp / n : 0;
  return Math.max(t.thinGapMinPp, nameEquiv);
}

/** True when |gap| sits below the name-equivalent noise floor. */
export function isThinGap(
  gap: number | null,
  nLong: number | null,
  nShort: number | null,
  t: PairThresholds = PAIR_THRESHOLDS,
): boolean {
  if (!isNum(gap)) return false;
  return Math.abs(gap) < gapNoiseFloorPp(nLong, nShort, t);
}

export function computePairFlags(i: PairFlagInputs, t: PairThresholds = PAIR_THRESHOLDS): PairFlagId[] {
  const out: PairFlagId[] = [];

  if (i.isNewTopDecile) out.push("NEW");

  if (
    isNum(i.e1Gap4wChange) &&
    i.e1Gap4wChange > t.unpricedGapPp &&
    isNum(i.relReturn1m) &&
    Math.abs(i.relReturn1m) <= t.unpricedRelBand
  ) {
    out.push("UNPRICED");
  }

  // CONTRARY — the signal widened but the price ratio moved the WRONG way.
  // Disjoint from UNPRICED by construction: |rel| <= band vs rel < -band.
  if (
    isNum(i.e1Gap4wChange) &&
    i.e1Gap4wChange > t.unpricedGapPp &&
    isNum(i.relReturn1m) &&
    i.relReturn1m < -t.unpricedRelBand
  ) {
    out.push("CONTRARY");
  }

  // E2_UNPRICED — the Engine-2 (inflection) gap took a large step on its last
  // refresh while the price ratio stayed flat. Restated-basis; secondary only.
  if (
    isNum(i.e2GapStepPp) &&
    i.e2GapStepPp > t.unpricedGapPp &&
    isNum(i.relReturn1m) &&
    Math.abs(i.relReturn1m) <= t.unpricedRelBand
  ) {
    out.push("E2_UNPRICED");
  }

  if (isThinGap(i.e1Gap, i.longNameCount, i.shortNameCount, t)) out.push("THIN_GAP");

  if ((isNum(i.relReturn3m) && i.relReturn3m > t.pricedRel3m) || (isNum(i.priceRatioZ) && i.priceRatioZ > t.pricedRatioZ)) {
    out.push("PRICED");
  }

  if (isNum(i.residualSharePct) && i.residualSharePct < t.factorBetResidualPct) out.push("FACTOR_BET");

  if (isNum(i.crowdingLong) && i.crowdingLong > t.crowdedLongPct) out.push("CROWDED_LONG");

  if (isNum(i.e1Gap) && i.e1Gap > 0 && isNum(i.e1Gap4wChange) && i.e1Gap4wChange < 0) out.push("NARROWING");

  if (
    isNum(i.e1Gap) &&
    isNum(i.e2Gap) &&
    Math.sign(i.e1Gap) !== Math.sign(i.e2Gap) &&
    Math.abs(i.e1Gap) >= t.enginesDisagreeMinPp &&
    Math.abs(i.e2Gap) >= t.enginesDisagreeMinPp
  ) {
    out.push("ENGINES_DISAGREE");
  }

  if (isNum(i.crowdingShort) && i.crowdingShort > t.shortLegOwnedPct) out.push("SHORT_LEG_OWNED");

  if (isNum(i.hedgeEff) && i.hedgeEff < t.minHedgeEff) out.push("LOW_HEDGE_EFF");

  return out;
}

/** Plain-English rule text per flag (tooltip body), numbers from the config. */
export function pairFlagRule(id: PairFlagId, t: PairThresholds = PAIR_THRESHOLDS): { label: string; rule: string } {
  switch (id) {
    case "NEW":
      return { label: "NEW", rule: "Entered the top decile by unpriced gap this week — a new arrival." };
    case "UNPRICED":
      return {
        label: "UNPRICED",
        rule: `The research setup: the signal gap widened more than ${t.unpricedGapPp}pp over 4 weeks while the 1-month relative return stayed within +-${(t.unpricedRelBand * 100).toFixed(0)}%.`,
      };
    case "CONTRARY":
      return {
        label: "CONTRARY",
        rule: `The signal gap widened more than ${t.unpricedGapPp}pp over 4 weeks but the 1-month relative return moved the WRONG way (below -${(t.unpricedRelBand * 100).toFixed(0)}%). Secondary event kind, disjoint from UNPRICED — the signal and price disagreed rather than merely not-yet-agreed.`,
      };
    case "E2_UNPRICED":
      return {
        label: "E2 UNPRICED",
        rule: `The Engine-2 inflection gap took a step of more than ${t.unpricedGapPp}pp on its last quarterly refresh while the 1-month relative return stayed within +-${(t.unpricedRelBand * 100).toFixed(0)}%. Secondary and RESTATED-BASIS (reconstructed from restated statements) — never pooled with Leg B evidence.`,
      };
    case "TRIANGULATED":
      return {
        label: "TRIANGULATED",
        rule: `An Engine-1 firing and an Engine-2 firing for this pair landed within +-${t.triangulationWindowWeeks} weeks of each other. Secondary event kind — a reason to investigate, not a finding, and its E2 leg carries the restated-basis caveat.`,
      };
    case "THIN_GAP":
      return {
        label: "THIN GAP",
        rule: `The current gap is below the noise floor max(${t.thinGapMinPp}pp, ${t.thinGapNameEquivPp}/min(n)) — less than one analyst on the smaller leg changing their mind, so there is little to trade even if the 4-week change is large.`,
      };
    case "PRICED":
      return {
        label: "PRICED",
        rule: `Probably late: the 3-month relative return is above +${(t.pricedRel3m * 100).toFixed(0)}% or the price-ratio z is above +${t.pricedRatioZ}.`,
      };
    case "FACTOR_BET":
      return {
        label: "FACTOR BET",
        rule: `Stock-specific share of spread risk is below ${t.factorBetResidualPct}% — you are trading the top factor, not the thesis.`,
      };
    case "CROWDED_LONG":
      return { label: "CROWDED LONG", rule: `More than ${t.crowdedLongPct}% of watchlist funds hold the long leg — a late trade.` };
    case "NARROWING":
      return { label: "NARROWING", rule: "The gap is still positive but its 4-week change turned negative — the thesis is decaying." };
    case "ENGINES_DISAGREE":
      return {
        label: "E1/E2 DISAGREE",
        rule: `Analyst revisions and business inflection point opposite ways, both at least ${t.enginesDisagreeMinPp}pp — resolve the variant perception before acting.`,
      };
    case "SHORT_LEG_OWNED":
      return { label: "S LEG OWNED", rule: `More than ${t.shortLegOwnedPct}% of watchlist funds still hold the leg you would short.` };
    case "LOW_HEDGE_EFF":
      return { label: "LOW EFF", rule: `Hedge efficiency is below ${t.minHedgeEff} — the legs do not move together enough to be a real pair.` };
  }
}
