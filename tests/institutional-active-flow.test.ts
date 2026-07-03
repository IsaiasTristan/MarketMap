import { describe, expect, it } from "vitest";
import {
  computeActiveFlowPair,
  netDiffusionPct,
  type FundHoldingsByPeriod,
  type SectorMeta,
} from "@/server/services/institutional/institutional-active-flow.service";
import { classifyTrajectory } from "@/server/services/institutional/institutional-aggregate.service";

// ── fixture helpers ──────────────────────────────────────────────────────────
/** Build a holdings map from { fundId: { ticker: [shares, value] } }. */
function holdings(spec: Record<string, Record<string, [number, number]>>): FundHoldingsByPeriod {
  const m: FundHoldingsByPeriod = new Map();
  for (const [fund, hs] of Object.entries(spec)) {
    const inner = new Map<string, { shares: number; value: number }>();
    for (const [ticker, [shares, value]] of Object.entries(hs)) inner.set(ticker, { shares, value });
    m.set(fund, inner);
  }
  return m;
}
const meta = (spec: Record<string, [string | null, string | null]>): SectorMeta => {
  const m = new Map<string, { sector: string | null; subsector: string | null }>();
  for (const [t, [sector, subsector]] of Object.entries(spec)) m.set(t, { sector, subsector });
  return m;
};

describe("computeActiveFlowPair", () => {
  it("(a) a pure price rally with no trades shows ~0 active move", () => {
    // AAA doubles in price, BBB flat; shares unchanged (nobody traded).
    const prev = holdings({ F1: { AAA: [100, 1000], BBB: [50, 1000] } });
    const cur = holdings({ F1: { AAA: [100, 2000], BBB: [50, 1000] } });
    const m = meta({ AAA: ["Tech", "Semis"], BBB: ["Health", "Pharma"] });
    const { byName, byGroup } = computeActiveFlowPair(prev, cur, m);

    expect(byName.get("AAA")!.activeBpsAvg).toBeCloseTo(0, 6);
    expect(byName.get("BBB")!.activeBpsAvg).toBeCloseTo(0, 6);
    expect(byGroup.get("SECTOR|Tech")!.activeBpsAvg).toBeCloseTo(0, 6);
    // No deliberate move → within the ε dead-band → nobody counted in/out.
    const tech = byGroup.get("SECTOR|Tech")!;
    expect(tech.fundsIn).toBe(0);
    expect(tech.fundsOut).toBe(0);
    expect(tech.fundsParticipating).toBe(1);
    expect(tech.fundsEvaluated).toBe(1);
  });

  it("(b) a fund rotating Tech→Health is negative in Tech, positive in Health, and conserves", () => {
    // Prices flat at 10; sell half of TECH, buy more HLTH.
    const prev = holdings({ F1: { TECH: [100, 1000], HLTH: [50, 500] } });
    const cur = holdings({ F1: { TECH: [50, 500], HLTH: [150, 1500] } });
    const m = meta({ TECH: ["Tech", "Semis"], HLTH: ["Health", "Pharma"] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m);

    const tech = byGroup.get("SECTOR|Tech")!;
    const hlth = byGroup.get("SECTOR|Health")!;
    expect(tech.activeBpsAvg).toBeLessThan(-1000);
    expect(hlth.activeBpsAvg).toBeGreaterThan(1000);
    expect(tech.fundsOut).toBe(1);
    expect(hlth.fundsIn).toBe(1);
    // Per-fund conservation: deliberate moves across buckets sum to ~0.
    expect(tech.activeBpsAvg + hlth.activeBpsAvg).toBeCloseTo(0, 2);
  });

  it("(d) diffusion resists a whale that dominates the dollar flow", () => {
    // Two small funds rotate INTO Health; one whale dumps Health. Prices flat 10.
    const prev = holdings({
      S1: { TECH: [100, 1000], HLTH: [10, 100] },
      S2: { TECH: [100, 1000], HLTH: [10, 100] },
      WHALE: { TECH: [1000, 10000], HLTH: [5000, 50000] },
    });
    const cur = holdings({
      S1: { TECH: [90, 900], HLTH: [25, 250] },
      S2: { TECH: [88, 880], HLTH: [30, 300] },
      WHALE: { TECH: [2000, 20000], HLTH: [2000, 20000] },
    });
    const m = meta({ TECH: ["Tech", "Semis"], HLTH: ["Health", "Pharma"] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m);
    const hlth = byGroup.get("SECTOR|Health")!;

    // Bar (diffusion) sees the broad migration IN: 2 of 3 funds rotated in.
    expect(hlth.fundsIn).toBe(2);
    expect(hlth.fundsOut).toBe(1);
    expect(hlth.fundsParticipating).toBe(3);
    expect(netDiffusionPct(hlth)).toBeCloseTo(33.33, 1);
    // …while the $ flow is dominated by the whale's exit (negative).
    expect(hlth.dollarNetFlow).toBeLessThan(0);
  });

  it("dollar net flow is fully positive for a new buy, fully negative for a full exit", () => {
    const prev = holdings({ F1: { OLD: [100, 1000] } });
    const cur = holdings({ F1: { NEW: [100, 2000] } });
    const m = meta({ OLD: ["Tech", null], NEW: ["Health", null] });
    const { byName } = computeActiveFlowPair(prev, cur, m);

    expect(byName.get("NEW")!.dollarNetFlow).toBeCloseTo(2000, 2); // new position, full value
    expect(byName.get("OLD")!.dollarNetFlow).toBeCloseTo(-1000, 2); // exited at implied price 10
  });

  it("counts only funds present in both quarters (skips single-quarter funds)", () => {
    // F1 present both quarters; F2 only appears at t → not evaluated.
    const prev = holdings({ F1: { TECH: [100, 1000], HLTH: [50, 500] } });
    const cur = holdings({ F1: { TECH: [50, 500], HLTH: [150, 1500] }, F2: { HLTH: [10, 100] } });
    const m = meta({ TECH: ["Tech", null], HLTH: ["Health", null] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m);
    expect(byGroup.get("SECTOR|Health")!.fundsEvaluated).toBe(1);
  });
});

describe("netDiffusionPct", () => {
  it("is signed and bounded, 0 when nobody participates", () => {
    expect(netDiffusionPct({ fundsIn: 6, fundsOut: 2, fundsParticipating: 10 })).toBe(40);
    expect(netDiffusionPct({ fundsIn: 0, fundsOut: 8, fundsParticipating: 8 })).toBe(-100);
    expect(netDiffusionPct({ fundsIn: 0, fundsOut: 0, fundsParticipating: 0 })).toBe(0);
  });
});

describe("classifyTrajectory (scale-free bps cumsum)", () => {
  const cumsum = (deltas: number[]): number[] => {
    let c = 0;
    return [0, ...deltas.map((d) => (c += d))];
  };

  it("labels a steady build 'durable'", () => {
    expect(classifyTrajectory(cumsum([5, 5, 5, 5, 5, 5, 5]))).toBe("durable");
  });

  it("labels a build whose late half rises faster 'accelerating'", () => {
    expect(classifyTrajectory(cumsum([1, 1, 1, 5, 10, 20]))).toBe("accelerating");
  });

  it("labels a flat series with one late jump 'spike'", () => {
    expect(classifyTrajectory(cumsum([0, 0, 0, 0, 0, 40]))).toBe("spike");
  });

  it("labels rebalancing dust below the bps noise floor 'choppy'", () => {
    expect(classifyTrajectory(cumsum([0.5, 0.5, -0.5, 0.5, -0.5]))).toBe("choppy");
  });

  it("labels a net-declining series 'choppy'", () => {
    expect(classifyTrajectory(cumsum([-5, -5, -5]))).toBe("choppy");
  });

  it("returns null for fewer than 3 points", () => {
    expect(classifyTrajectory([1, 2])).toBeNull();
  });

  it("is scale-invariant above the noise floor (×1000 → same label)", () => {
    const small = cumsum([5, 5, 5, 5, 5, 5, 5]);
    const big = small.map((v) => v * 1000);
    expect(classifyTrajectory(big)).toBe(classifyTrajectory(small));
    expect(classifyTrajectory(big)).toBe("durable");
  });
});
