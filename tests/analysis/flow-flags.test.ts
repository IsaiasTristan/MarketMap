import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FLOW_FLAGS, FLOW_FLAG_IDS, activeFlowFlags, flowFlagColor } from "@/lib/institutional/flow-flags";

describe("flow-flags registry (Part 5 shared store)", () => {
  it("defines every flag id with a glyph, tone, and tooltip", () => {
    expect(FLOW_FLAG_IDS).toEqual(["verify-weights", "partial-data", "unresolved-split", "tenure-verify"]);
    for (const id of FLOW_FLAG_IDS) {
      const def = FLOW_FLAGS[id];
      expect(def.id).toBe(id);
      expect(def.glyph.length).toBeGreaterThan(0);
      expect(def.tooltip.length).toBeGreaterThan(0);
      expect(["negative", "accent"]).toContain(def.tone);
    }
  });

  it("behavior-preserving: verify/partial glyphs + tooltips match the leaderboard's prior copy", () => {
    // These strings were the leaderboard's inline VERIFY/PARTIAL badges before the
    // extraction — the refactor must not change what users read.
    expect(FLOW_FLAGS["verify-weights"].glyph).toBe("VERIFY");
    expect(FLOW_FLAGS["verify-weights"].tooltip).toBe(
      "Median holder weight implausibly high or a suspected reported-value unit error — conviction not counted pending review",
    );
    expect(FLOW_FLAGS["partial-data"].glyph).toBe("PARTIAL");
    expect(FLOW_FLAGS["partial-data"].tooltip).toBe("Some holders' filings are missing this quarter — score may be incomplete");
    expect(flowFlagColor(FLOW_FLAGS["verify-weights"])).toBe("var(--color-negative)");
    expect(flowFlagColor(FLOW_FLAGS["partial-data"])).toBe("var(--color-accent)");
  });

  it("activeFlowFlags maps boolean state to registry defs in registry order", () => {
    expect(activeFlowFlags({ verifyData: true, partialData: true }).map((d) => d.id)).toEqual(["verify-weights", "partial-data"]);
    expect(activeFlowFlags({ partialData: true }).map((d) => d.id)).toEqual(["partial-data"]);
    expect(activeFlowFlags({})).toEqual([]);
    expect(activeFlowFlags(null)).toEqual([]);
  });

  it("BUILD-TIME ASSERTION: leaderboard and rotation render flags from the SAME store", () => {
    // Both views must go through the shared FlagBadges component (flowsUi), which is
    // the sole importer of the flow-flags registry — so a name shows identical
    // glyph + tooltip everywhere. Guard against a view re-inlining its own badges.
    const read = (p: string) => readFileSync(resolve(p), "utf8");
    const rotation = read("src/components/analysis/flows/RotationPanel.tsx");
    const leaderboard = read("src/components/analysis/flows/leaderboard/LeaderboardPanel.tsx");
    const flowsUi = read("src/components/analysis/flows/flowsUi.tsx");
    expect(rotation).toMatch(/FlagBadges/);
    expect(leaderboard).toMatch(/FlagBadges/);
    expect(flowsUi).toMatch(/flow-flags/);
    // The leaderboard must NOT re-inline the old raw VERIFY/PARTIAL badge strings.
    expect(leaderboard).not.toMatch(/>VERIFY</);
    expect(leaderboard).not.toMatch(/>PARTIAL</);
  });
});
