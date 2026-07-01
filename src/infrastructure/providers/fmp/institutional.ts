/**
 * Engine 3 — FMP 13F / institutional-ownership provider.
 *
 * Endpoints validated in Phase 0 (scripts/institutional-fmp-validate.ts):
 *   - extract                    per-fund holdings for a period (full, un-paginated)
 *   - holder-performance-summary per-fund book totals across ALL quarters (1 call)
 *   - symbol-positions-summary   market-wide crowding for a symbol/period (context)
 *   - market-capitalization-batch  batched market cap for tier tagging
 *
 * Pure I/O + light normalization. No DB access.
 */
import { fmpGetJson, num, str, isoDate } from "./fmp-client";

// ─── Raw shapes (FMP) ──────────────────────────────────────────────────────
type FmpExtractRaw = {
  date?: string;
  filingDate?: string;
  acceptedDate?: string;
  cik?: string;
  securityCusip?: string;
  symbol?: string;
  nameOfIssuer?: string;
  shares?: number | string;
  titleOfClass?: string;
  sharesType?: string;
  putCallShare?: string;
  value?: number | string;
};

type FmpHolderPerfRaw = {
  date?: string;
  cik?: string;
  investorName?: string;
  portfolioSize?: number | string;
  securitiesAdded?: number | string;
  securitiesRemoved?: number | string;
  marketValue?: number | string;
  turnover?: number | string;
};

type FmpSymbolPositionsRaw = {
  symbol?: string;
  date?: string;
  investorsHolding?: number | string;
  totalInvested?: number | string;
  ownershipPercent?: number | string;
  newPositions?: number | string;
  increasedPositions?: number | string;
  closedPositions?: number | string;
  reducedPositions?: number | string;
};

// ─── Normalized shapes (ours) ──────────────────────────────────────────────
/** One raw 13F line as reported (may be one of several rows for a symbol:
 *  common shares + PUT + CALL + multiple share classes). Aggregation to a
 *  single long-equity position happens in the ingestion layer. */
export type HoldingRow = {
  filingPeriod: string; // YYYY-MM-DD (period-of-report)
  filingDate: string | null;
  acceptedDate: string | null;
  cusip: string | null;
  symbol: string | null;
  nameOfIssuer: string | null;
  shares: number;
  value: number; // reported $ value
  titleOfClass: string | null;
  sharesType: string | null;
  putCallShare: string | null; // "" for common; "Put"/"Call" for options
};

export type FundBookRow = {
  filingPeriod: string; // YYYY-MM-DD
  portfolioSize: number | null;
  marketValue: number | null; // total 13F book $
  securitiesAdded: number | null;
  securitiesRemoved: number | null;
  turnover: number | null;
};

export type SymbolCrowdingRow = {
  symbol: string;
  filingPeriod: string;
  investorsHolding: number | null;
  totalInvested: number | null;
  ownershipPercent: number | null;
};

/**
 * Full holdings for one fund + filing period. Returns every reported row
 * (no pagination — Phase 0 confirmed the endpoint returns the complete list).
 */
export async function fetchFundHoldings(
  cik: string,
  year: number,
  quarter: number,
): Promise<HoldingRow[]> {
  const rows = await fmpGetJson<FmpExtractRaw[]>("/stable/institutional-ownership/extract", {
    cik,
    year,
    quarter,
  });
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    filingPeriod: isoDate(r.date) ?? "",
    filingDate: isoDate(r.filingDate),
    acceptedDate: isoDate(r.acceptedDate),
    cusip: str(r.securityCusip),
    symbol: str(r.symbol)?.toUpperCase() ?? null,
    nameOfIssuer: str(r.nameOfIssuer),
    shares: num(r.shares) ?? 0,
    value: num(r.value) ?? 0,
    titleOfClass: str(r.titleOfClass),
    sharesType: str(r.sharesType),
    putCallShare: str(r.putCallShare),
  }));
}

/**
 * Per-fund book totals across ALL reported quarters (one call). Newest first
 * from FMP; we return normalized rows the caller keys by filingPeriod.
 */
export async function fetchFundBookHistory(cik: string): Promise<FundBookRow[]> {
  const rows = await fmpGetJson<FmpHolderPerfRaw[]>(
    "/stable/institutional-ownership/holder-performance-summary",
    { cik, page: 0 },
  );
  if (!Array.isArray(rows)) return [];
  return rows
    .map((r) => ({
      filingPeriod: isoDate(r.date) ?? "",
      portfolioSize: num(r.portfolioSize),
      marketValue: num(r.marketValue),
      securitiesAdded: num(r.securitiesAdded),
      securitiesRemoved: num(r.securitiesRemoved),
      turnover: num(r.turnover),
    }))
    .filter((r) => r.filingPeriod !== "");
}

/**
 * Market-wide crowding for a symbol + period (ALL ~6,000 institutions, NOT our
 * watchlist). Kept as a secondary context column only. Returns null when absent.
 */
export async function fetchSymbolCrowding(
  symbol: string,
  year: number,
  quarter: number,
): Promise<SymbolCrowdingRow | null> {
  const rows = await fmpGetJson<FmpSymbolPositionsRaw[]>(
    "/stable/institutional-ownership/symbol-positions-summary",
    { symbol, year, quarter },
  );
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return {
    symbol: str(r.symbol)?.toUpperCase() ?? symbol.toUpperCase(),
    filingPeriod: isoDate(r.date) ?? "",
    investorsHolding: num(r.investorsHolding),
    totalInvested: num(r.totalInvested),
    ownershipPercent: num(r.ownershipPercent),
  };
}

type FmpMarketCapRaw = { symbol?: string; marketCap?: number | string };

/**
 * Batched market cap for tier tagging. FMP accepts many symbols per call; we
 * chunk to keep URLs sane. Returns an uppercase-symbol → marketCap map.
 */
export async function fetchMarketCapsBatch(
  symbols: string[],
  chunkSize = 100,
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = Array.from(new Set(symbols.map((s) => s.toUpperCase()))).filter(Boolean);
  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const rows = await fmpGetJson<FmpMarketCapRaw[]>(
      "/stable/market-capitalization-batch",
      { symbols: chunk.join(",") },
    );
    if (Array.isArray(rows)) {
      for (const r of rows) {
        const sym = str(r.symbol)?.toUpperCase();
        const mc = num(r.marketCap);
        if (sym && mc !== null) out.set(sym, mc);
      }
    }
  }
  return out;
}
