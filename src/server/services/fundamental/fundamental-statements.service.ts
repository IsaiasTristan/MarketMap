/**
 * Engine 2 — statement ingestion + the stable field-mapping layer. Per symbol:
 * pull standardized income/balance/cash-flow + FMP ratios/key-metrics + a live
 * quote, map FMP fields into our schema, compute the derived fields at the
 * storage boundary (EBITDA = operating income + D&A; FCF = OCF + capex), and
 * upsert FundamentalPeriod write-once (never overwritten).
 *
 * Provenance: a first BACKFILL load stores restated-basis history whose
 * `firstSeenSnapshotDate` is the backfill date (fictional as a filing date);
 * only LIVE rows captured weekly after launch carry true as-first-reported
 * integrity. Restatement detection (logged to AuditLog) is therefore only
 * meaningful for an existing LIVE row whose figures later change.
 */
import type { FundamentalProvenance, Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import {
  fetchKeyMetrics,
  fetchQuote,
  fetchRatios,
  fetchStatementPeriods,
  type NormalizedKeyMetrics,
  type NormalizedQuote,
  type NormalizedRatios,
} from "@/infrastructure/providers/fmp";

const BACKFILL_QUARTERS = 36; // ~9 years of quarterly history

export interface ComputedPeriod {
  fiscalDate: string;
  periodType: "quarter" | "annual";
  fiscalLabel: string | null;
  revenue: number | null;
  grossProfit: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  depreciationAmortization: number | null;
  ebitda: number | null;
  totalDebt: number | null;
  cash: number | null;
  totalAssets: number | null;
  totalEquity: number | null;
  preferredEquity: number | null;
  minorityInterest: number | null;
  operatingCashFlow: number | null;
  capex: number | null;
  freeCashFlow: number | null;
  sharesDiluted: number | null;
  interestExpense: number | null;
  stockBasedCompensation: number | null;
  changeInWorkingCapital: number | null;
  commonStockIssued: number | null;
  commonStockRepurchased: number | null;
  grossMargin: number | null;
  ebitdaMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  roic: number | null;
  roe: number | null;
  netDebtToEbitda: number | null;
  peRatio: number | null;
  evToEbitda: number | null;
  priceToSales: number | null;
  dividendYield: number | null;
  fcfYield: number | null;
  interestCoverage: number | null;
  statementJson: Record<string, unknown>;
  ratiosJson: Record<string, unknown>;
}

export interface TickerFundamentals {
  ticker: string;
  periods: ComputedPeriod[];
  quote: NormalizedQuote | null;
}

function ratio(num: number | null, den: number | null): number | null {
  if (num === null || den === null || !Number.isFinite(den) || Math.abs(den) < 1e-9) return null;
  return num / den;
}

/** Fetch + map + derive one ticker's fundamentals (no DB writes). */
export async function buildTickerFundamentals(
  ticker: string,
  opts: { quarters?: number } = {},
): Promise<TickerFundamentals> {
  const limit = opts.quarters ?? BACKFILL_QUARTERS;
  const [statements, ratiosRows, keyMetricsRows, quote] = await Promise.all([
    fetchStatementPeriods(ticker, "quarter", limit),
    fetchRatios(ticker, "quarter", limit),
    fetchKeyMetrics(ticker, "quarter", limit),
    fetchQuote(ticker),
  ]);

  const ratiosByDate = new Map<string, NormalizedRatios>(ratiosRows.map((r) => [r.fiscalDate, r]));
  const kmByDate = new Map<string, NormalizedKeyMetrics>(keyMetricsRows.map((k) => [k.fiscalDate, k]));

  const periods: ComputedPeriod[] = statements.map((s) => {
    const r = ratiosByDate.get(s.fiscalDate);
    const k = kmByDate.get(s.fiscalDate);
    // Derived (our way) — Phase 0 showed FMP's `ebitda` field diverges on
    // small/loss-making names, so we always recompute EBITDA from line items.
    const ebitda =
      s.operatingIncome !== null && s.depreciationAndAmortization !== null
        ? s.operatingIncome + s.depreciationAndAmortization
        : null;
    const fcf =
      s.operatingCashFlow !== null && s.capitalExpenditure !== null
        ? s.operatingCashFlow + s.capitalExpenditure
        : s.freeCashFlowReported;
    const netDebt = s.totalDebt !== null && s.cash !== null ? s.totalDebt - s.cash : null;
    return {
      fiscalDate: s.fiscalDate,
      periodType: "quarter",
      fiscalLabel: s.period,
      revenue: s.revenue,
      grossProfit: s.grossProfit,
      operatingIncome: s.operatingIncome,
      netIncome: s.netIncome,
      depreciationAmortization: s.depreciationAndAmortization,
      ebitda,
      totalDebt: s.totalDebt,
      cash: s.cash,
      totalAssets: s.totalAssets,
      totalEquity: s.totalEquity,
      preferredEquity: s.preferredEquity,
      minorityInterest: s.minorityInterest,
      operatingCashFlow: s.operatingCashFlow,
      capex: s.capitalExpenditure,
      freeCashFlow: fcf,
      sharesDiluted: s.sharesDiluted,
      interestExpense: s.interestExpense,
      stockBasedCompensation: s.stockBasedCompensation,
      changeInWorkingCapital: s.changeInWorkingCapital,
      commonStockIssued: s.commonStockIssued,
      commonStockRepurchased: s.commonStockRepurchased,
      grossMargin: ratio(s.grossProfit, s.revenue),
      ebitdaMargin: ratio(ebitda, s.revenue),
      operatingMargin: ratio(s.operatingIncome, s.revenue),
      netMargin: ratio(s.netIncome, s.revenue),
      roic: r?.roic ?? k?.roic ?? null, // trusted from FMP (Phase 0)
      roe: r?.roe ?? null,
      netDebtToEbitda: r?.netDebtToEbitda ?? k?.netDebtToEbitda ?? ratio(netDebt, ebitda),
      peRatio: r?.peRatio ?? null,
      evToEbitda: k?.evToEbitda ?? r?.evToEbitda ?? null,
      priceToSales: r?.priceToSales ?? null,
      dividendYield: r?.dividendYield ?? null,
      fcfYield: k?.fcfYield ?? null,
      interestCoverage: r?.interestCoverage ?? null,
      statementJson: { ...s },
      ratiosJson: { ratios: r ?? null, keyMetrics: k ?? null },
    };
  });

  return { ticker: ticker.toUpperCase(), periods, quote };
}

/**
 * Persist a ticker's periods write-once. Existing rows are never overwritten;
 * for an existing LIVE row whose key figures changed, a restatement is logged
 * to AuditLog (BACKFILL rows are skipped — their figures are restated-basis by
 * construction). Returns the count of newly-inserted periods.
 */
export async function persistPeriods(
  ticker: string,
  periods: ComputedPeriod[],
  snapshotDate: string,
  provenance: FundamentalProvenance,
): Promise<{ inserted: number; restatements: number }> {
  const t = ticker.toUpperCase();
  const snap = new Date(`${snapshotDate}T00:00:00Z`);
  const existing = await prisma.fundamentalPeriod.findMany({
    where: { ticker: t, periodType: "quarter" },
    select: { fiscalDate: true, provenance: true, revenue: true, netIncome: true },
  });
  const existingByDate = new Map(existing.map((e) => [e.fiscalDate.toISOString().slice(0, 10), e]));

  const toCreate: Prisma.FundamentalPeriodCreateManyInput[] = [];
  let restatements = 0;

  for (const p of periods) {
    const prior = existingByDate.get(p.fiscalDate);
    if (prior) {
      // Restatement check — LIVE rows only (BACKFILL is restated-basis already).
      if (prior.provenance === "LIVE") {
        const prevRev = prior.revenue === null ? null : Number(prior.revenue);
        const prevNi = prior.netIncome === null ? null : Number(prior.netIncome);
        const revChanged = prevRev !== null && p.revenue !== null && Math.abs(prevRev - p.revenue) > Math.max(1, Math.abs(prevRev) * 1e-4);
        const niChanged = prevNi !== null && p.netIncome !== null && Math.abs(prevNi - p.netIncome) > Math.max(1, Math.abs(prevNi) * 1e-4);
        if (revChanged || niChanged) {
          restatements++;
          await prisma.auditLog.create({
            data: {
              actor: "fundamental-ingest",
              action: "fundamental_restatement_detected",
              payloadJson: {
                ticker: t,
                fiscalDate: p.fiscalDate,
                previous: { revenue: prevRev, netIncome: prevNi },
                refiled: { revenue: p.revenue, netIncome: p.netIncome },
                note: "stored as-first-reported value preserved; not overwritten",
              },
            },
          });
        }
      }
      continue; // write-once: never overwrite
    }
    toCreate.push({
      ticker: t,
      fiscalDate: new Date(`${p.fiscalDate}T00:00:00Z`),
      periodType: p.periodType,
      fiscalLabel: p.fiscalLabel,
      revenue: p.revenue,
      grossProfit: p.grossProfit,
      operatingIncome: p.operatingIncome,
      netIncome: p.netIncome,
      depreciationAmortization: p.depreciationAmortization,
      ebitda: p.ebitda,
      totalDebt: p.totalDebt,
      cash: p.cash,
      totalAssets: p.totalAssets,
      totalEquity: p.totalEquity,
      preferredEquity: p.preferredEquity,
      minorityInterest: p.minorityInterest,
      operatingCashFlow: p.operatingCashFlow,
      capex: p.capex,
      freeCashFlow: p.freeCashFlow,
      sharesDiluted: p.sharesDiluted,
      interestExpense: p.interestExpense,
      stockBasedCompensation: p.stockBasedCompensation,
      changeInWorkingCapital: p.changeInWorkingCapital,
      commonStockIssued: p.commonStockIssued,
      commonStockRepurchased: p.commonStockRepurchased,
      grossMargin: p.grossMargin,
      ebitdaMargin: p.ebitdaMargin,
      operatingMargin: p.operatingMargin,
      netMargin: p.netMargin,
      roic: p.roic,
      roe: p.roe,
      netDebtToEbitda: p.netDebtToEbitda,
      peRatio: p.peRatio,
      evToEbitda: p.evToEbitda,
      priceToSales: p.priceToSales,
      dividendYield: p.dividendYield,
      fcfYield: p.fcfYield,
      interestCoverage: p.interestCoverage,
      statementJson: p.statementJson as Prisma.InputJsonValue,
      ratiosJson: p.ratiosJson as Prisma.InputJsonValue,
      provenance,
      firstSeenSnapshotDate: snap,
    });
  }

  let inserted = 0;
  if (toCreate.length) {
    const res = await prisma.fundamentalPeriod.createMany({ data: toCreate, skipDuplicates: true });
    inserted = res.count;
  }
  return { inserted, restatements };
}
