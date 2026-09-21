import { describe, expect, it } from "vitest";
import {
  PAIR_METRIC_IDS,
  PAIR_METRIC_REGISTRY,
  pairMetric,
  buildPairMetricRegistry,
  type PairMetricId,
} from "@/lib/pairs/metric-registry";
import { PAIR_FLAG_IDS } from "@/lib/pairs/flags";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";

/**
 * Every metric id rendered in a pairs tooltip (via PairMetricTip / pairMetric)
 * must resolve to a real definition. TypeScript already constrains the id prop
 * to PairMetricId, so this enumerates the concrete ids the three screens render
 * as a regression guard against a definition being deleted from the registry.
 */
const RENDERED_IDS: PairMetricId[] = [
  // Pair Map — rank table + matrix
  "hedgeEff", "e1Gap", "e1Gap4wChange", "e2Gap", "e2Gap4wChange", "e3NetBuyerGap",
  "signalSparkline", "priceRatioSparkline", "relReturn1m", "relReturn3m", "unpricedGap",
  "valRatioPctile", "priceRatioZ", "residualShare", "topFactor", "topFactorVarPct", "crowding",
  "crowdBreadth", "unpricedGapEngines", "e2GapStep", "ewMinusCw1m",
  "e1Breadth", "e2Breadth", "e1Gap",
  // Hedge Finder
  "factorRiskRemoved", "totalRiskRemoved", "residualShare", "residualCorrelation",
  "empiricalBeta", "splitHalfRatio", "rollingRatio", "hedgeRatio",
  // Validation
  "forwardRelReturn", "effectiveSample", "hitRate", "eventIC",
  // Tier 2 / Tier 3
  "tier2", "tier3", "readThroughStatus",
];

describe("pairs metric registry", () => {
  it("resolves every rendered metric id to a non-empty definition", () => {
    for (const id of RENDERED_IDS) {
      const def = pairMetric(id);
      expect(def, `metric ${id} should resolve`).toBeTruthy();
      expect(def.label, `metric ${id} needs a label`).toBeTruthy();
      expect(def.short_def, `metric ${id} needs a short_def`).toBeTruthy();
    }
  });

  it("resolves every id in PAIR_METRIC_IDS", () => {
    for (const id of PAIR_METRIC_IDS) {
      const def = PAIR_METRIC_REGISTRY[id];
      expect(def, `${id} missing from registry`).toBeTruthy();
      expect(def.short_def.length).toBeGreaterThan(0);
    }
  });

  it("resolves every flag id under the flag.* namespace", () => {
    for (const id of PAIR_FLAG_IDS) {
      const def = pairMetric(`flag.${id}` as PairMetricId);
      expect(def.label, `flag ${id} needs a label`).toBeTruthy();
      expect(def.short_def, `flag ${id} needs a rule`).toBeTruthy();
    }
  });

  it("interpolates live thresholds into the definition copy (no drift from code)", () => {
    const reg = buildPairMetricRegistry(PAIR_THRESHOLDS);
    expect(reg.hedgeEff.caveats).toContain(String(PAIR_THRESHOLDS.minHedgeEff));
    expect(reg.unpricedGap.caveats).toContain(String(PAIR_THRESHOLDS.calibrationMinWeeks));
    expect(reg.headlineGate.calculation).toContain(String(PAIR_THRESHOLDS.validationHeadlineMinWeeks));
    expect(reg.tier2.short_def).toContain(String(PAIR_THRESHOLDS.tier2K));
    expect(reg.crowdBreadth.short_def).toContain(String(PAIR_THRESHOLDS.crowdNameMinPct));
    expect(reg.unpricedGapEngines.calculation).toContain(String(PAIR_THRESHOLDS.unpricedAgreeMinZ));
    expect(reg.e2GapStep.calculation).toContain(String(PAIR_THRESHOLDS.e2StepMaxCarryWeeks));
  });

  it("carries no un-interpolated template placeholders", () => {
    for (const id of PAIR_METRIC_IDS) {
      const def = PAIR_METRIC_REGISTRY[id];
      const blob = [def.short_def, def.calculation, def.caveats, def.basis].filter(Boolean).join(" ");
      expect(blob, `${id} has an un-interpolated placeholder`).not.toMatch(/\$\{/);
    }
  });
});
