/**
 * Engine 2 — current quote (price + shares + market cap). Used to compute the
 * point-in-time enterprise value and valuation multiples on the snapshot date.
 */
import { fmpGetJson, num } from "./fmp-client";
import type { FmpQuoteRaw, NormalizedQuote } from "./types";

export async function fetchQuote(symbol: string): Promise<NormalizedQuote | null> {
  const rows = await fmpGetJson<FmpQuoteRaw[]>("/stable/quote", { symbol });
  const r = Array.isArray(rows) ? rows[0] : undefined;
  if (!r) return null;
  return {
    ticker: symbol.toUpperCase(),
    price: num(r.price),
    marketCap: num(r.marketCap),
    sharesOutstanding: num(r.sharesOutstanding),
  };
}
