import { describe, expect, it } from "vitest";
import { buildMetricRegistry, METRIC_REGISTRY, METRIC_IDS } from "@/lib/institutional/metric-registry";
import { FUND_OVERVIEW_CONFIG } from "@/domain/calculations/fund-overview-config";
import { FUNDS_ATTRIBUTION_CONFIG } from "@/domain/calculations/funds-attribution-config";
import { INITIATION_CONFIG } from "@/domain/calculations/initiation";

const base = {
  overview: FUND_OVERVIEW_CONFIG,
  attribution: FUNDS_ATTRIBUTION_CONFIG,
  initiation: INITIATION_CONFIG,
};

describe("metric registry", () => {
  it("has a definition for every declared id, with label + short_def", () => {
    for (const id of METRIC_IDS) {
      const def = METRIC_REGISTRY[id];
      expect(def, id).toBeTruthy();
      expect(def.id).toBe(id);
      expect(def.label.length).toBeGreaterThan(0);
      expect(def.short_def.length).toBeGreaterThan(0);
    }
  });

  it("interpolates the default config numbers into the copy", () => {
    // return_conf_bands 25/45 → confidence def; diff_ideas_min_bps 25 → peers/diff defs.
    expect(METRIC_REGISTRY.confidence.short_def).toContain("< 25%/q");
    expect(METRIC_REGISTRY.confidence.short_def).toContain("45%");
    expect(METRIC_REGISTRY.differentiatedIdeas.short_def).toContain("≥25 bps");
    expect(METRIC_REGISTRY.styleTwins.short_def).toContain("10 nearest");
    expect(METRIC_REGISTRY.followRate.short_def).toContain(`≥${FUNDS_ATTRIBUTION_CONFIG.follow_min_funds}`);
    expect(METRIC_REGISTRY.qualifiedInitiation.short_def).toContain(`≥${INITIATION_CONFIG.min_entry_bps} bps`);
  });

  it("PARAMETER INTERPOLATION: the copy moves when the config moves (cannot drift from code)", () => {
    const modified = buildMetricRegistry({
      overview: {
        ...FUND_OVERVIEW_CONFIG,
        return_conf_bands: { high: 30, med: 55 },
        diff_ideas_min_bps: 40,
        twins_k: 15,
        peer_min_size: 8,
      },
      attribution: { ...FUNDS_ATTRIBUTION_CONFIG, follow_min_funds: 5, follow_window: 4 },
      initiation: { ...INITIATION_CONFIG, min_entry_bps: 50 },
    });

    // New numbers present …
    expect(modified.confidence.short_def).toContain("< 30%/q");
    expect(modified.confidence.short_def).toContain("55%");
    expect(modified.differentiatedIdeas.short_def).toContain("≥40 bps");
    expect(modified.peersHold.short_def).toContain("≥40 bps");
    expect(modified.styleTwins.short_def).toContain("15 nearest");
    expect(modified.peerMedian.short_def).toContain("8 funds");
    expect(modified.followRate.short_def).toContain("≥5");
    expect(modified.followRate.short_def).toContain("within 4 quarters");
    expect(modified.qualifiedInitiation.short_def).toContain("≥50 bps");

    // … and the OLD defaults are gone (proving it wasn't hardcoded).
    expect(modified.confidence.short_def).not.toContain("< 25%/q");
    expect(modified.differentiatedIdeas.short_def).not.toContain("≥25 bps");
    expect(modified.styleTwins.short_def).not.toContain("10 nearest");
  });
});
