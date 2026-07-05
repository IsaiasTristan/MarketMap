import { describe, expect, it } from "vitest";
import { REVISION_THRESHOLDS } from "@/lib/revision/config";
import {
  buildRevisionMetricRegistry,
  REV_METRIC_IDS,
  REV_METRIC_REGISTRY,
  revMetric,
} from "@/lib/revision/metric-registry";

describe("revision metric registry", () => {
  it("has a definition for every id, with label + short_def", () => {
    for (const id of REV_METRIC_IDS) {
      const def = REV_METRIC_REGISTRY[id];
      expect(def, id).toBeDefined();
      expect(def.id).toBe(id);
      expect(def.label.length, id).toBeGreaterThan(0);
      expect(def.short_def.length, id).toBeGreaterThan(10);
    }
  });

  it("keeps short definitions concise-ish and single-sourced", () => {
    expect(REV_METRIC_IDS.length).toBeGreaterThanOrEqual(30);
    const labels = REV_METRIC_IDS.map((id) => REV_METRIC_REGISTRY[id].label);
    expect(new Set(labels).size).toBe(labels.length); // no duplicate labels
  });

  it("interpolates config numbers — copy moves when thresholds move", () => {
    const modified = { ...REVISION_THRESHOLDS, newFlagMinAbsGap: 9.9, erWindowDays: 42 };
    const reg = buildRevisionMetricRegistry(modified);
    expect(reg.setupUnpr.short_def).toContain("9.9");
    expect(reg.setupEr.short_def).toContain("42");
    expect(reg.setupUnpr.short_def).not.toBe(REV_METRIC_REGISTRY.setupUnpr.short_def);
  });

  it("cites the live thresholds in the default binding", () => {
    expect(REV_METRIC_REGISTRY.setupUnpr.short_def).toContain(
      REVISION_THRESHOLDS.newFlagMinAbsGap.toFixed(1),
    );
    expect(REV_METRIC_REGISTRY.gapClosed.short_def).toContain(
      REVISION_THRESHOLDS.gapClosedAbsGap.toFixed(1),
    );
    expect(REV_METRIC_REGISTRY.streakBroken.short_def).toContain(
      String(REVISION_THRESHOLDS.streakBrokenMinLen),
    );
  });

  it("revMetric throws on unknown ids in dev", () => {
    expect(() => revMetric("nonsense" as never)).toThrow(/unknown metric id/);
  });
});
