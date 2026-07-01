/**
 * Engine 3 — 13F ingestion.
 *
 * Per active watchlist fund × target quarter:
 *   1. pull the full holdings (extract) and the book-total history (once/fund),
 *   2. aggregate the raw rows to ONE long-equity position per (fund, ticker):
 *      sum "SH" common-share rows, EXCLUDE put/call option rows (kept in rawJson),
 *   3. write FundHoldingSnapshot (action defaults to HELD; the diff pass in the
 *      aggregation service sets the real NEW/ADDED/TRIMMED/EXITED action),
 *   4. write FundBookSnapshot (portfolio totals; book denominator for % of book).
 *
 * Idempotent: re-running a (fund, period) deletes+rewrites that slice. 13F is
 * fully backfillable, so history is built from the first run.
 */
import { prisma } from "@/infrastructure/db/client";
import { fmpPool } from "@/infrastructure/providers/fmp/fmp-client";
import {
  fetchFundBookHistory,
  fetchFundHoldings,
  type FundBookRow,
  type HoldingRow,
} from "@/infrastructure/providers/fmp/institutional";
import { InstitutionalAction, type Prisma } from "@prisma/client";

export type QuarterKey = { year: number; quarter: number; periodEnd: string };

/** Quarter-end ISO date for a (year, quarter). */
export function quarterEnd(year: number, quarter: number): string {
  const md = { 1: "03-31", 2: "06-30", 3: "09-30", 4: "12-31" }[quarter] ?? "12-31";
  return `${year}-${md}`;
}

/**
 * Latest 13F period that has settled as-of `asOf` (filings land ~45 days after
 * quarter-end). Walks back from the quarter containing `asOf` to the most recent
 * quarter whose period-end + 46-day settlement window is on/before `asOf`.
 */
export function latestSettledQuarter(asOf: Date): QuarterKey {
  let y = asOf.getUTCFullYear();
  let q = Math.floor(asOf.getUTCMonth() / 3) + 1; // quarter containing asOf
  for (let i = 0; i < 8; i++) {
    const endStr = quarterEnd(y, q);
    const settledBy = new Date(new Date(`${endStr}T00:00:00.000Z`).getTime() + 46 * 86_400_000);
    if (settledBy.getTime() <= asOf.getTime()) return { year: y, quarter: q, periodEnd: endStr };
    q -= 1;
    if (q === 0) {
      q = 4;
      y -= 1;
    }
  }
  return { year: y, quarter: q, periodEnd: quarterEnd(y, q) };
}

/** N most-recent settled quarters, newest first. */
export function recentQuarters(count: number, asOf: Date): QuarterKey[] {
  const latest = latestSettledQuarter(asOf);
  const out: QuarterKey[] = [];
  let { year, quarter } = latest;
  for (let i = 0; i < count; i++) {
    out.push({ year, quarter, periodEnd: quarterEnd(year, quarter) });
    quarter -= 1;
    if (quarter === 0) {
      quarter = 4;
      year -= 1;
    }
  }
  return out;
}

/** Collapse raw 13F rows into one long-equity position per symbol. */
function aggregateHoldings(rows: HoldingRow[]): Map<
  string,
  { shares: number; value: number; cusip: string | null; name: string | null; raw: HoldingRow[] }
> {
  const bySymbol = new Map<
    string,
    { shares: number; value: number; cusip: string | null; name: string | null; raw: HoldingRow[] }
  >();
  for (const r of rows) {
    if (!r.symbol) continue; // drop unmapped (foreign/odd) lines
    const entry = bySymbol.get(r.symbol) ?? {
      shares: 0,
      value: 0,
      cusip: r.cusip,
      name: r.nameOfIssuer,
      raw: [],
    };
    entry.raw.push(r);
    // Long common equity only: exclude options (putCallShare set) and non-share
    // types (e.g. PRN = principal/debt). These stay in `raw` for reconciliation.
    const isOption = !!r.putCallShare && r.putCallShare.trim() !== "";
    const isShares = !r.sharesType || r.sharesType.toUpperCase() === "SH";
    if (!isOption && isShares) {
      entry.shares += r.shares;
      entry.value += r.value;
    }
    bySymbol.set(r.symbol, entry);
  }
  // Drop symbols that netted to no long-equity position (pure options lines).
  for (const [sym, e] of bySymbol) {
    if (e.shares <= 0 && e.value <= 0) bySymbol.delete(sym);
  }
  return bySymbol;
}

export type IngestResult = {
  fundsProcessed: number;
  fundsSkipped: string[];
  periodsWritten: number;
  holdingRowsWritten: number;
  failures: string[];
};

export async function runInstitutionalIngest(opts: {
  quarters?: number; // how many recent quarters to (re)ingest (default 12)
  asOf?: Date; // pin "now" (tests / historical runs)
  onlyCik?: string; // limit to one fund (debug)
  log?: (msg: string) => void;
}): Promise<IngestResult> {
  const log = opts.log ?? (() => {});
  const asOf = opts.asOf ?? new Date();
  const quarters = recentQuarters(opts.quarters ?? 12, asOf);
  log(
    `[institutional-ingest] periods ${quarters[quarters.length - 1]!.periodEnd} → ${quarters[0]!.periodEnd} (${quarters.length}q)`,
  );

  const funds = await prisma.institutionalFund.findMany({
    where: { isActive: true, ...(opts.onlyCik ? { cik: opts.onlyCik } : {}) },
    orderBy: { name: "asc" },
  });
  log(`[institutional-ingest] ${funds.length} active funds`);

  const result: IngestResult = {
    fundsProcessed: 0,
    fundsSkipped: [],
    periodsWritten: 0,
    holdingRowsWritten: 0,
    failures: [],
  };

  const pool = await fmpPool(
    funds,
    async (fund) => {
      // Book totals for every quarter in one call.
      let bookByPeriod = new Map<string, FundBookRow>();
      try {
        const books = await fetchFundBookHistory(fund.cik);
        bookByPeriod = new Map(books.map((b) => [b.filingPeriod, b]));
      } catch (e) {
        result.failures.push(`${fund.name} book: ${e instanceof Error ? e.message : String(e)}`);
      }

      let fundWroteAnyPeriod = false;
      for (const qk of quarters) {
        let holdings: HoldingRow[];
        try {
          holdings = await fetchFundHoldings(fund.cik, qk.year, qk.quarter);
        } catch (e) {
          result.failures.push(
            `${fund.name} ${qk.periodEnd}: ${e instanceof Error ? e.message : String(e)}`,
          );
          continue;
        }
        if (holdings.length === 0) continue; // fund did not file this quarter

        const agg = aggregateHoldings(holdings);
        const book = bookByPeriod.get(qk.periodEnd) ?? null;
        // Book denominator: prefer FMP marketValue; else sum of this fund's equity values.
        let bookValue = book?.marketValue ?? null;
        if (!bookValue || bookValue <= 0) {
          bookValue = Array.from(agg.values()).reduce((s, e) => s + e.value, 0) || null;
        }

        const periodDate = new Date(`${qk.periodEnd}T00:00:00.000Z`);
        const holdingRows: Prisma.FundHoldingSnapshotCreateManyInput[] = [];
        for (const [symbol, e] of agg) {
          const firstRaw = e.raw[0]!;
          holdingRows.push({
            fundId: fund.id,
            cik: fund.cik,
            filingPeriod: periodDate,
            ticker: symbol,
            cusip: e.cusip,
            nameOfIssuer: e.name,
            shares: e.shares.toFixed(2),
            value: e.value.toFixed(2),
            pctOfBook: bookValue ? (e.value / bookValue) * 100 : null,
            action: InstitutionalAction.HELD, // real action set by the diff pass
            filingDate: firstRaw.filingDate ? new Date(`${firstRaw.filingDate}T00:00:00.000Z`) : null,
            acceptedDate: firstRaw.acceptedDate
              ? new Date(`${firstRaw.acceptedDate}T00:00:00.000Z`)
              : null,
            rawJson: e.raw as unknown as Prisma.InputJsonValue,
          });
        }

        // Idempotent rewrite of this (fund, period) slice.
        await prisma.$transaction([
          prisma.fundHoldingSnapshot.deleteMany({
            where: { fundId: fund.id, filingPeriod: periodDate },
          }),
          prisma.fundHoldingSnapshot.createMany({ data: holdingRows }),
          prisma.fundBookSnapshot.upsert({
            where: { fundId_filingPeriod: { fundId: fund.id, filingPeriod: periodDate } },
            create: {
              fundId: fund.id,
              cik: fund.cik,
              filingPeriod: periodDate,
              portfolioSize: book?.portfolioSize ?? agg.size,
              marketValue: bookValue ? bookValue.toFixed(2) : null,
              securitiesAdded: book?.securitiesAdded ?? null,
              securitiesRemoved: book?.securitiesRemoved ?? null,
              turnover: book?.turnover ?? null,
              rawJson: (book ?? {}) as unknown as Prisma.InputJsonValue,
            },
            update: {
              portfolioSize: book?.portfolioSize ?? agg.size,
              marketValue: bookValue ? bookValue.toFixed(2) : null,
              securitiesAdded: book?.securitiesAdded ?? null,
              securitiesRemoved: book?.securitiesRemoved ?? null,
              turnover: book?.turnover ?? null,
            },
          }),
        ]);
        result.holdingRowsWritten += holdingRows.length;
        result.periodsWritten += 1;
        fundWroteAnyPeriod = true;
      }

      if (fundWroteAnyPeriod) result.fundsProcessed += 1;
      else result.fundsSkipped.push(fund.name);
      log(`[institutional-ingest] ${fund.name} done`);
      return fund.name;
    },
    { concurrency: 4 },
  );

  for (const f of pool.failures) result.failures.push(`${(f.item as { name: string }).name}: ${f.error}`);
  return result;
}
