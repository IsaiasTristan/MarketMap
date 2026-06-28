/**
 * Engine 2 — pure builder for the Financial Analysis (FA) statement view.
 *
 * Turns normalized fiscal-period facts into the Bloomberg-style FA layout: a
 * historical income block (Revenue -> Gross Profit -> EBITDA -> Net Income ->
 * CFFO -> CAPEX -> FCF) with a margin (or growth) sub-row under each line, a
 * separate per-share block, and a Market Cap -> Enterprise Value (TEV) bridge.
 *
 * Identities tie by construction: derived line items (EBITDA, FCF) come from the
 * stored derived values; margins are line / revenue in the SAME column; and the
 * displayed Enterprise Value is the exact arithmetic of its displayed bridge
 * components (Market Cap - Cash + Preferred & Other + Total Debt). No I/O.
 */

export type FaBasis = "annual" | "quarter";
export type FaUnit = "thousands" | "millions" | "billions";
export type FaColumnKind = "period" | "current" | "estimate";

/** Trailing quarter count for per-row trend sparklines (always quarter-level). */
export const SPARK_TRAIL_QUARTERS = 8;

export type FaSparkSeries = Array<number | null>;

/** All facts needed to render one column. Estimate columns leave most null. */
export interface FaPeriodInput {
  fiscalDate: string; // YYYY-MM-DD (period end)
  fiscalYear: number | null;
  fiscalLabel: string | null; // FY | Q1..Q4
  // flow items (period flow)
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  ebitda: number | null; // derived = operatingIncome + D&A
  netIncome: number | null;
  operatingCashFlow: number | null; // CFFO
  capex: number | null; // negative (cash outflow)
  freeCashFlow: number | null; // derived = OCF + capex
  // balance / point-in-time
  totalDebt: number | null;
  cash: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  preferredEquity: number | null;
  minorityInterest: number | null;
  sharesDiluted: number | null;
  // stored ratios (point-in-time, as reported by FMP)
  roic: number | null;
  netDebtToEbitda: number | null;
  // market (priced at fiscal date / snapshot)
  marketCap: number | null;
  enterpriseValue: number | null;
}

export interface FaColumnInput {
  kind: FaColumnKind;
  label: string;
  fiscalDate: string | null;
  data: FaPeriodInput;
  /** Estimate columns may carry EPS directly when share counts are unknown. */
  estimateEps?: number | null;
  /** Estimate columns: contributing analyst count (consensus depth). */
  estimateAnalysts?: number | null;
}

export interface FaColumn {
  kind: FaColumnKind;
  label: string;
  fiscalDate: string | null;
  /** Estimate columns: contributing analyst count; null for actual / LTM. */
  analysts: number | null;
}

export interface FaStatementRow {
  key: string;
  label: string;
  values: Array<number | null>; // raw $ per column
  /** Last SPARK_TRAIL_QUARTERS quarter-level values, oldest → newest. */
  spark: FaSparkSeries;
  sub: {
    key: string;
    label: string;
    kind: "margin" | "growth";
    values: Array<number | null>; // decimal per column
    spark: FaSparkSeries;
  } | null;
}

export interface FaPerShareRow {
  key: string;
  label: string;
  values: Array<number | null>; // raw $/share per column
  spark: FaSparkSeries;
}

export interface FaBridgeRow {
  key: string;
  label: string;
  sign: "+" | "-" | "=";
  values: Array<number | null>; // raw $ per column
  spark: FaSparkSeries;
}

/** A ratio / multiple row (percent or "x" multiple), per column. */
export interface FaMetricRow {
  key: string;
  label: string;
  kind: "multiple" | "percent";
  values: Array<number | null>;
  spark: FaSparkSeries;
}

/** Per-column underlying values for ratio computation (un-divided by run-rate). */
export interface FaColumnMetrics {
  netIncome: number | null;
  totalEquity: number | null;
  totalAssets: number | null;
  roic: number | null;
  netDebtToEbitda: number | null;
}

/**
 * Per-column valuation inputs. The numerator (EV / market cap) is the period's
 * stored point-in-time value on historical columns and the current snapshot
 * value on the LTM + forward columns; the denominator is the NTM = sum of the
 * next 4 quarters measured forward from the column (subsequent actuals for the
 * past, consensus estimates for now / the future).
 */
export interface FaColumnValuation {
  ev: number | null;
  marketCap: number | null;
  ntmRevenue: number | null;
  ntmEbitda: number | null;
  ntmNetIncome: number | null;
}

export interface FaStatement {
  columns: FaColumn[];
  unit: FaUnit;
  income: FaStatementRow[];
  perShare: FaPerShareRow[];
  bridge: FaBridgeRow[];
}

function fin(v: number | null | undefined): number | null {
  return v !== null && v !== undefined && Number.isFinite(v) ? v : null;
}

function sumNullable(values: Array<number | null>): number | null {
  let s = 0;
  let any = false;
  for (const v of values) {
    if (v === null || !Number.isFinite(v)) return null;
    s += v;
    any = true;
  }
  return any ? s : null;
}

function ratio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  const r = num / den;
  return Number.isFinite(r) ? r : null;
}

function mean(values: Array<number | null>): number | null {
  const ok = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (ok.length === 0) return null;
  return ok.reduce((a, b) => a + b, 0) / ok.length;
}

/**
 * Aggregate chronological quarterly facts into one entry per fiscal year:
 * flow items are summed across the year's quarters; balance / market figures
 * take the fiscal-year-end (latest) quarter; per-FY diluted shares are the mean
 * of the quarterly weighted-average counts. Only complete (4-quarter) years are
 * returned, ascending by fiscal year.
 */
export function aggregateAnnual(quarters: FaPeriodInput[]): FaPeriodInput[] {
  const byYear = new Map<number, FaPeriodInput[]>();
  for (const q of quarters) {
    if (q.fiscalYear === null) continue;
    const arr = byYear.get(q.fiscalYear) ?? [];
    arr.push(q);
    byYear.set(q.fiscalYear, arr);
  }

  const out: FaPeriodInput[] = [];
  for (const [year, qs] of byYear) {
    if (qs.length < 4) continue; // incomplete fiscal year — the Current/LTM column covers the partial tail
    const sorted = [...qs].sort((a, b) => a.fiscalDate.localeCompare(b.fiscalDate));
    const yearEnd = sorted[sorted.length - 1]!;
    out.push({
      fiscalDate: yearEnd.fiscalDate,
      fiscalYear: year,
      fiscalLabel: "FY",
      revenue: sumNullable(sorted.map((q) => q.revenue)),
      grossProfit: sumNullable(sorted.map((q) => q.grossProfit)),
      operatingIncome: sumNullable(sorted.map((q) => q.operatingIncome)),
      ebitda: sumNullable(sorted.map((q) => q.ebitda)),
      netIncome: sumNullable(sorted.map((q) => q.netIncome)),
      operatingCashFlow: sumNullable(sorted.map((q) => q.operatingCashFlow)),
      capex: sumNullable(sorted.map((q) => q.capex)),
      freeCashFlow: sumNullable(sorted.map((q) => q.freeCashFlow)),
      totalDebt: yearEnd.totalDebt,
      cash: yearEnd.cash,
      totalAssets: yearEnd.totalAssets,
      totalEquity: yearEnd.totalEquity,
      preferredEquity: yearEnd.preferredEquity,
      minorityInterest: yearEnd.minorityInterest,
      sharesDiluted: mean(sorted.map((q) => q.sharesDiluted)),
      roic: yearEnd.roic,
      netDebtToEbitda: yearEnd.netDebtToEbitda,
      marketCap: yearEnd.marketCap,
      enterpriseValue: yearEnd.enterpriseValue,
    });
  }
  return out.sort((a, b) => (a.fiscalYear ?? 0) - (b.fiscalYear ?? 0));
}

const FLOW_KEYS: Array<keyof FaPeriodInput> = [
  "revenue",
  "grossProfit",
  "operatingIncome",
  "ebitda",
  "netIncome",
  "operatingCashFlow",
  "capex",
  "freeCashFlow",
];

/**
 * Convert a trailing-twelve-month (LTM) period into an average-quarter run-rate:
 * income-statement FLOW items are divided by 4; balance / market / share figures
 * are point-in-time and kept as-is (so the cap -> EV bridge stays correct, and
 * per-share derivations scale to an average-quarter basis automatically).
 */
export function toQuarterlyRunRate(period: FaPeriodInput): FaPeriodInput {
  const next: FaPeriodInput = { ...period };
  for (const k of FLOW_KEYS) {
    const v = next[k] as number | null;
    (next[k] as number | null) = v !== null && Number.isFinite(v) ? v / 4 : v;
  }
  return next;
}

interface FiscalSlot {
  quarter: string; // Q1..Q4
  yearOffset: number; // fiscalYear - calendarYear(fiscalDate)
}

/**
 * Map a fiscal period-end month (MM) to the company's fiscal quarter + the
 * offset between its fiscal year and the calendar year of the period end.
 * Built from historical actuals (which carry fiscalLabel + fiscalYear) so that
 * estimate periods — which only carry a fiscalDate — can be labelled on the same
 * fiscal calendar (handles off-calendar fiscal years such as an August year-end).
 */
export function buildMonthMap(actuals: FaPeriodInput[]): Map<string, FiscalSlot> {
  const map = new Map<string, FiscalSlot>();
  for (const a of actuals) {
    if (!a.fiscalLabel || !/^Q[1-4]$/.test(a.fiscalLabel) || a.fiscalYear === null) continue;
    const mm = a.fiscalDate.slice(5, 7);
    if (map.has(mm)) continue;
    const calYear = Number(a.fiscalDate.slice(0, 4));
    if (!Number.isFinite(calYear)) continue;
    map.set(mm, { quarter: a.fiscalLabel, yearOffset: a.fiscalYear - calYear });
  }
  return map;
}

function twoDigit(year: number): string {
  return String(((year % 100) + 100) % 100).padStart(2, "0");
}

/** Actual (historical) column label: "Q2 24A" (quarter) / "FY24A" (annual). */
export function actualLabel(input: FaPeriodInput, basis: FaBasis): string {
  const calYear = Number(input.fiscalDate.slice(0, 4));
  const fy = input.fiscalYear ?? (Number.isFinite(calYear) ? calYear : 0);
  if (basis === "annual") return `FY${twoDigit(fy)}A`;
  const q = input.fiscalLabel && /^Q[1-4]$/.test(input.fiscalLabel) ? input.fiscalLabel : `Q${Math.floor(Number(input.fiscalDate.slice(5, 7)) / 3.0001) + 1}`;
  return `${q} ${twoDigit(fy)}A`;
}

/** Estimate column label: "Q4 26E" (quarter) / "FY26E" (annual), via the fiscal month map. */
export function estimateLabel(fiscalDate: string, basis: FaBasis, monthMap: Map<string, FiscalSlot>): string {
  const calYear = Number(fiscalDate.slice(0, 4));
  const mm = fiscalDate.slice(5, 7);
  const slot = monthMap.get(mm);
  const fy = slot ? calYear + slot.yearOffset : calYear;
  if (basis === "annual") return `FY${twoDigit(fy)}E`;
  const q = slot ? slot.quarter : `Q${Math.floor(Number(mm) / 3.0001) + 1}`;
  return `${q} ${twoDigit(fy)}E`;
}

/** Sum of nullable parts, null only if EVERY part is null (treats missing as 0). */
function addParts(parts: Array<number | null>): number | null {
  let s = 0;
  let any = false;
  for (const p of parts) {
    if (p !== null && Number.isFinite(p)) {
      s += p;
      any = true;
    }
  }
  return any ? s : null;
}

/**
 * Pick the display unit so the largest statement / bridge magnitude fits in at
 * most 6 integer digits (<= 999,999). Millions is the default (Bloomberg-style);
 * billions kicks in above ~$1T; thousands only for sub-$1M figures.
 */
export function pickUnit(maxAbs: number): FaUnit {
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) return "millions";
  if (maxAbs >= 1e12) return "billions";
  if (maxAbs >= 1e6) return "millions";
  return "thousands";
}

const INCOME_LINES: Array<{
  key: keyof FaPeriodInput;
  label: string;
  sub: { key: string; label: string; kind: "margin" | "growth" } | null;
}> = [
  { key: "revenue", label: "Revenue", sub: { key: "revenueGrowth", label: "Growth %, YoY", kind: "growth" } },
  { key: "grossProfit", label: "Gross Profit", sub: { key: "grossMargin", label: "Margin %", kind: "margin" } },
  { key: "ebitda", label: "EBITDA", sub: { key: "ebitdaMargin", label: "Margin %", kind: "margin" } },
  { key: "netIncome", label: "Net Income", sub: { key: "netMargin", label: "Margin %", kind: "margin" } },
  { key: "operatingCashFlow", label: "Cash from Operations", sub: { key: "cffoMargin", label: "Margin %", kind: "margin" } },
  { key: "capex", label: "Capital Expenditures", sub: { key: "capexMargin", label: "% of Revenue", kind: "margin" } },
  { key: "freeCashFlow", label: "Free Cash Flow", sub: { key: "fcfMargin", label: "Margin %", kind: "margin" } },
];

const PER_SHARE_LINES: Array<{ key: keyof FaPeriodInput; label: string }> = [
  { key: "revenue", label: "Revenue / sh" },
  { key: "grossProfit", label: "Gross Profit / sh" },
  { key: "ebitda", label: "EBITDA / sh" },
  { key: "netIncome", label: "EPS (Net Income / sh)" },
  { key: "operatingCashFlow", label: "CFFO / sh" },
  { key: "capex", label: "CapEx / sh" },
  { key: "freeCashFlow", label: "FCF / sh" },
];

/**
 * Build the full FA statement payload from ordered columns. `basis` controls the
 * year-over-year growth offset for the Revenue sub-row (1 period back for annual,
 * 4 for quarterly), computed across the historical period columns only.
 */
export function buildStatement(columns: FaColumnInput[], basis: FaBasis): FaStatement {
  const cols = columns.map((c) => c.data);
  const offset = basis === "annual" ? 1 : 4;

  // Income rows with margin / growth sub-rows.
  const income: FaStatementRow[] = INCOME_LINES.map((line) => {
    const values = cols.map((d) => fin(d[line.key] as number | null));
    let sub: FaStatementRow["sub"] = null;
    if (line.sub) {
      if (line.sub.kind === "growth") {
        const sv = columns.map((c, i) => {
          if (c.kind !== "period") return null;
          const prevIdx = i - offset;
          if (prevIdx < 0 || columns[prevIdx]?.kind !== "period") return null;
          return ratio(values[i], values[prevIdx]) === null
            ? null
            : (values[i]! / values[prevIdx]!) - 1;
        });
        sub = { key: line.sub.key, label: line.sub.label, kind: "growth", values: sv, spark: [] };
      } else {
        const sv = cols.map((d, i) => ratio(values[i], fin(d.revenue)));
        sub = { key: line.sub.key, label: line.sub.label, kind: "margin", values: sv, spark: [] };
      }
    }
    return { key: String(line.key), label: line.label, values, spark: [], sub };
  });

  // Per-share block.
  const perShare: FaPerShareRow[] = PER_SHARE_LINES.map((line) => {
    const values = columns.map((c) => {
      const d = c.data;
      if (line.key === "netIncome" && c.kind === "estimate" && c.estimateEps != null) {
        return fin(c.estimateEps);
      }
      return ratio(fin(d[line.key] as number | null), fin(d.sharesDiluted));
    });
    return { key: String(line.key), label: line.label, values, spark: [] };
  });

  // TEV bridge. Enterprise Value is the exact sum of the displayed components so
  // the column always ties: EV = Market Cap - Cash + Preferred & Other + Total Debt.
  const marketCap = cols.map((d) => fin(d.marketCap));
  const cash = cols.map((d) => fin(d.cash));
  const preferredOther = cols.map((d) => addParts([fin(d.preferredEquity), fin(d.minorityInterest)]));
  const totalDebt = cols.map((d) => fin(d.totalDebt));
  const ev = cols.map((_, i) =>
    addParts([
      marketCap[i],
      cash[i] === null ? null : -cash[i]!,
      preferredOther[i],
      totalDebt[i],
    ]),
  );
  const bridge: FaBridgeRow[] = [
    { key: "marketCap", label: "Market Capitalization", sign: "+", values: marketCap, spark: [] },
    { key: "cash", label: "Cash & Equivalents", sign: "-", values: cash, spark: [] },
    { key: "preferredOther", label: "Preferred & Other", sign: "+", values: preferredOther, spark: [] },
    { key: "totalDebt", label: "Total Debt", sign: "+", values: totalDebt, spark: [] },
    { key: "enterpriseValue", label: "Enterprise Value", sign: "=", values: ev, spark: [] },
  ];

  // Unit: largest $ magnitude across income + bridge (per-share / margins excluded).
  let maxAbs = 0;
  for (const r of income) for (const v of r.values) if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v));
  for (const r of bridge) for (const v of r.values) if (v !== null) maxAbs = Math.max(maxAbs, Math.abs(v));

  return {
    columns: columns.map((c) => ({
      kind: c.kind,
      label: c.label,
      fiscalDate: c.fiscalDate,
      analysts: c.kind === "estimate" ? fin(c.estimateAnalysts) : null,
    })),
    unit: pickUnit(maxAbs),
    income,
    perShare,
    bridge,
  };
}

/**
 * Build the Valuation Metrics and Return & Profitability rows. Both `returns`
 * and `valuations` are aligned 1:1 with the statement columns (null where data
 * is unavailable, e.g. forward balance-sheet items). The forward multiples are
 * EV / NTM at every column (NTM = next-4-quarter sum), priced at the column's
 * own EV / market cap; Net Leverage and the return ratios render per column.
 */
export function buildMetricRows(
  returns: Array<FaColumnMetrics | null>,
  valuations: Array<FaColumnValuation | null>,
): { valuationMetrics: FaMetricRow[]; returnMetrics: FaMetricRow[] } {
  const roe = returns.map((m) => (m ? ratio(fin(m.netIncome), fin(m.totalEquity)) : null));
  const roa = returns.map((m) => (m ? ratio(fin(m.netIncome), fin(m.totalAssets)) : null));
  const roic = returns.map((m) => (m ? fin(m.roic) : null));
  const netLeverage = returns.map((m) => (m ? fin(m.netDebtToEbitda) : null));

  const tevRev = valuations.map((v) => (v ? ratio(fin(v.ev), fin(v.ntmRevenue)) : null));
  const tevEbitda = valuations.map((v) => (v ? ratio(fin(v.ev), fin(v.ntmEbitda)) : null));
  const ntmPe = valuations.map((v) => (v ? ratio(fin(v.marketCap), fin(v.ntmNetIncome)) : null));

  const valuationMetrics: FaMetricRow[] = [
    { key: "tevNtmRevenue", label: "TEV / NTM Revenue", kind: "multiple", values: tevRev, spark: [] },
    { key: "tevNtmEbitda", label: "TEV / NTM EBITDA", kind: "multiple", values: tevEbitda, spark: [] },
    { key: "ntmPe", label: "NTM P/E", kind: "multiple", values: ntmPe, spark: [] },
    { key: "netLeverage", label: "Net Leverage (Net Debt / EBITDA)", kind: "multiple", values: netLeverage, spark: [] },
  ];

  const returnMetrics: FaMetricRow[] = [
    { key: "roe", label: "Return on Equity", kind: "percent", values: roe, spark: [] },
    { key: "roa", label: "Return on Assets", kind: "percent", values: roa, spark: [] },
    { key: "roic", label: "Return on Invested Capital", kind: "percent", values: roic, spark: [] },
  ];

  return { valuationMetrics, returnMetrics };
}

/** Merge quarter-level spark series from a parallel build onto main rows by key. */
export function attachSparkByKey<T extends { key: string }>(
  main: T[],
  sparkSource: Array<{ key: string; values: Array<number | null> }>,
): Array<T & { spark: FaSparkSeries }> {
  const byKey = new Map(sparkSource.map((s) => [s.key, s.values]));
  return main.map((row) => ({
    ...row,
    spark: byKey.get(row.key) ?? [],
  }));
}

/** Merge spark series onto income rows, including margin / growth sub-rows. */
export function attachIncomeSpark(main: FaStatementRow[], sparkSource: FaStatementRow[]): FaStatementRow[] {
  const byKey = new Map(sparkSource.map((s) => [s.key, s]));
  return main.map((row) => {
    const src = byKey.get(row.key);
    return {
      ...row,
      spark: src?.values ?? [],
      sub: row.sub
        ? {
            ...row.sub,
            spark: src?.sub?.values ?? [],
          }
        : null,
    };
  });
}
