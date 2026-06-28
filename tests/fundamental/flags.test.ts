import { describe, expect, it } from "vitest";
import { FLAGS, computeFlags, type FlagInputs } from "@/lib/fundamental/flags";

const clean: FlagInputs = {
  netDebtToEbitda: 1,
  fcfTtm: 100,
  interestCoverage: 10,
  dilutedShareGrowthYoy: 0,
  analystCount: 12,
  epsDispersion: 0.1,
  residual6m1m: 0.05,
  workingCapitalQuality: 0,
  persistenceBreadth: 0.8,
  ebitdaMarginInflection: 0.01,
  ebitdaTtm: 200,
  totalEquity: 1000,
  marketCap: 5_000_000_000,
  daysSinceLatestFiscal: 40,
  sector: "Technology",
  validBoxCount: 9,
};

describe("computeFlags", () => {
  it("raises no flags for a clean profile", () => {
    expect(computeFlags(clean)).toEqual([]);
  });

  it("raises leverage / negative-FCF / coverage / distress flags", () => {
    const f = computeFlags({
      ...clean,
      netDebtToEbitda: 6,
      fcfTtm: -10,
      interestCoverage: 0.8,
      ebitdaTtm: -5,
    });
    expect(f).toContain(FLAGS.HIGH_LEVERAGE);
    expect(f).toContain(FLAGS.NEGATIVE_FCF);
    expect(f).toContain(FLAGS.LOW_INTEREST_COVERAGE);
    expect(f).toContain(FLAGS.POSSIBLE_DISTRESS);
  });

  it("flags dilution, low coverage, high dispersion, deteriorating momentum", () => {
    const f = computeFlags({
      ...clean,
      dilutedShareGrowthYoy: 0.1,
      analystCount: 2,
      epsDispersion: 0.9,
      residual6m1m: -0.2,
    });
    expect(f).toContain(FLAGS.EQUITY_DILUTION);
    expect(f).toContain(FLAGS.ESTIMATE_COVERAGE_LOW);
    expect(f).toContain(FLAGS.FORECAST_DISPERSION_HIGH);
    expect(f).toContain(FLAGS.MOMENTUM_DETERIORATING);
  });

  it("flags financial companies / REITs and stale data and microcaps", () => {
    expect(computeFlags({ ...clean, sector: "Financial Services" })).toContain(FLAGS.FINANCIAL_COMPANY);
    expect(computeFlags({ ...clean, sector: "Real Estate" })).toContain(FLAGS.FINANCIAL_COMPANY);
    expect(computeFlags({ ...clean, daysSinceLatestFiscal: 300 })).toContain(FLAGS.STALE_DATA);
    expect(computeFlags({ ...clean, marketCap: 100_000_000 })).toContain(FLAGS.MICROCAP);
  });

  it("flags one-quarter inflection and working-capital boost and insufficient data", () => {
    const f = computeFlags({
      ...clean,
      persistenceBreadth: 0.3,
      ebitdaMarginInflection: 0.05,
      workingCapitalQuality: -0.8,
      validBoxCount: 6,
    });
    expect(f).toContain(FLAGS.ONE_QUARTER_INFLECTION);
    expect(f).toContain(FLAGS.WORKING_CAPITAL_BOOST);
    expect(f).toContain(FLAGS.INSUFFICIENT_DATA);
  });

  it("never raises a flag from a null input", () => {
    const allNull: FlagInputs = {
      netDebtToEbitda: null,
      fcfTtm: null,
      interestCoverage: null,
      dilutedShareGrowthYoy: null,
      analystCount: null,
      epsDispersion: null,
      residual6m1m: null,
      workingCapitalQuality: null,
      persistenceBreadth: null,
      ebitdaMarginInflection: null,
      ebitdaTtm: null,
      totalEquity: null,
      marketCap: null,
      daysSinceLatestFiscal: null,
      sector: null,
      validBoxCount: 9,
    };
    expect(computeFlags(allNull)).toEqual([]);
  });
});
