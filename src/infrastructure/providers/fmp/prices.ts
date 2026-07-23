/** EOD price history (used by the Leg-B backtest to measure forward returns). */
import { fmpGetCsv, fmpGetJson, isoDate, num } from "./fmp-client";

interface FmpEodRaw {
  date?: string;
  close?: number;
  adjClose?: number;
}

export interface EodBar {
  date: string;
  close: number;
}

/** Daily EOD closes for a symbol over [from, to] (YYYY-MM-DD), ascending. */
export async function fetchHistoricalEod(
  symbol: string,
  from: string,
  to: string,
): Promise<EodBar[]> {
  const body = await fmpGetJson<FmpEodRaw[] | { historical?: FmpEodRaw[] }>(
    "/stable/historical-price-eod/full",
    { symbol, from, to },
  );
  const rows = Array.isArray(body) ? body : (body?.historical ?? []);
  return rows
    .map((r): EodBar | null => {
      const date = isoDate(r.date);
      const close = num(r.adjClose ?? r.close);
      if (!date || close === null) return null;
      return { date, close };
    })
    .filter((b): b is EodBar => b !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

interface FmpAdjustedRaw {
  date?: string;
  adjClose?: number;
}

/**
 * Split/dividend-adjusted daily closes for one symbol over [from, to]
 * (YYYY-MM-DD), ascending. Uses FMP's per-symbol dividend-adjusted endpoint
 * (adjClose populated, unlike `/full` which returns raw close only). Runs on
 * the general call budget (~3000/min on Ultimate), so it scales to the whole
 * universe without the strict rate cap of the bulk endpoint — the reliable
 * backbone for the daily tape and the reconcile fallback for bulk gaps.
 */
export async function fetchFmpEodAdjusted(
  symbol: string,
  from: string,
  to: string,
): Promise<{ date: string; adjClose: number }[]> {
  const body = await fmpGetJson<
    FmpAdjustedRaw[] | { historical?: FmpAdjustedRaw[] }
  >("/stable/historical-price-eod/dividend-adjusted", { symbol, from, to });
  const rows = Array.isArray(body) ? body : (body?.historical ?? []);
  return rows
    .map((r): { date: string; adjClose: number } | null => {
      const date = isoDate(r.date);
      const adjClose = num(r.adjClose);
      if (!date || adjClose === null || adjClose <= 0) return null;
      return { date, adjClose };
    })
    .filter((b): b is { date: string; adjClose: number } => b !== null)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** One split/dividend-adjusted daily bar from the bulk-EOD endpoint. */
export interface EodBulkBar {
  /** Raw close. */
  close: number;
  /** Split/dividend-adjusted close (bulk supplies this explicitly). */
  adjClose: number;
}

/** CSV columns returned by /stable/eod-bulk (a subset we consume). */
interface FmpEodBulkRow {
  symbol?: string;
  date?: string;
  close?: string;
  adjClose?: string;
}

/**
 * Whole-universe adjusted EOD for a single date via FMP's Ultimate-tier
 * bulk endpoint. One request returns every listed symbol globally (~60k rows),
 * so the daily price tape for our ~2,900-name universe costs a handful of
 * calls instead of ~2,900 per-symbol requests — the fix for the Yahoo
 * anonymous-endpoint throttle that leaves half the universe stale.
 *
 * `wanted`, when provided, restricts the returned Map to those upper-cased
 * symbols so we don't retain the full global payload. Keys are the FMP symbol
 * (upper-cased); callers normalise their tickers (class-share `.`→`-`) to match.
 * Returns an empty Map for non-trading days (the endpoint yields no rows).
 */
export async function fetchFmpEodBulkByDate(
  date: string,
  wanted?: ReadonlySet<string>,
): Promise<Map<string, EodBulkBar>> {
  const rows = await fmpGetCsv<FmpEodBulkRow>("/stable/eod-bulk", { date });
  return parseEodBulkRows(rows, wanted);
}

/**
 * Pure parser for bulk-EOD CSV rows → Map keyed by upper-cased symbol.
 * Restricts to `wanted` symbols when provided, prefers `adjClose` (falling
 * back to `close`), and drops rows with a non-positive adjusted close.
 */
export function parseEodBulkRows(
  rows: FmpEodBulkRow[],
  wanted?: ReadonlySet<string>,
): Map<string, EodBulkBar> {
  const out = new Map<string, EodBulkBar>();
  for (const r of rows) {
    const sym = r.symbol?.trim().toUpperCase();
    if (!sym) continue;
    if (wanted && !wanted.has(sym)) continue;
    const close = num(r.close);
    const adjClose = num(r.adjClose) ?? close;
    if (adjClose === null || adjClose <= 0) continue;
    out.set(sym, { close: close ?? adjClose, adjClose });
  }
  return out;
}
