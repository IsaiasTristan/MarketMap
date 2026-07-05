import { describe, expect, it } from "vitest";
import {
  computeExitLeadAttribution,
  isQualifiedTrimForProvenance,
  type QualifiedTrim,
  type ExitClusterOccurrence,
} from "@/domain/calculations/exit-lead-attribution";
import { FUNDS_ATTRIBUTION_CONFIG as CFG } from "@/domain/calculations/funds-attribution-config";

const trim = (fundId: string, ticker: string, quarter: number, extra: Partial<QualifiedTrim> = {}): QualifiedTrim => ({
  fundId,
  ticker,
  quarter,
  isStasisBreak: false,
  ...extra,
});
const cluster = (ticker: string, quarter: number): ExitClusterOccurrence => ({ ticker, quarter });
const outcome = (r: ReturnType<typeof computeExitLeadAttribution>, fundId: string, ticker: string, quarter: number) =>
  r.outcomes.find((o) => o.fundId === fundId && o.ticker === ticker && o.quarter === quarter)!;
const fund = (r: ReturnType<typeof computeExitLeadAttribution>, fundId: string) => r.funds.find((f) => f.fundId === fundId);

describe("isQualifiedTrimForProvenance — materiality floor (reuse sizing framework)", () => {
  it("rejects a 0.4%-position exit at a fund whose median position is ~1% (sizing 0.4x < 0.5x)", () => {
    // Full exit, but the position was a sub-median starter → never qualifies.
    expect(isQualifiedTrimForProvenance(0.4, 1.0, 100, true, CFG)).toBe(false);
  });
  it("accepts a full exit of a material, qualified-size position (0.8% at a 1% median → sizing 0.8x)", () => {
    expect(isQualifiedTrimForProvenance(0.8, 1.0, 100, true, CFG)).toBe(true);
  });
  it("accepts a >=25% share reduction of a qualified-size position", () => {
    expect(isQualifiedTrimForProvenance(1.0, 1.0, 30, false, CFG)).toBe(true); // 30% reduction
  });
  it("rejects a small (<25%) trim of an otherwise-material position", () => {
    expect(isQualifiedTrimForProvenance(1.0, 1.0, 10, false, CFG)).toBe(false); // only 10% reduction, not exited
  });
  it("rejects a sub-25bps position regardless of reduction", () => {
    expect(isQualifiedTrimForProvenance(0.1, 0.1, 100, true, CFG)).toBe(false); // 10bps < min_entry_bps
  });
});

describe("computeExitLeadAttribution — episode classification", () => {
  it("a trim followed by a cluster inside the window => exit-led with correct lead", () => {
    const r = computeExitLeadAttribution([trim("F0", "T", 0)], [cluster("T", 2)], CFG, 3);
    const o = outcome(r, "F0", "T", 0);
    expect(o.status).toBe("exit_led");
    expect(o.clusterQuarter).toBe(2);
    expect(o.lead).toBe(2);
    expect(fund(r, "F0")!.exitLeadRate).toBe(1);
  });

  it("a cluster at window+1 (outside the window) => not led", () => {
    const r = computeExitLeadAttribution([trim("F0", "T", 0)], [cluster("T", 4)], CFG, 5);
    expect(outcome(r, "F0", "T", 0).status).toBe("not_led");
    expect(fund(r, "F0")!.exitLeadRate).toBe(0);
  });

  it("a same-quarter cluster does NOT count (the lead must precede the crowd)", () => {
    const r = computeExitLeadAttribution([trim("F0", "T", 0)], [cluster("T", 0)], CFG, 4);
    expect(outcome(r, "F0", "T", 0).status).toBe("not_led");
  });

  it("pending: a trim younger than the window with no cluster yet is excluded from the rate", () => {
    const r = computeExitLeadAttribution([trim("F0", "T", 2)], [], CFG, 3);
    expect(outcome(r, "F0", "T", 2).status).toBe("pending");
    expect(fund(r, "F0")!.n).toBe(0);
    expect(fund(r, "F0")!.exitLeadRate).toBeNull();
  });

  it("no-lookahead: a cluster forming after asOf is invisible", () => {
    const trims = [trim("F0", "T", 0)];
    const clusters = [cluster("T", 2)];
    // as-of q1: window not elapsed and no cluster visible yet → pending.
    expect(outcome(computeExitLeadAttribution(trims, clusters, CFG, 1), "F0", "T", 0).status).toBe("pending");
    // as-of q3: cluster at q2 is inside the window → exit-led.
    expect(outcome(computeExitLeadAttribution(trims, clusters, CFG, 3), "F0", "T", 0).status).toBe("exit_led");
  });

  it("tags a stasis-break episode and counts it in stasisLed", () => {
    const r = computeExitLeadAttribution([trim("F0", "T", 0, { isStasisBreak: true })], [cluster("T", 1)], CFG, 3);
    expect(outcome(r, "F0", "T", 0).isStasisBreak).toBe(true);
    expect(fund(r, "F0")!.stasisLed).toBe(1);
    expect(fund(r, "F0")!.led).toBe(1);
  });

  it("is deterministic regardless of input order", () => {
    const t = [trim("F1", "B", 1), trim("F0", "A", 0)];
    const c = [cluster("A", 2), cluster("B", 3)];
    expect(computeExitLeadAttribution(t, c, CFG, 4)).toEqual(computeExitLeadAttribution([...t].reverse(), [...c].reverse(), CFG, 4));
  });
});
