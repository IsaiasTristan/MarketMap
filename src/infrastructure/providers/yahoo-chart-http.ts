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
 * Result kind for a Yahoo chart fetch:
 *  - `ok`        — Yahoo returned bars (possibly zero, but the symbol is alive
 *                  enough to answer; the date window may simply not include any
 *                  trading days, e.g. a tail pull on a weekend).
 *  - `delisted`  — Yahoo answered explicitly that the symbol is unknown:
 *                  `chart.error.description` says "No data found, symbol may
 *                  be delisted", or HTTP 404, or HTTP 200 with zero timestamps
 *                  over a >1-year window. Strong delist signal.
 *  - `throttled` — HTTP 401/429/5xx after retries, or fetch threw. Transient.
 */
export type YahooChartResult =
  | { kind: "ok"; bars: Bar[] }
  | { kind: "delisted"; reason: string; bars: [] }
  | { kind: "throttled"; reason: string; bars: [] };

/** Years (rough) covered by the requested window — used to decide whether 0
 *  bars is a hard delist signal vs. a normal short-window pull. */
function windowYears(startIso: string, endIso: string): number {
  const a = new Date(`${startIso}T00:00:00Z`).getTime();
  const b = new Date(`${endIso}T00:00:00Z`).getTime();
  return Math.max(0, (b - a) / (365.25 * 86_400_000));
}

/**
 * Yahoo Finance v8 chart endpoint (EOD, adjusted series when available).
 *
 * Yahoo aggressively rate-limits anonymous traffic (HTTP 401/429 and sometimes
 * a 5xx). We retry a small number of times with exponential backoff so a
 * batch ingest of a few hundred tickers doesn't lose half its results to
 * transient throttling.
 *
 * Returns a typed result so callers can distinguish "ticker is dead" from
 * "Yahoo is being grumpy right now". See `YahooChartResult`.
 */
export async function fetchYahooChartDailyResult(
  ticker: string,
  startIso: string,
  endIso: string
): Promise<YahooChartResult> {
  const p1 = Math.floor(new Date(`${startIso}T00:00:00Z`).getTime() / 1000);
  const p2 = Math.floor(new Date(`${endIso}T23:59:59Z`).getTime() / 1000);
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?period1=${p1}&period2=${p2}&interval=1d`;

  const MAX_ATTEMPTS = 4;
  let lastReason = "";
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
      lastReason = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_ATTEMPTS) {
        return { kind: "throttled", reason: lastReason, bars: [] };
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    // 401 here is Yahoo's throttle response, not a real auth failure.
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      lastReason = `HTTP ${res.status}`;
      if (attempt === MAX_ATTEMPTS) {
        return { kind: "throttled", reason: lastReason, bars: [] };
      }
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    break;
  }
  if (!res) {
    return { kind: "throttled", reason: lastReason || "no response", bars: [] };
  }
  // 404: Yahoo doesn't recognize the symbol — that's a hard delist signal.
  if (res.status === 404) {
    return { kind: "delisted", reason: "HTTP 404", bars: [] };
  }
  if (!res.ok) {
    return { kind: "throttled", reason: `HTTP ${res.status}`, bars: [] };
  }
  const json = (await res.json()) as {
    chart?: { result?: ChartResult[]; error?: { description?: string; code?: string } };
  };
  const errMsg = json.chart?.error?.description ?? "";
  const errCode = json.chart?.error?.code ?? "";
  if (errMsg || errCode) {
    // "No data found, symbol may be delisted" / "Not Found" → delisted.
    // Anything else from Yahoo's error frame is unusual; treat as throttled.
    const lc = errMsg.toLowerCase();
    if (
      lc.includes("delisted") ||
      lc.includes("no data found") ||
      lc.includes("not found") ||
      errCode === "Not Found"
    ) {
      return { kind: "delisted", reason: errMsg || errCode, bars: [] };
    }
    return { kind: "throttled", reason: errMsg || errCode, bars: [] };
  }
  const r0 = json.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];

  if (ts.length === 0) {
    // Empty return over a long history window (>1y) is a hard delist signal;
    // empty over a short tail is not (could just be a holiday week).
    if (windowYears(startIso, endIso) >= 1) {
      return { kind: "delisted", reason: "zero bars in multi-year window", bars: [] };
    }
    return { kind: "ok", bars: [] };
  }

  const adjRow = r0!.indicators?.adjclose?.[0]?.adjclose;
  const q = r0!.indicators?.quote?.[0];
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
  return { kind: "ok", bars: out.sort((a, b) => a.date.localeCompare(b.date)) };
}

// ---------------------------------------------------------------------------
// Intraday (1m / 5m) — used by the per-stock detail chart for the short 1D/5D
// ranges, which the daily PriceHistory table cannot serve. Not persisted; the
// API fetches live and the client caches it briefly via react-query.
// ---------------------------------------------------------------------------

export interface IntradayPoint {
  /** ISO datetime (UTC) of the bar. */
  t: string;
  /** Close price for the bar (raw — Yahoo does not adjust intraday). */
  price: number;
}

export type YahooIntradayResult =
  | { kind: "ok"; points: IntradayPoint[]; previousClose: number | null }
  | { kind: "delisted"; reason: string; points: []; previousClose: null }
  | { kind: "throttled"; reason: string; points: []; previousClose: null };

type IntradayChartResult = {
  timestamp?: number[];
  meta?: { chartPreviousClose?: number; previousClose?: number };
  indicators?: { quote?: { close?: (number | null)[] }[] };
};

/**
 * Fetch intraday bars from Yahoo's v8 chart endpoint using a relative `range`
 * + sub-daily `interval`. Mirrors the retry/backoff policy of the daily fetch.
 *
 *   1D → range=1d, interval=1m
 *   5D → range=5d, interval=5m
 */
export async function fetchYahooIntraday(
  ticker: string,
  range: "1d" | "5d",
): Promise<YahooIntradayResult> {
  const interval = range === "1d" ? "1m" : "5m";
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`;

  const MAX_ATTEMPTS = 4;
  let lastReason = "";
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
      lastReason = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_ATTEMPTS) {
        return { kind: "throttled", reason: lastReason, points: [], previousClose: null };
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      lastReason = `HTTP ${res.status}`;
      if (attempt === MAX_ATTEMPTS) {
        return { kind: "throttled", reason: lastReason, points: [], previousClose: null };
      }
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    break;
  }
  if (!res) {
    return { kind: "throttled", reason: lastReason || "no response", points: [], previousClose: null };
  }
  if (res.status === 404) {
    return { kind: "delisted", reason: "HTTP 404", points: [], previousClose: null };
  }
  if (!res.ok) {
    return { kind: "throttled", reason: `HTTP ${res.status}`, points: [], previousClose: null };
  }

  const json = (await res.json()) as {
    chart?: { result?: IntradayChartResult[]; error?: { description?: string; code?: string } };
  };
  const errMsg = json.chart?.error?.description ?? "";
  const errCode = json.chart?.error?.code ?? "";
  if (errMsg || errCode) {
    const lc = errMsg.toLowerCase();
    if (lc.includes("delisted") || lc.includes("no data found") || lc.includes("not found") || errCode === "Not Found") {
      return { kind: "delisted", reason: errMsg || errCode, points: [], previousClose: null };
    }
    return { kind: "throttled", reason: errMsg || errCode, points: [], previousClose: null };
  }

  const r0 = json.chart?.result?.[0];
  const ts = r0?.timestamp ?? [];
  const closes = r0?.indicators?.quote?.[0]?.close ?? [];
  const previousClose =
    r0?.meta?.chartPreviousClose ?? r0?.meta?.previousClose ?? null;

  const points: IntradayPoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    points.push({ t: new Date(ts[i]! * 1000).toISOString(), price: c });
  }
  return {
    kind: "ok",
    points,
    previousClose: previousClose != null && Number.isFinite(previousClose) ? previousClose : null,
  };
}

/**
 * Throwing wrapper kept for legacy callers (benchmarks etc.) that don't yet
 * care about the typed result. New code should call
 * `fetchYahooChartDailyResult` directly.
 */
export async function fetchYahooChartDaily(
  ticker: string,
  startIso: string,
  endIso: string
): Promise<Bar[]> {
  const r = await fetchYahooChartDailyResult(ticker, startIso, endIso);
  if (r.kind === "throttled") {
    throw new Error(`Yahoo chart throttled for ${ticker}: ${r.reason}`);
  }
  // For `delisted` we return [] rather than throw — benchmarks should never
  // be delisted; equity callers use the typed variant.
  return r.bars;
}
