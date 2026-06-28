/**
 * Engine 2 — standardized financial statements (income / balance / cash-flow).
 * FMP serves these EDGAR-sourced in a consistent schema; this module is the
 * stable field-mapping layer (signal code never sees FMP field names). Every
 * numeric is parsed defensively. `fetchStatementPeriods` merges the three
 * statements into one row per fiscal period, ascending by date.
 */
import { fmpGetJson, isoDate, num, str } from "./fmp-client";
import type {
  FmpBalanceSheetRaw,
  FmpCashFlowRaw,
  FmpEstimatePeriod,
  FmpIncomeStatementRaw,
  NormalizedStatementPeriod,
} from "./types";

export async function fetchIncomeStatement(
  symbol: string,
  period: FmpEstimatePeriod = "quarter",
  limit = 40,
): Promise<FmpIncomeStatementRaw[]> {
  const rows = await fmpGetJson<FmpIncomeStatementRaw[]>("/stable/income-statement", {
    symbol,
    period,
    limit,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function fetchBalanceSheet(
  symbol: string,
  period: FmpEstimatePeriod = "quarter",
  limit = 40,
): Promise<FmpBalanceSheetRaw[]> {
  const rows = await fmpGetJson<FmpBalanceSheetRaw[]>("/stable/balance-sheet-statement", {
    symbol,
    period,
    limit,
  });
  return Array.isArray(rows) ? rows : [];
}

export async function fetchCashFlow(
  symbol: string,
  period: FmpEstimatePeriod = "quarter",
  limit = 40,
): Promise<FmpCashFlowRaw[]> {
  const rows = await fmpGetJson<FmpCashFlowRaw[]>("/stable/cash-flow-statement", {
    symbol,
    period,
    limit,
  });
  return Array.isArray(rows) ? rows : [];
}

function fiscalYearNum(v: unknown): number | null {
  const n = num(v);
  if (n !== null) return n;
  const s = str(v);
  if (!s) return null;
  const m = s.match(/\d{4}/);
  return m ? Number(m[0]) : null;
}

/**
 * Fetch + merge income/balance/cash-flow for a symbol into one normalized row
 * per fiscal period. Balance + cash-flow rows are joined onto income rows by
 * fiscal-period end date. Ascending by date.
 */
export async function fetchStatementPeriods(
  symbol: string,
  period: FmpEstimatePeriod = "quarter",
  limit = 40,
): Promise<NormalizedStatementPeriod[]> {
  const [income, balance, cash] = await Promise.all([
    fetchIncomeStatement(symbol, period, limit),
    fetchBalanceSheet(symbol, period, limit),
    fetchCashFlow(symbol, period, limit),
  ]);

  const balByDate = new Map<string, FmpBalanceSheetRaw>();
  for (const b of balance) {
    const d = isoDate(b.date);
    if (d) balByDate.set(d, b);
  }
  const cashByDate = new Map<string, FmpCashFlowRaw>();
  for (const c of cash) {
    const d = isoDate(c.date);
    if (d) cashByDate.set(d, c);
  }

  const out: NormalizedStatementPeriod[] = [];
  for (const i of income) {
    const fiscalDate = isoDate(i.date);
    if (!fiscalDate) continue;
    const b = balByDate.get(fiscalDate);
    const c = cashByDate.get(fiscalDate);
    const ocf = num(c?.operatingCashFlow) ?? num(c?.netCashProvidedByOperatingActivities);
    out.push({
      fiscalDate,
      period: str(i.period),
      fiscalYear: fiscalYearNum(i.fiscalYear),
      reportedCurrency: str(i.reportedCurrency),
      revenue: num(i.revenue),
      grossProfit: num(i.grossProfit),
      operatingIncome: num(i.operatingIncome),
      netIncome: num(i.netIncome),
      depreciationAndAmortization:
        num(i.depreciationAndAmortization) ?? num(c?.depreciationAndAmortization),
      sga: num(i.sellingGeneralAndAdministrativeExpenses),
      rnd: num(i.researchAndDevelopmentExpenses),
      ebitdaReported: num(i.ebitda),
      sharesDiluted: num(i.weightedAverageShsOutDil) ?? num(i.weightedAverageShsOut),
      totalDebt: num(b?.totalDebt),
      cash: num(b?.cashAndCashEquivalents) ?? num(b?.cashAndShortTermInvestments),
      totalAssets: num(b?.totalAssets),
      totalEquity: num(b?.totalStockholdersEquity) ?? num(b?.totalEquity),
      preferredEquity: num(b?.preferredStock),
      minorityInterest: num(b?.minorityInterest),
      netDebtReported: num(b?.netDebt),
      interestExpense: num(i.interestExpense),
      operatingCashFlow: ocf,
      capitalExpenditure: num(c?.capitalExpenditure),
      freeCashFlowReported: num(c?.freeCashFlow),
      stockBasedCompensation: num(c?.stockBasedCompensation),
      changeInWorkingCapital: num(c?.changeInWorkingCapital),
      commonStockIssued: num(c?.commonStockIssuance),
      commonStockRepurchased: num(c?.commonStockRepurchased),
    });
  }
  return out.sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate));
}
