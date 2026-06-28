/** EOD price history (used by the Leg-B backtest to measure forward returns). */
import { fmpGetJson, isoDate, num } from "./fmp-client";

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
