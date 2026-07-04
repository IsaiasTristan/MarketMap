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

// Per-level materiality floors matching FLOW_LEADERBOARD_CONFIG.min_vote_bps
// (stock → name). A move must clear the floor to cast a rotation vote.
const FLOORS = { name: 2, sector: 5, subsector: 3 };

describe("diffusion vote materiality floor (Part 1)", () => {
  it("t1: a rally (sector +15%, book +8%) with identical shares casts no votes", () => {
    // Nobody trades. TECH rallies +15%, the rest of the book +1%, so each book is
    // up ~8% overall — but the price-adjusted counterfactual removes all of it.
    const mk = (fund: string) =>
      holdings({ [fund]: { TECH: [100, 1000], REST: [100, 1000] } }).get(fund)!;
    const prev: FundHoldingsByPeriod = new Map([["A", mk("A")], ["B", mk("B")]]);
    const cur: FundHoldingsByPeriod = new Map();
    for (const f of ["A", "B"]) {
      const inner = new Map<string, { shares: number; value: number }>();
      inner.set("TECH", { shares: 100, value: 1150 }); // +15% price, same shares
      inner.set("REST", { shares: 100, value: 1010 }); // +1% price, same shares
      cur.set(f, inner);
    }
    const m = meta({ TECH: ["Tech", "Semis"], REST: ["Health", "Pharma"] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m, FLOORS);
    const tech = byGroup.get("SECTOR|Tech")!;
    expect(tech.fundsIn).toBe(0);
    expect(tech.fundsOut).toBe(0);
    expect(tech.activeBpsAvg).toBeCloseTo(0, 4);
    expect(tech.dollarNetFlow).toBeCloseTo(0, 2);
    expect(netDiffusionPct(tech)).toBe(0);
  });

  it("t2: a sub-floor deliberate move (+1 bp, and +3 bps) casts no vote; above-floor does", () => {
    // Flat prices at 10; shift a sliver of book from HLTH into TECH. With this
    // construction a shift of x shares yields a TECH sector move of ~5x bps.
    const move = (x: number): { prev: FundHoldingsByPeriod; cur: FundHoldingsByPeriod } => {
      const prev = holdings({ F1: { TECH: [1000, 10000], HLTH: [1000, 10000] } });
      const cur = holdings({ F1: { TECH: [1000 + x, (1000 + x) * 10], HLTH: [1000 - x, (1000 - x) * 10] } });
      return { prev, cur };
    };
    const m = meta({ TECH: ["Tech", null], HLTH: ["Health", null] });

    // +1 bp (x = 0.2): below every floor → no vote (matches spec wording).
    const oneBp = move(0.2);
    const g1 = computeActiveFlowPair(oneBp.prev, oneBp.cur, m, FLOORS).byGroup.get("SECTOR|Tech")!;
    expect(g1.fundsIn).toBe(0);
    expect(g1.fundsOut).toBe(0);

    // +3 bps (x = 0.6): below the sector floor of 5 → no vote under the new floor,
    // but WOULD have voted in under the legacy 1 bp dead-band (fails old code).
    const threeBp = move(0.6);
    const gNew = computeActiveFlowPair(threeBp.prev, threeBp.cur, m, FLOORS).byGroup.get("SECTOR|Tech")!;
    expect(gNew.fundsIn).toBe(0);
    const gLegacy = computeActiveFlowPair(threeBp.prev, threeBp.cur, m, { name: 1, sector: 1, subsector: 1 }).byGroup.get("SECTOR|Tech")!;
    expect(gLegacy.fundsIn).toBe(1);

    // +2 bps above the floor (x = 1.4 → ~7 bps): clears the sector floor → votes in.
    const aboveFloor = move(1.4);
    const gAbove = computeActiveFlowPair(aboveFloor.prev, aboveFloor.cur, m, FLOORS).byGroup.get("SECTOR|Tech")!;
    expect(gAbove.fundsIn).toBe(1);
  });

  it("t3: a genuine A→B rotation votes out of A and into B, with matching dollar signs", () => {
    // Flat prices at 10; sell half of TECH, pile into HLTH.
    const prev = holdings({ F1: { TECH: [100, 1000], HLTH: [50, 500] } });
    const cur = holdings({ F1: { TECH: [50, 500], HLTH: [150, 1500] } });
    const m = meta({ TECH: ["Tech", null], HLTH: ["Health", null] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m, FLOORS);
    const tech = byGroup.get("SECTOR|Tech")!;
    const hlth = byGroup.get("SECTOR|Health")!;
    expect(tech.fundsOut).toBe(1);
    expect(tech.fundsIn).toBe(0);
    expect(hlth.fundsIn).toBe(1);
    expect(hlth.fundsOut).toBe(0);
    // Dollar signs match the vote direction.
    expect(tech.dollarNetFlow).toBeLessThan(0);
    expect(hlth.dollarNetFlow).toBeGreaterThan(0);
  });

  it("t4: 10 small adds vs 1 whale trim → positive diffusion but negative dollars (divergence, not a bug)", () => {
    // Flat prices at 10. Sector ENERGY: 10 small funds each nudge into ENE
    // (well above the floor); one whale sells a huge ENE stake into OTH.
    const prev: FundHoldingsByPeriod = new Map();
    const cur: FundHoldingsByPeriod = new Map();
    for (let i = 0; i < 10; i++) {
      const f = `S${i}`;
      const p = new Map<string, { shares: number; value: number }>();
      p.set("ENE", { shares: 10, value: 100 });
      p.set("OTH", { shares: 1000, value: 10000 });
      prev.set(f, p);
      const c = new Map<string, { shares: number; value: number }>();
      c.set("ENE", { shares: 12, value: 120 }); // ~+20 bps sector move
      c.set("OTH", { shares: 998, value: 9980 });
      cur.set(f, c);
    }
    // Whale: sells most of a giant ENE position into OTH → big negative $.
    const wp = new Map<string, { shares: number; value: number }>();
    wp.set("ENE", { shares: 220_000_000, value: 2_200_000_000 });
    wp.set("OTH", { shares: 220_000_000, value: 2_200_000_000 });
    prev.set("WHALE", wp);
    const wc = new Map<string, { shares: number; value: number }>();
    wc.set("ENE", { shares: 20_000_000, value: 200_000_000 });
    wc.set("OTH", { shares: 420_000_000, value: 4_200_000_000 });
    cur.set("WHALE", wc);

    const m = meta({ ENE: ["Energy", "Oil"], OTH: ["Materials", "Metals"] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m, FLOORS);
    const ene = byGroup.get("SECTOR|Energy")!;
    expect(ene.fundsIn).toBe(10);
    expect(ene.fundsOut).toBe(1); // the whale
    expect(ene.fundsParticipating).toBe(11);
    expect(netDiffusionPct(ene)).toBeGreaterThan(0); // breadth says accumulation
    expect(ene.dollarNetFlow).toBeLessThan(0); // dollars say distribution (whale)
  });

  it("t5: a fund raising cash casts NO vote in the sectors it held flat (root-cause fix)", () => {
    // Flat prices at 10. F1 sells its entire SELL position (to cash, which 13F
    // does not track) and leaves HOLD untouched. The equity book shrinks, so the
    // weight of HOLD mechanically rises — but no shares were traded in HOLD, so
    // the net-$-traded vote must record nothing there.
    const prev = holdings({ F1: { SELL: [100, 1000], HOLD: [100, 1000] } });
    const cur = holdings({ F1: { HOLD: [100, 1000] } });
    const m = meta({ SELL: ["Energy", null], HOLD: ["Tech", null] });
    const { byGroup } = computeActiveFlowPair(prev, cur, m, FLOORS);

    const hold = byGroup.get("SECTOR|Tech")!;
    expect(hold.fundsIn).toBe(0); // NOT painted green by the book shrinking
    expect(hold.fundsOut).toBe(0);
    expect(hold.dollarNetFlow).toBeCloseTo(0, 2); // no shares traded
    // The weight-change basis WOULD have voted in: HOLD's active weight jumps from
    // 50% to 100% of the shrunken book (documents the artifact we no longer use).
    expect(hold.activeBpsAvg).toBeGreaterThan(1000);

    const sell = byGroup.get("SECTOR|Energy")!;
    expect(sell.fundsOut).toBe(1); // the actual trade is captured
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
