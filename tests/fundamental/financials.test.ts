import { describe, expect, it } from "vitest";
import {
  actualLabel,
  aggregateAnnual,
  attachIncomeSpark,
  attachSparkByKey,
  buildMetricRows,
  buildMonthMap,
  buildStatement,
  estimateLabel,
  pickUnit,
  SPARK_TRAIL_QUARTERS,
  toQuarterlyRunRate,
  type FaColumnInput,
  type FaColumnMetrics,
  type FaColumnValuation,
  type FaPeriodInput,
} from "@/lib/fundamental/financials";
import {
  formatGrowthPct,
  formatMarginPct,
  formatMultiple,
  formatPerShare,
  formatStatement,
} from "@/lib/fundamental/format-statement";

function q(fiscalDate: string, fiscalYear: number, scale: number): FaPeriodInput {
  return {
    fiscalDate,
    fiscalYear,
    fiscalLabel: "Q1",
    revenue: 100 * scale,
    grossProfit: 40 * scale,
    operatingIncome: 20 * scale,
    ebitda: 25 * scale, // operatingIncome + D&A
    netIncome: 10 * scale,
    operatingCashFlow: 22 * scale,
    capex: -5 * scale,
    freeCashFlow: 17 * scale, // OCF + capex
    totalDebt: 200,
    cash: 50,
    totalAssets: 500,
    totalEquity: 250,
    preferredEquity: 10,
    minorityInterest: 5,
    sharesDiluted: 100,
    roic: 0.15,
    netDebtToEbitda: 1.5,
    marketCap: 1000,
    enterpriseValue: 1165,
  };
}

function periodCol(p: FaPeriodInput): FaColumnInput {
  return { kind: "period", label: p.fiscalDate, fiscalDate: p.fiscalDate, data: p };
}

describe("aggregateAnnual", () => {
  it("sums flow items over the 4 fiscal quarters and takes year-end balances", () => {
    const quarters = [
      q("2023-03-31", 2023, 1),
      q("2023-06-30", 2023, 1),
      q("2023-09-30", 2023, 1),
      q("2023-12-31", 2023, 1),
    ];
    const annual = aggregateAnnual(quarters);
    expect(annual).toHaveLength(1);
    const fy = annual[0]!;
    expect(fy.revenue).toBe(400); // 4 x 100
    expect(fy.freeCashFlow).toBe(68); // 4 x 17
    expect(fy.capex).toBe(-20); // 4 x -5
    // balance items = fiscal-year-end (latest) quarter, not summed
    expect(fy.totalDebt).toBe(200);
    expect(fy.cash).toBe(50);
    expect(fy.marketCap).toBe(1000);
    expect(fy.fiscalDate).toBe("2023-12-31");
  });

  it("drops incomplete fiscal years (fewer than 4 quarters)", () => {
    const quarters = [q("2024-03-31", 2024, 1), q("2024-06-30", 2024, 1)];
    expect(aggregateAnnual(quarters)).toHaveLength(0);
  });
});

describe("buildStatement", () => {
  const cols = [periodCol(q("2022-12-31", 2022, 1)), periodCol(q("2023-12-31", 2023, 2))];
  const stmt = buildStatement(cols, "annual");

  it("computes margins as line / revenue in the same column", () => {
    const gross = stmt.income.find((r) => r.key === "grossProfit")!;
    expect(gross.sub?.kind).toBe("margin");
    expect(gross.sub?.values[0]).toBeCloseTo(0.4, 10); // 40/100
    const ebitda = stmt.income.find((r) => r.key === "ebitda")!;
    expect(ebitda.sub?.values[1]).toBeCloseTo(0.25, 10); // 50/200
  });

  it("computes revenue YoY growth across period columns (1 back for annual)", () => {
    const rev = stmt.income.find((r) => r.key === "revenue")!;
    expect(rev.sub?.kind).toBe("growth");
    expect(rev.sub?.values[0]).toBeNull(); // no prior column
    expect(rev.sub?.values[1]).toBeCloseTo(1.0, 10); // 200/100 - 1
  });

  it("derives per-share = line / diluted shares (EPS for net income)", () => {
    const eps = stmt.perShare.find((r) => r.key === "netIncome")!;
    expect(eps.values[0]).toBeCloseTo(0.1, 10); // 10 / 100
    const revPs = stmt.perShare.find((r) => r.key === "revenue")!;
    expect(revPs.values[1]).toBeCloseTo(2.0, 10); // 200 / 100
  });

  it("builds the TEV bridge so Enterprise Value ties to its displayed components", () => {
    const mc = stmt.bridge.find((r) => r.key === "marketCap")!.values[0]!;
    const cash = stmt.bridge.find((r) => r.key === "cash")!.values[0]!;
    const pref = stmt.bridge.find((r) => r.key === "preferredOther")!.values[0]!;
    const debt = stmt.bridge.find((r) => r.key === "totalDebt")!.values[0]!;
    const ev = stmt.bridge.find((r) => r.key === "enterpriseValue")!.values[0]!;
    expect(pref).toBe(15); // preferred 10 + minority 5
    expect(ev).toBe(mc - cash + pref + debt); // 1000 - 50 + 15 + 200 = 1165
    expect(ev).toBe(1165);
  });

  it("uses the estimate EPS directly and leaves unmapped lines blank", () => {
    const est: FaColumnInput = {
      kind: "estimate",
      label: "FY2024 Est",
      fiscalDate: "2024-12-31",
      data: {
        ...q("2024-12-31", 2024, 3),
        grossProfit: null,
        operatingCashFlow: null,
        capex: null,
        freeCashFlow: null,
        sharesDiluted: null,
        marketCap: null,
        cash: null,
        totalDebt: null,
        preferredEquity: null,
        minorityInterest: null,
      },
      estimateEps: 1.23,
    };
    const s = buildStatement([...cols, est], "annual");
    const eps = s.perShare.find((r) => r.key === "netIncome")!;
    expect(eps.values[2]).toBe(1.23);
    const grossPs = s.perShare.find((r) => r.key === "grossProfit")!;
    expect(grossPs.values[2]).toBeNull();
  });
});

describe("toQuarterlyRunRate", () => {
  it("divides flow items by 4 and leaves point-in-time items unchanged", () => {
    const rr = toQuarterlyRunRate(q("2023-12-31", 2023, 4)); // scale 4 -> revenue 400
    expect(rr.revenue).toBe(100); // 400 / 4
    expect(rr.freeCashFlow).toBe(17); // 68 / 4
    expect(rr.capex).toBe(-5); // -20 / 4
    // capitalization / share figures untouched
    expect(rr.totalDebt).toBe(200);
    expect(rr.cash).toBe(50);
    expect(rr.marketCap).toBe(1000);
    expect(rr.enterpriseValue).toBe(1165);
    expect(rr.sharesDiluted).toBe(100);
  });

  it("keeps margins invariant (ratio of two scaled flows)", () => {
    const base = q("2023-12-31", 2023, 4);
    const rr = toQuarterlyRunRate(base);
    expect((rr.grossProfit ?? 0) / (rr.revenue ?? 1)).toBeCloseTo(
      (base.grossProfit ?? 0) / (base.revenue ?? 1),
      12,
    );
  });
});

describe("fiscal labels", () => {
  // MU-style August fiscal year end.
  const actuals: FaPeriodInput[] = [
    { ...q("2025-08-28", 2025, 1), fiscalLabel: "Q4" },
    { ...q("2025-11-27", 2026, 1), fiscalLabel: "Q1" },
    { ...q("2026-02-26", 2026, 1), fiscalLabel: "Q2" },
    { ...q("2026-05-28", 2026, 1), fiscalLabel: "Q3" },
  ];

  it("labels historical actuals with an A suffix", () => {
    expect(actualLabel({ ...q("2024-02-29", 2024, 1), fiscalLabel: "Q2" }, "quarter")).toBe("Q2 24A");
    expect(actualLabel({ ...q("2024-08-31", 2024, 1), fiscalLabel: "Q4" }, "annual")).toBe("FY24A");
  });

  it("maps estimate fiscal dates onto the company fiscal calendar with an E suffix", () => {
    const map = buildMonthMap(actuals);
    expect(estimateLabel("2026-08-28", "quarter", map)).toBe("Q4 26E");
    expect(estimateLabel("2026-11-28", "quarter", map)).toBe("Q1 27E");
    expect(estimateLabel("2027-02-28", "quarter", map)).toBe("Q2 27E");
    expect(estimateLabel("2026-08-28", "annual", map)).toBe("FY26E");
    expect(estimateLabel("2027-08-28", "annual", map)).toBe("FY27E");
  });

  it("falls back to calendar quarters when the month is unknown", () => {
    const empty = new Map();
    expect(estimateLabel("2027-03-31", "quarter", empty)).toBe("Q1 27E");
    expect(estimateLabel("2027-12-31", "annual", empty)).toBe("FY27E");
  });
});

describe("analyst counts on estimate columns", () => {
  it("threads estimateAnalysts onto estimate columns and leaves actuals null", () => {
    const period = periodCol(q("2023-12-31", 2023, 1));
    const est: FaColumnInput = {
      kind: "estimate",
      label: "FY24E",
      fiscalDate: "2024-12-31",
      data: q("2024-12-31", 2024, 1),
      estimateEps: 1.5,
      estimateAnalysts: 26,
    };
    const s = buildStatement([period, est], "annual");
    expect(s.columns[0]!.analysts).toBeNull();
    expect(s.columns[1]!.analysts).toBe(26);
  });
});

describe("buildMetricRows", () => {
  const metric: FaColumnMetrics = {
    netIncome: 10,
    totalEquity: 250,
    totalAssets: 500,
    roic: 0.15,
    netDebtToEbitda: 1.5,
  };
  // columns: period, period, LTM, estimate
  const returns: Array<FaColumnMetrics | null> = [metric, metric, metric, null];
  const val = (ev: number, mc: number, rev: number, ebitda: number, ni: number): FaColumnValuation => ({
    ev,
    marketCap: mc,
    ntmRevenue: rev,
    ntmEbitda: ebitda,
    ntmNetIncome: ni,
  });
  // historical column priced at its own EV; LTM + estimate priced at current EV (1165/1000)
  const valuations: Array<FaColumnValuation | null> = [
    val(900, 800, 480, 95, 45),
    val(1100, 950, 500, 98, 48),
    val(1165, 1000, 520, 100, 50),
    val(1165, 1000, 540, 105, 55),
  ];

  const { valuationMetrics, returnMetrics } = buildMetricRows(returns, valuations);

  it("computes ROE / ROA per column and passes ROIC through", () => {
    const roe = returnMetrics.find((r) => r.key === "roe")!;
    const roa = returnMetrics.find((r) => r.key === "roa")!;
    const roic = returnMetrics.find((r) => r.key === "roic")!;
    expect(roe.values[0]).toBeCloseTo(0.04, 12); // 10/250
    expect(roa.values[0]).toBeCloseTo(0.02, 12); // 10/500
    expect(roic.values[0]).toBe(0.15);
    expect(roe.kind).toBe("percent");
  });

  it("leaves estimate columns blank for the return ratios", () => {
    for (const row of returnMetrics) expect(row.values[3]).toBeNull();
  });

  it("computes EV / NTM multiples per column, priced at each column's own EV", () => {
    const tevRev = valuationMetrics.find((r) => r.key === "tevNtmRevenue")!;
    const tevEbitda = valuationMetrics.find((r) => r.key === "tevNtmEbitda")!;
    const pe = valuationMetrics.find((r) => r.key === "ntmPe")!;
    expect(tevRev.values[0]).toBeCloseTo(900 / 480, 12); // historical: own EV / next-4q
    expect(tevRev.values[2]).toBeCloseTo(1165 / 520, 12); // LTM: current EV / NTM consensus
    expect(tevRev.values[3]).toBeCloseTo(1165 / 540, 12); // forward column also carries a multiple
    expect(tevEbitda.values[2]).toBeCloseTo(1165 / 100, 12);
    expect(pe.values[2]).toBeCloseTo(1000 / 50, 12);
    expect(tevRev.kind).toBe("multiple");
  });

  it("returns null valuation cells when the column input is null", () => {
    const withNull = buildMetricRows(returns, [null, ...valuations.slice(1)]);
    const tevRev = withNull.valuationMetrics.find((r) => r.key === "tevNtmRevenue")!;
    expect(tevRev.values[0]).toBeNull();
  });

  it("renders net leverage per column from the returns input, null on estimate columns", () => {
    const lev = valuationMetrics.find((r) => r.key === "netLeverage")!;
    expect(lev.values[0]).toBe(1.5);
    expect(lev.values[2]).toBe(1.5);
    expect(lev.values[3]).toBeNull();
  });
});

describe("pickUnit", () => {
  it("keeps every figure to at most 6 integer digits in the chosen unit", () => {
    for (const maxAbs of [4.2e5, 5e7, 4.5e11, 3.1e12, 9.9e11, 8e8]) {
      const unit = pickUnit(maxAbs);
      const scale = unit === "billions" ? 1e9 : unit === "millions" ? 1e6 : 1e3;
      expect(Math.abs(maxAbs) / scale).toBeLessThan(1e6);
    }
  });

  it("defaults to millions, switches to billions above ~$1T", () => {
    expect(pickUnit(5e9)).toBe("millions");
    expect(pickUnit(2e12)).toBe("billions");
    expect(pickUnit(5e5)).toBe("thousands");
  });
});

describe("format-statement", () => {
  it("scales dollars with no decimals and comma grouping", () => {
    expect(formatStatement(27_006_000_000, "millions")).toBe("27,006");
    expect(formatStatement(-2_729_800_000, "millions")).toBe("-2,730");
    expect(formatStatement(null, "millions")).toBe("—");
  });

  it("formats per-share, margin, and growth", () => {
    expect(formatPerShare(5.273)).toBe("5.27");
    expect(formatMarginPct(0.396)).toBe("39.6%");
    expect(formatGrowthPct(0.122)).toBe("+12.2%");
    expect(formatGrowthPct(-0.031)).toBe("-3.1%");
  });

  it("formats multiples to one decimal with an x suffix", () => {
    expect(formatMultiple(12.34)).toBe("12.3x");
    expect(formatMultiple(2)).toBe("2.0x");
    expect(formatMultiple(null)).toBe("—");
    expect(formatMultiple(Infinity)).toBe("—");
  });
});

describe("spark series", () => {
  it("attachSparkByKey merges values onto main rows by key", () => {
    const main = [
      { key: "a", label: "A", values: [1], spark: [] },
      { key: "b", label: "B", values: [2], spark: [] },
    ];
    const sparkSource = [
      { key: "a", values: [10, 20] },
      { key: "b", values: [30, 40, 50] },
    ];
    const merged = attachSparkByKey(main, sparkSource);
    expect(merged[0]!.spark).toEqual([10, 20]);
    expect(merged[1]!.spark).toEqual([30, 40, 50]);
  });

  it("attachIncomeSpark merges sub-row spark series", () => {
    const mainStmt = buildStatement([periodCol(q("2023-12-31", 2023, 1))], "quarter");
    const sparkStmt = buildStatement(
      [periodCol(q("2023-03-31", 2023, 1)), periodCol(q("2023-12-31", 2023, 2))],
      "quarter",
    );
    const merged = attachIncomeSpark(mainStmt.income, sparkStmt.income);
    const gross = merged.find((r) => r.key === "grossProfit")!;
    expect(gross.spark).toEqual([40, 80]);
    expect(gross.sub?.spark).toEqual([0.4, 0.4]);
  });

  it("8-quarter spark build produces length-8 revenue series independent of annual display", () => {
    const quarters: FaPeriodInput[] = [];
    for (let i = 0; i < SPARK_TRAIL_QUARTERS; i++) {
      quarters.push(q(`202${1 + Math.floor(i / 4)}-${String(((i % 4) + 1) * 3).padStart(2, "0")}-30`, 2021 + Math.floor(i / 4), i + 1));
    }
    const sparkQuarters = quarters.slice(-SPARK_TRAIL_QUARTERS);
    const sparkCols = sparkQuarters.map((p) => periodCol(p));
    const sparkStatement = buildStatement(sparkCols, "quarter");
    const annualDisplay = buildStatement(sparkCols.slice(-2), "annual");

    expect(sparkStatement.income.find((r) => r.key === "revenue")!.values).toHaveLength(8);
    expect(annualDisplay.income.find((r) => r.key === "revenue")!.values.length).toBeLessThan(8);
    const revSpark = attachIncomeSpark(annualDisplay.income, sparkStatement.income).find((r) => r.key === "revenue")!;
    expect(revSpark.spark).toHaveLength(8);
    expect(revSpark.spark[0]).toBe(100);
    expect(revSpark.spark[7]).toBe(800);
    const gross = attachIncomeSpark(annualDisplay.income, sparkStatement.income).find((r) => r.key === "grossProfit")!;
    expect(gross.sub?.spark[0]).toBeCloseTo(0.4, 10);
  });
});
