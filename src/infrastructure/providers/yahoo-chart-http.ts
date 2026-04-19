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
 * Convert our internal ticker convention to Yahoo's URL form. We only rewrite
 * cases we know about so we don't break legitimate Yahoo symbols:
 *   - Explicit overrides for tickers whose canonical form on Yahoo differs
 *     from the user-facing symbol (e.g. delisted ADRs, futures-backed indices).
 *   - Single-letter class share suffix:   BRK.B → BRK-B, BF.A → BF-A
 *   - Bare US index codes Yahoo prefixes with `^`: VIX → ^VIX, SPX → ^SPX,
 *     NDX → ^NDX, VVIX → ^VVIX
 *   - Foreign exchange suffix dots are LEFT intact (e.g. MC.PA, NOVO-B.CO).
 */
const KNOWN_BARE_INDEX_CODES = new Set([
  "VIX",
  "VVIX",
  "SPX",
  "NDX",
  "RUT",
  "DJI",
  "OEX",
  "GSPC",
  "IXIC",
  "TNX",
  "TYX",
  "FVX",
  "IRX",
]);

/**
 * Tickers whose Yahoo chart symbol is something other than "the same string"
 * or the simple `^TICKER` index form. Yahoo returns 0 bars (or 404) for the
 * naïve mapping, so we route to the symbol that actually serves data:
 *   - DXY  → DX-Y.NYB  (`^DXY` chart endpoint returns no bars; ICE-NYBOT
 *                       futures snapshot is the only series with history.)
 *   - ABB  → ABBNY     (ABB Ltd delisted its NYSE ADR in May 2023 and now
 *                       trades on the OTC market under ABBNY.)
 */
const YAHOO_SYMBOL_OVERRIDES: Record<string, string> = {
  DXY: "DX-Y.NYB",
  ABB: "ABBNY",
};

export function toYahooSymbol(ticker: string): string {
  const t = ticker.trim().toUpperCase();
  const override = YAHOO_SYMBOL_OVERRIDES[t];
  if (override) return override;
  if (KNOWN_BARE_INDEX_CODES.has(t)) return `^${t}`;
  // Class-share rewrite: "BRK.B" → "BRK-B" (only for a single trailing letter).
  return t.replace(/\.([A-Z])$/, "-$1");
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Yahoo Finance v8 chart endpoint (EOD, adjusted series when available).
 *
 * Yahoo aggressively rate-limits anonymous traffic (HTTP 401/429 and sometimes
 * a 5xx). We retry a small number of times with exponential backoff so a
 * batch ingest of a few hundred tickers doesn't lose half its results to
 * transient throttling.
 */
export async function fetchYahooChartDaily(
  ticker: string,
  startIso: string,
  endIso: string
): Promise<Bar[]> {
  const p1 = Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000);
  const p2 = Math.floor(new Date(`${endIso}T23:59:59Z`).getTime() / 1000);
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;

  const MAX_ATTEMPTS = 4;
  let lastErr: unknown;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "MarketMap/1.0 (+https://localhost)",
          Accept: "application/json",
        },
      });
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) throw e;
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    // 401 here is Yahoo's throttle response, not a real auth failure.
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Yahoo chart HTTP ${res.status} for ${ticker}`);
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    break;
  }
  if (!res) throw lastErr ?? new Error(`Yahoo chart fetch failed for ${ticker}`);
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
