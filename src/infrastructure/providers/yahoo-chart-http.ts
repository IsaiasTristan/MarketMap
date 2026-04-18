import type { Bar } from "@/infrastructure/providers/market-data";

function toYahooDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

type ChartResult = {
  timestamp?: number[];
  indicators?: {
    adjclose?: { adjclose?: (number | null)[] }[];
    quote?: { close?: (number | null)[]; adjclose?: (number | null)[] }[];
  };
};

/**
 * Yahoo Finance v8 chart endpoint (EOD, adjusted series when available).
 */
export async function fetchYahooChartDaily(
  ticker: string,
  startIso: string,
  endIso: string
): Promise<Bar[]> {
  const p1 = Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000);
  const p2 = Math.floor(new Date(`${endIso}T23:59:59Z`).getTime() / 1000);
  const sym = encodeURIComponent(ticker);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "MarketMap/1.0 (+https://localhost)",
      Accept: "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`Yahoo chart HTTP ${res.status} for ${ticker}`);
  }
  const json = (await res.json()) as {
    chart?: { result?: ChartResult[]; error?: { description?: string } };
  };
  const err = json.chart?.error?.description;
  if (err) throw new Error(err);
  const r0 = json.chart?.result?.[0];
  if (!r0?.timestamp?.length) return [];

  const ts = r0.timestamp;
  const adjRow = r0.indicators?.adjclose?.[0]?.adjclose;
  const q = r0.indicators?.quote?.[0];
  const closes = q?.close;
  const qAdj = q?.adjclose;

  const out: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    const adj =
      adjRow?.[i] ??
      qAdj?.[i] ??
      closes?.[i] ??
      null;
    if (adj == null || !Number.isFinite(adj)) continue;
    const close = closes?.[i];
    out.push({
      date: toYahooDate(t),
      adjClose: adj,
      close: close != null && Number.isFinite(close) ? close : undefined,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
