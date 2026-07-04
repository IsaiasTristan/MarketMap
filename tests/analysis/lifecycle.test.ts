import { describe, expect, it } from "vitest";
import {
  classifyLifecycleAt,
  classifyLifecycleSeries,
  detectTransitions,
  LIFECYCLE_CONFIG as CFG,
} from "@/domain/calculations/lifecycle";

const stageAt = (bps: number[], crowded = false) => classifyLifecycleAt(bps, crowded, CFG).stage;

describe("lifecycle: per-stage classification", () => {
  it("SPIKE: a lone above-floor quarter after flat quarters", () => {
    expect(stageAt([0, 0, 0, 10])).toBe("SPIKE");
  });

  it("SPIKE requires the move to clear spike_floor_bps", () => {
    expect(stageAt([0, 0, 0, 1])).not.toBe("SPIKE"); // 1 < 3
  });

  it("FORMING: a 2-3 quarter run", () => {
    expect(stageAt([0, 2, 2])).toBe("FORMING"); // streak 2
    expect(stageAt([0, 2, 2, 2])).toBe("FORMING"); // streak 3
  });

  it("DURABLE: streak ≥ 4 with a consistent (staircase) slope", () => {
    expect(stageAt([2, 2, 2, 2, 2])).toBe("DURABLE"); // streak 5, R²≈1
  });

  it("DURABLE applies the slope-consistency gate (R² ≥ durable_min_r2)", () => {
    // A real 5-qtr build (streak 5) but slightly uneven steps: under a strict
    // R² gate it does not qualify as DURABLE, proving the gate is enforced.
    const strict = { ...CFG, durable_min_r2: 0.999 };
    const info = classifyLifecycleAt([2, 3, 1, 4, 2], false, strict);
    expect(info.streak).toBe(5);
    expect(info.stage).not.toBe("DURABLE");
  });

  it("CORE: a durable build that plateaus for 2+ quarters, retained ≥ 80% of peak", () => {
    // 5-qtr build then 2 flat quarters. Acc stays at its peak → retained 100%.
    expect(stageAt([3, 3, 3, 3, 3, 0, 0])).toBe("CORE");
  });

  it("BROKEN: first net-negative quarter after a streak ≥ 3", () => {
    expect(stageAt([3, 3, 3, 3, -5])).toBe("BROKEN");
  });

  it("a negative quarter WITHOUT a prior ≥3 streak is not BROKEN", () => {
    expect(stageAt([3, -5])).not.toBe("BROKEN");
  });
});

describe("lifecycle: CROWDED escalation flag", () => {
  it("rides alongside the underlying stage, does not replace it", () => {
    const info = classifyLifecycleAt([2, 2, 2, 2, 2], true, CFG);
    expect(info.stage).toBe("DURABLE");
    expect(info.crowded).toBe(true);
  });
});

describe("lifecycle: historical series + transitions", () => {
  const bps = [3, 3, 3, 3, 3, 0, 0, -6]; // build → plateau(core) → break
  it("is deterministic — same input ⇒ identical series", () => {
    expect(classifyLifecycleSeries(bps)).toEqual(classifyLifecycleSeries(bps));
  });

  it("loops the single classifier over prefixes (stage at q matches classifyLifecycleAt)", () => {
    const series = classifyLifecycleSeries(bps);
    for (let i = 0; i < bps.length; i++) {
      expect(series[i]!.stage).toBe(classifyLifecycleAt(bps.slice(0, i + 1)).stage);
    }
  });

  it("BROKEN fires exactly once per break", () => {
    // build (streak≥3) then two consecutive negative quarters — only the FIRST
    // is BROKEN (the second is preceded by a negative run, not a positive one).
    const series = classifyLifecycleSeries([3, 3, 3, 3, -6, -6]);
    const broken = series.filter((s) => s.stage === "BROKEN");
    expect(broken).toHaveLength(1);
    expect(series[4]!.stage).toBe("BROKEN");
    expect(series[5]!.stage).not.toBe("BROKEN");
  });

  it("emits →CORE and BROKEN as high-significance transitions", () => {
    const series = classifyLifecycleSeries(bps);
    const events = detectTransitions(series);
    const core = events.find((e) => e.transition === "→CORE");
    const broken = events.find((e) => e.transition === "BROKEN");
    expect(core?.significance).toBe(1);
    expect(broken?.significance).toBe(1);
  });

  it("emits a →CROWDED event when breadth first crosses p75", () => {
    const series = classifyLifecycleSeries([2, 2, 2, 2], [false, false, false, true]);
    const events = detectTransitions(series);
    expect(events.some((e) => e.transition === "→CROWDED" && e.significance === 1)).toBe(true);
  });
});
