import { describe, expect, it } from "vitest";
import { securityHorizonMetrics } from "@/domain/calculations/security-metrics";
import type { DateClose } from "@/domain/calculations/alignment";

/** Build a DateClose series whose daily returns are exactly `returns`. */
function seriesFromReturns(returns: number[], p0 = 100): DateClose[] {
  const out: DateClose[] = [{ date: isoDay(0), adjClose: p0 }];
  let p = p0;
  returns.forEach((r, i) => {
    p = p * (1 + r);
    out.push({ date: isoDay(i + 1), adjClose: p });
  });
  return out;
}

function isoDay(i: number): string {
  const d = new Date(Date.UTC(2024, 0, 1) + i * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** Sample std (Bessel) of an alternating ±v sequence of length n (mean 0). */
function altStd(v: number, n: number): number {
  return Math.sqrt((n * v * v) / (n - 1));
}

describe("securityHorizonMetrics returnZ / zDenom", () => {
  it("D1 z = last return / sample std of the pre-window returns", () => {
    // 98 calm alternating ±1% returns, then one +10% day (99 returns total).
    const pre = Array.from({ length: 98 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const m = securityHorizonMetrics(seriesFromReturns([...pre, 0.1]), null, 0);

    const expectedStd = altStd(0.01, 98); // √1 scaling for D1
    expect(m.D1.zDenom).toBeCloseTo(expectedStd, 10);
    expect(m.D1.return).toBeCloseTo(0.1, 10);
    expect(m.D1.returnZ).toBeCloseTo(0.1 / expectedStd, 8);
  });

  it("scales the denominator by √N for multi-day horizons", () => {
    const pre = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const tail = [0.02, 0.02, 0.02, 0.02, 0.02];
    const m = securityHorizonMetrics(seriesFromReturns([...pre, ...tail]), null, 0);

    const expectedDenom = altStd(0.01, 200) * Math.sqrt(5);
    expect(m.D5.zDenom).toBeCloseTo(expectedDenom, 10);
    expect(m.D5.return).toBeCloseTo(1.02 ** 5 - 1, 10);
    expect(m.D5.returnZ).toBeCloseTo((1.02 ** 5 - 1) / expectedDenom, 8);
  });

  it("excludes the horizon window from the σ estimate", () => {
    // Same 200-obs pre-window; wildly different last 5 days must not move
    // the D5 denominator (the move never deflates its own z-score).
    const pre = Array.from({ length: 200 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const calm = securityHorizonMetrics(
      seriesFromReturns([...pre, 0.001, 0.001, 0.001, 0.001, 0.001]),
      null,
      0,
    );
    const wild = securityHorizonMetrics(
      seriesFromReturns([...pre, 0.3, -0.25, 0.4, -0.2, 0.35]),
      null,
      0,
    );
    expect(wild.D5.zDenom).toBeCloseTo(calm.D5.zDenom as number, 12);
  });

  it("returns null under the minimum-observation floor", () => {
    // 29 daily returns → D1 pre-window has 28 obs (< 40 floor).
    const rets = Array.from({ length: 29 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const m = securityHorizonMetrics(seriesFromReturns(rets), null, 0);
    expect(m.D1.zDenom).toBeNull();
    expect(m.D1.returnZ).toBeNull();
  });

  it("caps the σ window at the most recent 252 pre-window returns", () => {
    // 67 wild returns followed by 252 calm ones, then the scored day: the D1
    // pre-window (last 252 before the final bar) is entirely calm, so the
    // early wild stretch must not touch the denominator.
    const wild = Array.from({ length: 67 }, (_, i) => (i % 2 === 0 ? 0.2 : -0.2));
    const calm = Array.from({ length: 252 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const m = securityHorizonMetrics(
      seriesFromReturns([...wild, ...calm, 0.05]),
      null,
      0,
    );
    expect(m.D1.zDenom).toBeCloseTo(altStd(0.01, 252), 10);
    expect(m.D1.returnZ).toBeCloseTo(0.05 / altStd(0.01, 252), 8);
  });

  it("returns null zDenom when the pre-window has zero variance", () => {
    const flat = Array.from({ length: 60 }, () => 0);
    const m = securityHorizonMetrics(seriesFromReturns([...flat, 0.05]), null, 0);
    expect(m.D1.zDenom).toBeNull();
    expect(m.D1.returnZ).toBeNull();
  });
});
