/** Universe source + reference enrichment (company-screener + profile). */
import { fmpGetJson, num, str } from "./fmp-client";
import type { FmpProfileRaw, FmpScreenerRaw, NormalizedReference } from "./types";

export interface ScreenerFilter {
  marketCapMoreThan?: number;
  exchange?: string; // e.g. "NASDAQ,NYSE,AMEX"
  country?: string; // e.g. "US"
  isActivelyTrading?: boolean;
  isEtf?: boolean;
  isFund?: boolean;
  limit?: number;
}

/** Raw screener pull (one page). Caller paginates / dedupes. */
export async function fetchScreener(filter: ScreenerFilter): Promise<FmpScreenerRaw[]> {
  const rows = await fmpGetJson<FmpScreenerRaw[]>("/stable/company-screener", {
    marketCapMoreThan: filter.marketCapMoreThan,
    exchange: filter.exchange,
    country: filter.country,
    isActivelyTrading: filter.isActivelyTrading,
    isEtf: filter.isEtf,
    isFund: filter.isFund,
    limit: filter.limit ?? 5000,
  });
  return Array.isArray(rows) ? rows : [];
}

/** Map a screener row to a partial reference (no CIK/identifiers — enrich via profile). */
export function screenerToReference(r: FmpScreenerRaw): NormalizedReference {
  return {
    ticker: (r.symbol ?? "").toUpperCase(),
    companyName: str(r.companyName) ?? r.symbol ?? "",
    cik: null,
    sector: str(r.sector),
    subsector: str(r.industry),
    exchange: str(r.exchangeShortName) ?? str(r.exchange),
    country: str(r.country),
    currency: null,
    marketCap: num(r.marketCap),
    identifiers: {},
  };
}

/** Per-symbol profile (CIK / ISIN / CUSIP / currency enrichment). */
export async function fetchProfile(symbol: string): Promise<NormalizedReference | null> {
  const rows = await fmpGetJson<FmpProfileRaw[]>("/stable/profile", { symbol });
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return {
    ticker: (r.symbol ?? symbol).toUpperCase(),
    companyName: str(r.companyName) ?? symbol,
    cik: str(r.cik),
    sector: str(r.sector),
    subsector: str(r.industry),
    exchange: str(r.exchange),
    country: str(r.country),
    currency: str(r.currency),
    marketCap: num(r.marketCap),
    identifiers: { isin: str(r.isin) ?? undefined, cusip: str(r.cusip) ?? undefined },
  };
}
