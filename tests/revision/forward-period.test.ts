import { describe, expect, it } from "vitest";
import { extractForwardEps, pickForwardPeriod } from "@/server/services/revision/revision-scoring.service";

const estimatesJson = {
  nextFiscalDate: "2026-12-31",
  annual: [
    { fiscalDate: "2026-12-31", eps: { low: 1.0, avg: 1.5, high: 2.0 } },
    { fiscalDate: "2027-12-31", eps: { low: 1.2, avg: 1.8, high: 2.4 } },
  ],
};

describe("pickForwardPeriod", () => {
  it("selects the period matching nextFiscalDate", () => {
    expect(pickForwardPeriod(estimatesJson)?.fiscalDate).toBe("2026-12-31");
  });
  it("falls back to the last period when nextFiscalDate is absent", () => {
    const j = { annual: estimatesJson.annual };
    expect(pickForwardPeriod(j)?.fiscalDate).toBe("2027-12-31");
  });
  it("is null for missing / malformed json", () => {
    expect(pickForwardPeriod(null)).toBeNull();
    expect(pickForwardPeriod({})).toBeNull();
    expect(pickForwardPeriod({ annual: [] })).toBeNull();
  });
});

describe("extractForwardEps", () => {
  it("returns the forward period's eps low/high (feeds epsDispersion)", () => {
    expect(extractForwardEps(estimatesJson)).toEqual({ low: 1.0, high: 2.0 });
  });
  it("nulls missing fields without throwing", () => {
    expect(extractForwardEps({ nextFiscalDate: "x", annual: [{ fiscalDate: "x" }] })).toEqual({
      low: null,
      high: null,
    });
    expect(extractForwardEps(null)).toEqual({ low: null, high: null });
  });
});
