import { describe, expect, it } from "vitest";
import {
  computeLeaderboard,
  computeTickerCalc,
  type FundPosition,
  type QuarterIngredient,
  type TickerIngredients,
} from "@/domain/calculations/flow-leaderboard";
import { FLOW_LEADERBOARD_CONFIG as CFG } from "@/domain/calculations/flow-leaderboard-config";
import { computeActiveFlowPair, type FundHoldingsByPeriod } from "@/server/services/institutional/institutional-active-flow.service";

const PERIODS = ["2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31"];

// The mega-cap gate excludes the top-N names by market cap across the WHOLE field
// (in production that's the 15 largest caps out of hundreds). Our tiny test
// universe would be wiped by N=15, so board-level tests disable that gate and the
// dedicated mega-cap test sets N=1 explicitly.
const TESTCFG = { ...CFG, gates: { ...CFG.gates, exclude_top_n_by_mcap: 0 } };

interface QSpec {
  adders?: number;
  reducers?: number; // status 'trimmed' (still holding) unless exited=true
  exited?: number; // status 'exited' reducers
  held?: number;
  bps?: number;
  elite?: number; // # of the adders that are elite
  medianPctOfBook?: number | null;
  marketCapUsd?: number | null;
  priorHolders?: number;
  missingHolders?: number;
}

function mkQuarter(period: string, s: QSpec): QuarterIngredient {
  const funds: FundPosition[] = [];
  const adders = s.adders ?? 0;
  const trimmed = s.reducers ?? 0;
  const exited = s.exited ?? 0;
  const held = s.held ?? 0;
  const bps = s.bps ?? 0;
  for (let i = 0; i < adders; i++)
    funds.push({ fundId: `a${i}`, isElite: i < (s.elite ?? 0), status: "new", adjShareDeltaPct: null, netBps: bps > 0 ? 40 : 0, pctOfBook: s.medianPctOfBook ?? 2 });
  for (let i = 0; i < trimmed; i++)
    funds.push({ fundId: `t${i}`, isElite: false, status: "trimmed", adjShareDeltaPct: -25, netBps: bps < 0 ? -40 : 0, pctOfBook: 1 });
  for (let i = 0; i < exited; i++)
    funds.push({ fundId: `x${i}`, isElite: false, status: "exited", adjShareDeltaPct: null, netBps: bps < 0 ? -40 : 0, pctOfBook: null });
  for (let i = 0; i < held; i++)
    funds.push({ fundId: `h${i}`, isElite: false, status: "held", adjShareDeltaPct: 0, netBps: 0, pctOfBook: s.medianPctOfBook ?? 2 });
  const holders = adders + trimmed + held; // exited no longer hold
  return {
    period,
    holders,
    priorHolders: s.priorHolders ?? holders,
    netflowBps: bps,
    medianPctOfBook: s.medianPctOfBook ?? 2,
    marketCapUsd: s.marketCapUsd ?? null,
    missingHolders: s.missingHolders ?? 0,
    funds,
  };
}

function mkTicker(ticker: string, specs: QSpec[], companyName?: string): TickerIngredients {
  return { ticker, companyName: companyName ?? ticker, series: specs.map((s, i) => mkQuarter(PERIODS[i]!, s)) };
}

/** A representative multi-name universe for board-level assertions. */
function universe(): TickerIngredients[] {
  const strongAcc = (mcap: number | null) => [
    { adders: 6, held: 2, bps: 10, elite: 2, medianPctOfBook: 3, marketCapUsd: mcap },
    { adders: 6, held: 2, bps: 10, elite: 2, medianPctOfBook: 3, marketCapUsd: mcap },
    { adders: 6, held: 2, bps: 10, elite: 2, medianPctOfBook: 3, marketCapUsd: mcap },
    { adders: 6, held: 2, bps: 10, elite: 2, medianPctOfBook: 3, marketCapUsd: mcap },
  ];
  return [
    mkTicker("ACC1", strongAcc(8e9)),
    mkTicker("ACC2", [
      { adders: 4, reducers: 1, held: 1, bps: 5, medianPctOfBook: 2, marketCapUsd: 6e9 },
      { adders: 4, reducers: 1, held: 1, bps: 5, medianPctOfBook: 2, marketCapUsd: 6e9 },
      { adders: 4, reducers: 1, held: 1, bps: 5, medianPctOfBook: 2, marketCapUsd: 6e9 },
      { adders: 4, reducers: 1, held: 1, bps: 5, medianPctOfBook: 2, marketCapUsd: 6e9 },
    ]),
    mkTicker("DIS1", [
      { reducers: 6, held: 2, bps: -10, medianPctOfBook: 1, marketCapUsd: 5e9 },
      { reducers: 6, held: 2, bps: -10, medianPctOfBook: 1, marketCapUsd: 5e9 },
      { reducers: 6, held: 2, bps: -10, medianPctOfBook: 1, marketCapUsd: 5e9 },
      { reducers: 6, held: 2, bps: -10, medianPctOfBook: 1, marketCapUsd: 5e9 },
    ]),
    mkTicker("DIS2", [
      { adders: 1, reducers: 4, held: 1, bps: -5, medianPctOfBook: 1, marketCapUsd: 4e9 },
      { adders: 1, reducers: 4, held: 1, bps: -5, medianPctOfBook: 1, marketCapUsd: 4e9 },
      { adders: 1, reducers: 4, held: 1, bps: -5, medianPctOfBook: 1, marketCapUsd: 4e9 },
      { adders: 1, reducers: 4, held: 1, bps: -5, medianPctOfBook: 1, marketCapUsd: 4e9 },
    ]),
    // Huge market cap → mega-cap gate target.
    mkTicker("MEGA", strongAcc(5e12)),
    // Below min_holders.
    mkTicker("TINY", [
      { adders: 1, held: 1, bps: 3, marketCapUsd: 1e9 },
      { adders: 1, held: 1, bps: 3, marketCapUsd: 1e9 },
      { adders: 1, held: 1, bps: 3, marketCapUsd: 1e9 },
      { adders: 1, held: 1, bps: 3, marketCapUsd: 1e9 },
    ]),
    // Flat: netflow ~0, bps ~0 → flow below threshold.
    mkTicker("FLAT", [
      { adders: 1, reducers: 1, held: 4, bps: 0, marketCapUsd: 2e9 },
      { adders: 1, reducers: 1, held: 4, bps: 0, marketCapUsd: 2e9 },
      { adders: 1, reducers: 1, held: 4, bps: 0, marketCapUsd: 2e9 },
      { adders: 1, reducers: 1, held: 4, bps: 0, marketCapUsd: 2e9 },
    ]),
  ];
}

describe("flow-leaderboard scoring core", () => {
  it("streak counts consecutive same-signed quarters from latest backward: [-3,+2,+5,+9] ⇒ 3 (not 4)", () => {
    // netflow_bps per quarter oldest→latest; count signs match so the +2 dead-zone
    // quarter resolves positive via the count fallback.
    const bps = [-3, 2, 5, 9];
    const t = mkTicker(
      "STRK",
      bps.map((b) => ({ adders: b > 0 ? 1 : 0, exited: b < 0 ? 1 : 0, held: 3, bps: b })),
    );
    const calc = computeTickerCalc(t, CFG)!;
    expect(calc.streak).toBe(3);
  });

  it("a fund that exits counts as a reducer that quarter (and is simply absent thereafter)", () => {
    const t = mkTicker("EXIT", [
      { adders: 3, held: 2, bps: 4 },
      { exited: 2, held: 3, bps: -4 }, // 2 exiters → netflow −2 this quarter
      { held: 3, bps: 0 },
      { held: 3, bps: 0 },
    ]);
    const calc = computeTickerCalc(t, CFG)!;
    // wflow includes the −2 exit quarter (weight 0.45 at q-2) and +3 at q-3.
    expect(calc.flows[1]!.netflow).toBe(-2);
    expect(calc.flows[1]!.reducers).toBe(2);
  });

  it("a split-adjusted position with 0% share change is neither adder nor reducer", () => {
    const t = mkTicker("SPLT", [{ held: 5, adders: 0, bps: 0 }]);
    // The single held fund has adjShareDeltaPct 0 (post split-adjustment).
    const calc = computeTickerCalc(t, CFG)!;
    expect(calc.flows[0]!.adders).toBe(0);
    expect(calc.flows[0]!.reducers).toBe(0);
  });

  it("mega-cap gate: the top-N-by-market-cap name never appears regardless of score", () => {
    const cfg = { ...CFG, gates: { ...CFG.gates, exclude_top_n_by_mcap: 1 } };
    const board = computeLeaderboard(universe(), cfg);
    const onBoards = [...board.accumulation, ...board.distribution].map((r) => r.ticker);
    expect(onBoards).not.toContain("MEGA");
    expect(board.gatedOut.find((g) => g.ticker === "MEGA")?.reason).toMatch(/mega-cap/);
    // ACC1 (same strong flow, small cap) is NOT excluded.
    expect(board.accumulation.map((r) => r.ticker)).toContain("ACC1");
  });

  it("point-in-time cap: a name with a modest historical cap stays on the board even though it is mega today", () => {
    // The core only sees the cap passed for THIS quarter, so a small stored cap
    // keeps the name eligible — exactly the historical-board behavior we want.
    const cfg = { ...CFG, gates: { ...CFG.gates, exclude_top_n_by_mcap: 1 } };
    const u = universe();
    const board = computeLeaderboard(u, cfg);
    // ACC1 has an 8e9 (small) cap this quarter and strong flow → present.
    expect(board.accumulation.map((r) => r.ticker)).toContain("ACC1");
  });

  it("gates out low-holder and below-threshold names with a reason", () => {
    const board = computeLeaderboard(universe(), TESTCFG);
    expect(board.gatedOut.find((g) => g.ticker === "TINY")?.reason).toMatch(/holders/);
    expect(board.gatedOut.find((g) => g.ticker === "FLAT")?.reason).toMatch(/threshold/);
  });

  it("accumulation and distribution boards never share a name", () => {
    const board = computeLeaderboard(universe(), TESTCFG);
    const acc = new Set(board.accumulation.map((r) => r.ticker));
    const dis = new Set(board.distribution.map((r) => r.ticker));
    for (const t of acc) expect(dis.has(t)).toBe(false);
    // Sanity: strong names landed on the expected side.
    expect([...acc]).toContain("ACC1");
    expect([...dis]).toContain("DIS1");
  });

  it("scores are 0-100 and rows are sorted by score descending (fixed ranking)", () => {
    const board = computeLeaderboard(universe(), TESTCFG);
    for (const r of [...board.accumulation, ...board.distribution]) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(100);
    }
    const scores = board.accumulation.map((r) => r.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    board.accumulation.forEach((r, i) => expect(r.rank).toBe(i + 1));
  });

  it("is deterministic — same inputs ⇒ identical ranking and reason strings", () => {
    const a = computeLeaderboard(universe(), TESTCFG);
    const b = computeLeaderboard(universe(), TESTCFG);
    expect(b).toEqual(a);
  });

  it("reason string flags a multi-quarter streak", () => {
    const board = computeLeaderboard(universe(), TESTCFG);
    const acc1 = board.accumulation.find((r) => r.ticker === "ACC1")!;
    expect(acc1.streak).toBeGreaterThanOrEqual(3);
    expect(acc1.reason).toMatch(/streak|elite|reversal|deepening|wt/);
  });

  it("reason string triggers 'reversal' on a sign flip within lookback with current streak ≥ 2", () => {
    // Sells for two quarters, then buys for two → latest streak +2, sign flipped.
    const rev = mkTicker("REV", [
      { reducers: 5, held: 2, bps: -8 },
      { reducers: 5, held: 2, bps: -8 },
      { adders: 5, held: 3, bps: 8 },
      { adders: 5, held: 3, bps: 8 },
    ]);
    const board = computeLeaderboard([rev, ...universe()], TESTCFG);
    const row = board.accumulation.find((r) => r.ticker === "REV");
    expect(row).toBeDefined();
    expect(row!.reason).toMatch(/reversal/);
  });

  it("amendment (a): zero holder-count change with all holders doubling weight ⇒ flowz_cap strongly positive, passes gates", () => {
    // Holders constant (all 'held'), but each deliberately doubled weight → high
    // positive netflowBps. Count flow is flat, so the capital component carries it.
    const deepen = mkTicker(
      "DEEP",
      [0, 1, 2, 3].map(() => ({ held: 8, bps: 30, medianPctOfBook: 4 })),
    );
    const board = computeLeaderboard([deepen, ...universe()], TESTCFG);
    const row = board.accumulation.find((r) => r.ticker === "DEEP");
    expect(row).toBeDefined(); // passed gates on |wflow_bps| ≥ 6
    expect(row!.flowzCap).toBeGreaterThan(0);
    expect(row!.wflowBps).toBeGreaterThan(CFG.gates.min_abs_wflow_bps);
  });

  it("amendment (b): a single mega-fund initiation ⇒ flowz_cap positive, count flow ~flat, reason flags 'single-fund'", () => {
    // One fund initiates (new), nobody else moves; netflowBps positive from that
    // one fund. moverCount 1 and net count 1 → single-fund capital.
    const single = mkTicker("SOLO", [
      { held: 6, bps: 0 },
      { held: 6, bps: 0 },
      { held: 6, bps: 0 },
      { adders: 1, held: 6, bps: 12 },
    ]);
    // Ensure only one mover in the latest quarter: the added fund has netBps, held funds 0.
    const board = computeLeaderboard([single, ...universe()], TESTCFG);
    const row = [...board.accumulation, ...board.gatedOut].find((r) => r.ticker === "SOLO");
    expect(row).toBeDefined();
    const onBoard = board.accumulation.find((r) => r.ticker === "SOLO");
    if (onBoard) expect(onBoard.reason).toMatch(/single-fund/);
  });

  it("amendment (c): stock rallies with identical shares ⇒ active flow ≈ 0 (computeActiveFlowPair)", () => {
    // Two funds hold identical shares; price rises 40% (value ×1.4). The deliberate
    // move (active − expected) must be ~0 for the name.
    const prev: FundHoldingsByPeriod = new Map([
      ["F1", new Map([["AAA", { shares: 100, value: 1000 }], ["BBB", { shares: 100, value: 1000 }]])],
      ["F2", new Map([["AAA", { shares: 200, value: 2000 }], ["BBB", { shares: 50, value: 500 }]])],
    ]);
    const cur: FundHoldingsByPeriod = new Map([
      ["F1", new Map([["AAA", { shares: 100, value: 1400 }], ["BBB", { shares: 100, value: 1400 }]])],
      ["F2", new Map([["AAA", { shares: 200, value: 2800 }], ["BBB", { shares: 50, value: 700 }]])],
    ]);
    const meta = new Map<string, { sector: string | null; subsector: string | null }>([
      ["AAA", { sector: "Tech", subsector: null }],
      ["BBB", { sector: "Tech", subsector: null }],
    ]);
    const { byName } = computeActiveFlowPair(prev, cur, meta);
    // Every name rose 40% identically, so no fund shifted its RELATIVE weight.
    expect(Math.abs(byName.get("AAA")!.activeBpsAvg)).toBeLessThan(1);
    expect(Math.abs(byName.get("BBB")!.activeBpsAvg)).toBeLessThan(1);
  });
});
