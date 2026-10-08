import { describe, expect, it } from "vitest";

import { spearman } from "@/lib/revision/backtest";
import {
  cutStats,
  nextPrintOutcome,
  queueOverlap,
  survivorshipNote,
  topKOf,
  topKPrecision,
  type FunnelWeek,
} from "@/lib/revision/funnel-metrics";

/** n names where score and forward return agree perfectly (rank r -> return r/1000). */
function perfectWeek(date: string, n: number): FunnelWeek {
  const score = new Map<string, number>();
  const forward = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    score.set(`T${i}`, i);
    forward.set(`T${i}`, (i - n / 2) / 1000);
  }
  return { date, score, forward };
}

describe("topKOf", () => {
  it("takes the highest scores that also have a printed forward return", () => {
    const w = perfectWeek("2026-01-03", 10);
    w.forward.delete("T9"); // outcome not printed yet
    expect(topKOf(w, 3)).toEqual(["T8", "T7", "T6"]);
  });
  it("takes the lowest scores for the short side", () => {
    expect(topKOf(perfectWeek("2026-01-03", 10), 2, "short")).toEqual(["T0", "T1"]);
  });
});

describe("topKPrecision", () => {
  it("beats the random baseline when the score is informative", () => {
    const weeks = ["2026-01-03", "2026-01-10", "2026-01-17"].map((d) => perfectWeek(d, 100));
    const p = topKPrecision(weeks, 25, { draws: 200, seed: 7 });
    expect(p.weeks).toBe(3);
    expect(p.medianReturn!).toBeGreaterThan(p.randomMedian!);
    expect(p.percentileVsRandom).toBe(1);
    expect(p.hitRate).toBe(1);
    expect(p.randomHitRate!).toBeLessThan(0.7);
  });

  it("lands mid-distribution when the score carries no information", () => {
    // Score is independent of the outcome: shuffle returns by a fixed pattern.
    const weeks: FunnelWeek[] = [];
    for (let k = 0; k < 8; k++) {
      const score = new Map<string, number>();
      const forward = new Map<string, number>();
      for (let i = 0; i < 100; i++) {
        score.set(`T${i}`, i);
        forward.set(`T${i}`, (((i * 37 + k * 11) % 100) - 50) / 1000);
      }
      weeks.push({ date: `2026-01-${String(k + 1).padStart(2, "0")}`, score, forward });
    }
    const p = topKPrecision(weeks, 25, { draws: 300, seed: 11 });
    expect(p.percentileVsRandom!).toBeGreaterThan(0.05);
    expect(p.percentileVsRandom!).toBeLessThan(0.95);
  });

  it("is deterministic for a given seed and reports nothing on a thin grid", () => {
    const weeks = [perfectWeek("2026-01-03", 100)];
    const a = topKPrecision(weeks, 25, { draws: 50, seed: 3 });
    const b = topKPrecision(weeks, 25, { draws: 50, seed: 3 });
    expect(a.randomMedian).toBe(b.randomMedian);

    const thin = topKPrecision([perfectWeek("2026-01-03", 10)], 25, { draws: 10 });
    expect(thin.weeks).toBe(0);
    expect(thin.medianReturn).toBeNull();
  });
});

describe("queueOverlap", () => {
  it("is 1 when the list never moves and 0 when it turns over completely", () => {
    const same = [perfectWeek("2026-01-03", 50), perfectWeek("2026-01-10", 50)];
    expect(queueOverlap(same, 5).meanJaccard).toBe(1);
    expect(queueOverlap(same, 5).meanArrivals).toBe(0);

    const flipped: FunnelWeek = { date: "2026-01-10", score: new Map(), forward: new Map() };
    for (let i = 0; i < 50; i++) {
      flipped.score.set(`T${i}`, -i); // reverse the ranking
      flipped.forward.set(`T${i}`, 0);
    }
    const o = queueOverlap([perfectWeek("2026-01-03", 50), flipped], 5);
    expect(o.meanJaccard).toBe(0);
    expect(o.meanArrivals).toBe(5);
  });
});

describe("cutStats", () => {
  it("reports IC and top-decile share per slice", () => {
    const weeks = ["2026-01-03", "2026-01-10"].map((d) => perfectWeek(d, 100));
    // Even tickers in slice A, odd in B; both are perfectly ordered.
    const cuts = cutStats(weeks, (_d, t) => (Number(t.slice(1)) % 2 === 0 ? "A" : "B"), spearman);
    expect(cuts.map((c) => c.label)).toEqual(["A", "B"]);
    for (const c of cuts) {
      expect(c.meanIC).toBeCloseTo(1, 10);
      expect(c.tickerWeeks).toBe(100);
      expect(c.topDecileShare!).toBeCloseTo(0.1, 2);
    }
  });
  it("skips ticker-weeks with no slice", () => {
    const weeks = [perfectWeek("2026-01-03", 100)];
    const cuts = cutStats(weeks, (_d, t) => (t === "T0" ? "only" : null), spearman);
    expect(cuts).toEqual([{ label: "only", tickerWeeks: 1, meanIC: null, topDecileShare: 0 }]);
  });
});

describe("nextPrintOutcome", () => {
  it("compares the top-k beat / follow-through rate against the universe", () => {
    const weeks = [perfectWeek("2026-01-03", 100)];
    // Top decile beats, everyone else misses.
    const out = nextPrintOutcome(
      weeks,
      10,
      (_d, t) => Number(t.slice(1)) >= 90,
      () => null,
      "long",
    );
    expect(out.surpriseBeatRate).toBe(1);
    expect(out.baseSurpriseBeatRate).toBeCloseTo(0.1, 10);
    expect(out.followThroughRate).toBeNull(); // unknown everywhere
  });
});

describe("survivorshipNote", () => {
  it("counts universe names absent from each grid week", () => {
    const note = survivorshipNote(
      [
        { date: "2026-01-03", present: new Set(["A", "B"]) },
        { date: "2026-01-10", present: new Set(["A"]) },
      ],
      new Set(["A", "B", "C"]),
      42,
    );
    expect(note.missingByDate).toEqual([
      { date: "2026-01-03", missing: 1 },
      { date: "2026-01-10", missing: 2 },
    ]);
    expect(note.meanMissing).toBe(1.5);
    expect(note.droppedNoEntry).toBe(42);
  });
});
