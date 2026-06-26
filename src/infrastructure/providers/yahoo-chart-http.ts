import type { Bar } from "@/infrastructure/providers/market-data";
import {
  composeCurrentSparkline,
  priorDaySettlementClose,
  splitIntradayByEtDate,
  splitIntradaySessions,
  todaySettlementSeries,
} from "@/lib/holdings/intraday-split";
import { classifyEtTimeOfDay, tradeDateEtFromUnix } from "@/lib/market-map/market-session";

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
  options: { includePrePost?: boolean } = {},
): Promise<YahooIntradayResult> {
  const interval = range === "1d" ? "1m" : "5m";
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const includePrePost = options.includePrePost ? "true" : "false";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=${includePrePost}`;

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

// ---------------------------------------------------------------------------
// Live quote snapshot (with optional intraday sparkline) via the v8 chart
// endpoint.
//
// Yahoo's v7 quote endpoint (`/v7/finance/quote`) now requires a session
// crumb/cookie pair and returns HTTP 401 to anonymous traffic. The v8 chart
// endpoint stays open and a single `range=1d&interval=5m` call gives us
// everything the market ticker strip needs:
//   - `meta.regularMarketPrice`    — live tape (or last close when shut)
//   - `meta.previousClose`         — the prior trading-day's regular close
//                                    (range-independent; preferred for 1D return)
//   - `meta.chartPreviousClose`    — close before the chart window start
//                                    (== previousClose only on a 1d range)
//   - `indicators.quote[0].close`  — today's 5-minute closes (the sparkline)
// ---------------------------------------------------------------------------

type QuoteChartResult = {
  timestamp?: number[];
  meta?: {
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    shortName?: string;
    longName?: string;
  };
  indicators?: { quote?: { close?: (number | null)[] }[] };
};

/** Soft cap on intraday points returned per instrument. 80 points is plenty
 *  for a 60px-wide sparkline and keeps the JSON payload compact across 12+
 *  instruments. Decimation is by stride, preserving the first/last samples. */
const SPARKLINE_MAX_POINTS = 80;

function decimate(arr: number[], maxLen: number): number[] {
  if (arr.length <= maxLen) return arr;
  const stride = Math.ceil(arr.length / maxLen);
  const out: number[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]!);
  // Always include the most recent point so the sparkline ends at "now".
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]!);
  return out;
}

export interface YahooStripQuote {
  price: number;
  prevClose: number;
  /** Company display name when present in chart meta. */
  displayName?: string;
  /** Today's 5-minute closes, oldest -> newest, nulls stripped, capped to
   *  `SPARKLINE_MAX_POINTS`. Empty when no intraday data is available
   *  (off-hours weekend on equity-only instruments etc.). */
  intradayCloses: number[];
  /** Prior US trading session closes (holdings dashboard Previous Price). */
  prevDayCloses: number[];
  /** PRE/POST tail for Current Price (dashed gray in UI). */
  extendedCloses: number[];
  /** First intraday print (session open proxy). */
  dayOpen: number;
  /** Intraday low from today's bar series. */
  dayLow: number;
  /** Intraday high from today's bar series. */
  dayHigh: number;
}

export type StripPrevCloseMode = "regular" | "settlement";

function buildStripQuoteFromChart(
  r0: QuoteChartResult,
  intradayCloses: number[],
  prevDayCloses: number[],
  options?: {
    allowSessionPrevClose?: boolean;
    extendedCloses?: number[];
    prevCloseMode?: StripPrevCloseMode;
    settlementPrevClose?: number | null;
    settlementLivePrice?: number | null;
  },
): YahooStripQuote | null {
  const meta = r0.meta ?? {};
  const settlementMode = options?.prevCloseMode === "settlement";

  let prevClose: number | null = null;
  if (
    settlementMode &&
    options?.settlementPrevClose != null &&
    Number.isFinite(options.settlementPrevClose)
  ) {
    prevClose = options.settlementPrevClose;
  } else if (Number.isFinite(meta.previousClose)) {
    // `previousClose` is the genuine prior regular-session close regardless of the
    // requested chart range. `chartPreviousClose` is anchored to the bar before the
    // window start, so on a multi-day range (e.g. the holdings 1mo pull) it is the
    // close from ~1 range ago, not yesterday — using it would turn a 1D return into
    // a multi-day return. Prefer `previousClose`; they are equal on a 1d range.
    prevClose = meta.previousClose as number;
  } else if (Number.isFinite(meta.chartPreviousClose)) {
    prevClose = meta.chartPreviousClose as number;
  }
  if (
    (prevClose == null || !Number.isFinite(prevClose)) &&
    options?.allowSessionPrevClose &&
    prevDayCloses.length > 0
  ) {
    prevClose = prevDayCloses[prevDayCloses.length - 1]!;
  }
  if (prevClose == null || !Number.isFinite(prevClose)) return null;

  const allSessionCloses = [...intradayCloses, ...(options?.extendedCloses ?? [])];
  let price: number;
  if (settlementMode) {
    if (
      options?.settlementLivePrice != null &&
      Number.isFinite(options.settlementLivePrice)
    ) {
      price = options.settlementLivePrice;
    } else if (allSessionCloses.length > 0) {
      price = allSessionCloses[allSessionCloses.length - 1]!;
    } else if (Number.isFinite(meta.regularMarketPrice)) {
      price = meta.regularMarketPrice as number;
    } else {
      price = prevClose;
    }
  } else {
    price = Number.isFinite(meta.regularMarketPrice)
      ? (meta.regularMarketPrice as number)
      : intradayCloses.length > 0
        ? intradayCloses[intradayCloses.length - 1]!
        : prevClose;
  }

  const dayOpen =
    intradayCloses.length > 0
      ? intradayCloses[0]!
      : allSessionCloses.length > 0
        ? allSessionCloses[0]!
        : price;
  const dayLow =
    allSessionCloses.length > 0 ? Math.min(...allSessionCloses) : price;
  const dayHigh =
    allSessionCloses.length > 0 ? Math.max(...allSessionCloses) : price;

  const displayName =
    (typeof meta.longName === "string" && meta.longName.trim()) ||
    (typeof meta.shortName === "string" && meta.shortName.trim()) ||
    undefined;

  return {
    price,
    prevClose,
    displayName,
    intradayCloses,
    prevDayCloses,
    extendedCloses: options?.extendedCloses ?? [],
    dayOpen,
    dayLow,
    dayHigh,
  };
}

async function fetchQuoteChartResult(
  ticker: string,
  range: "1d" | "5d" | "1mo",
  options: { includePrePost?: boolean } = {},
): Promise<QuoteChartResult | null> {
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  const includePrePost = options.includePrePost ? "true" : "false";
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=5m&includePrePost=${includePrePost}`;

  const MAX_ATTEMPTS = 3;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "MarketMap/1.0 (+https://localhost)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) return null;
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) return null;
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    break;
  }
  if (!res || !res.ok) return null;

  const json = (await res.json()) as {
    chart?: { result?: QuoteChartResult[]; error?: unknown };
  };
  return json.chart?.result?.[0] ?? null;
}

/** Prior regular-session intraday sparkline + prior close for one ticker.
 *  Fetched from a `5d` chart so the latest prior session is reachable across
 *  weekends / holidays. Used by the prior-session sparkline cache sweep. */
export interface YahooPriorSession {
  prevDayCloses: number[];
  prevClose: number;
  /** ET calendar date (yyyy-MM-dd) the prior-session bars belong to, if known. */
  asOfDate: string | null;
}

export async function fetchYahooPriorSession(
  ticker: string,
): Promise<YahooPriorSession | null> {
  const r0 = await fetchQuoteChartResult(ticker, "5d", { includePrePost: false });
  if (!r0) return null;

  const ts = r0.timestamp ?? [];
  const rawCloses = r0.indicators?.quote?.[0]?.close ?? [];
  const { prevDayCloses } = splitIntradayByEtDate(ts, rawCloses);
  if (prevDayCloses.length < 2) return null;

  const meta = r0.meta ?? {};
  const prevClose = Number.isFinite(meta.previousClose)
    ? (meta.previousClose as number)
    : Number.isFinite(meta.chartPreviousClose)
      ? (meta.chartPreviousClose as number)
      : prevDayCloses[prevDayCloses.length - 1]!;

  return { prevDayCloses, prevClose, asOfDate: null };
}

/** Company display name from chart meta (`longName` preferred). Small `1d`
 *  daily-bar call — used by the one-time name backfill. Returns null when no
 *  usable name is present or the fetch is throttled / fails. */
export async function fetchYahooDisplayName(ticker: string): Promise<string | null> {
  const r0 = await fetchQuoteChartResult(ticker, "1d");
  if (!r0) return null;
  const meta = r0.meta ?? {};
  const name =
    (typeof meta.longName === "string" && meta.longName.trim()) ||
    (typeof meta.shortName === "string" && meta.shortName.trim()) ||
    null;
  return name || null;
}

async function fetchYahooQuoteWithSparkline(
  ticker: string,
  prevCloseMode: StripPrevCloseMode = "regular",
): Promise<YahooStripQuote | null> {
  const r0 = await fetchQuoteChartResult(ticker, "5d", { includePrePost: true });
  if (!r0) return null;
  return buildHoldingsSparklineQuote(r0, { prevCloseMode });
}

function buildHoldingsSparklineQuote(
  r0: QuoteChartResult,
  options: { prevCloseMode?: StripPrevCloseMode } = {},
): YahooStripQuote | null {
  const ts = r0.timestamp ?? [];
  const rawCloses = r0.indicators?.quote?.[0]?.close ?? [];
  const { prevDayCloses } = splitIntradayByEtDate(ts, rawCloses);

  if (options.prevCloseMode === "settlement") {
    const settlement = todaySettlementSeries(ts, rawCloses);
    return buildStripQuoteFromChart(r0, settlement.regular, prevDayCloses, {
      allowSessionPrevClose: true,
      extendedCloses: settlement.extended,
      prevCloseMode: "settlement",
      settlementPrevClose: priorDaySettlementClose(ts, rawCloses),
      settlementLivePrice: settlement.livePrice,
    });
  }

  const sessions = splitIntradaySessions(ts, rawCloses);
  const { regular, extended } = composeCurrentSparkline(sessions);

  return buildStripQuoteFromChart(r0, regular, prevDayCloses, {
    allowSessionPrevClose: true,
    extendedCloses: extended,
  });
}

/**
 * Holdings dashboard: today's regular + extended (PRE/POST) sparkline from one
 * small `1d` chart call. The prior-session ("Previous Price") sparkline is NOT
 * pulled here — it is served from the daily prior-session cache so we don't
 * re-fetch immutable data on every 20s refresh. `meta.previousClose` on the
 * `1d` range still gives the correct prior close for 1D-return colouring.
 */
async function fetchYahooQuoteWithSparklineHoldingsToday(
  ticker: string,
): Promise<YahooStripQuote | null> {
  const r0 = await fetchQuoteChartResult(ticker, "1d", { includePrePost: true });
  if (!r0) return null;
  return buildHoldingsSparklineQuote(r0);
}

/**
 * Batch quote + intraday-sparkline snapshot via the v8 chart endpoint.
 *
 * Returns a Map keyed by the Yahoo-normalised symbol. Each entry carries the
 * live price, the prior trading-day close, and today's decimated 5-minute
 * close series (capped at `SPARKLINE_MAX_POINTS`).
 *
 * Requests run in parallel: callers are expected to keep `tickers` short
 * (~12 instruments for the market strip) or apply their own worker pool.
 */
export async function fetchYahooQuotesWithSparkline(
  tickers: string[],
  options?: { settlementSymbols?: ReadonlySet<string> },
): Promise<Map<string, YahooStripQuote>> {
  const out = new Map<string, YahooStripQuote>();
  const results = await Promise.all(
    tickers.map(async (t) => {
      const sym = toYahooSymbol(t);
      const mode = options?.settlementSymbols?.has(sym) ? "settlement" : "regular";
      const q = await fetchYahooQuoteWithSparkline(t, mode);
      return q ? { sym, q } : null;
    }),
  );
  for (const r of results) {
    if (r) out.set(r.sym, r.q);
  }
  return out;
}

/**
 * Batch quote + sparkline fetch with bounded concurrency (Overview holdings).
 * Keys by Yahoo-normalised symbol, same as {@link fetchYahooQuotesWithSparkline}.
 */
export async function fetchYahooQuotesWithSparklinePool(
  tickers: string[],
  options: { concurrency?: number; perRequestDelayMs?: number } = {},
): Promise<Map<string, YahooStripQuote>> {
  const concurrency = options.concurrency ?? 5;
  const delay = options.perRequestDelayMs ?? 150;
  const out = new Map<string, YahooStripQuote>();
  const queue = [...tickers];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      const t = queue[idx]!;
      try {
        const q = await fetchYahooQuoteWithSparklineHoldingsToday(t);
        if (q) out.set(toYahooSymbol(t), q);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[yahoo-sparkline] ${t}: ${msg} — continuing batch`);
      }
      if (delay > 0) await sleep(delay);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * @deprecated Use `fetchYahooQuotesWithSparkline` instead — same Map shape
 * plus an `intradayCloses` field for the sparkline. This thin wrapper is kept
 * only for any future caller that wants quote-only with no intraday tail.
 */
export async function fetchYahooQuotesViaChart(
  tickers: string[],
): Promise<Map<string, { price: number; prevClose: number }>> {
  const full = await fetchYahooQuotesWithSparkline(tickers);
  const out = new Map<string, { price: number; prevClose: number }>();
  for (const [sym, q] of full) {
    out.set(sym, { price: q.price, prevClose: q.prevClose });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Extended-hours quote — Yahoo v8 chart with `includePrePost=true`. Returns
// the latest non-null print along with the session that print falls into
// (PRE / REGULAR / POST). Used by the server-side extended-hours sweep to
// overlay today's pre/post-market move onto the market-map grid without
// persisting anything to the daily PriceHistory table.
// ---------------------------------------------------------------------------

/** Subset of Yahoo's `meta.currentTradingPeriod` used to classify a bar's session. */
export interface YahooTradingPeriodWindow {
  start: number; // epoch seconds
  end: number; // epoch seconds
}

export interface YahooCurrentTradingPeriod {
  pre?: YahooTradingPeriodWindow;
  regular?: YahooTradingPeriodWindow;
  post?: YahooTradingPeriodWindow;
}

/**
 * Result of parsing one Yahoo extended-hours chart response.
 *   - `price`: most recent non-null close in the bar series
 *   - `session`: which trading-period window that bar's timestamp falls into
 *   - `asOfUnix`: bar timestamp (epoch seconds), used for staleness / display
 *   - `prevClose`: prior regular-session close (`meta.chartPreviousClose`)
 *     — handy when callers want to compute a % change directly
 *   - `regularClose`: today's regular-session close if available
 *     (`meta.regularMarketPrice` captured at 16:00 ET). When POST is active
 *     this is "today's close" used as the basis for the post-market move.
 */
export interface YahooExtendedQuote {
  price: number;
  session: "PRE" | "REGULAR" | "POST";
  asOfUnix: number;
  prevClose: number | null;
  regularClose: number | null;
}

type ExtendedChartResult = {
  meta?: {
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    currentTradingPeriod?: YahooCurrentTradingPeriod;
  };
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
};

/**
 * Pure parser — given a single Yahoo v8 chart result fetched with
 * `includePrePost=true`, return the latest PRE or POST print, or null if
 * none exists. REGULAR-session bars are skipped when walking backward so a
 * 4pm close does not mask an earlier after-hours print (GLW case).
 */
export function parseYahooExtendedQuote(
  r0: ExtendedChartResult | null | undefined,
): YahooExtendedQuote | null {
  if (!r0) return null;
  const ts = r0.timestamp ?? [];
  const closes = r0.indicators?.quote?.[0]?.close ?? [];
  if (ts.length === 0) return null;

  const period = r0.meta?.currentTradingPeriod;

  // Walk back from the end for the latest finite PRE/POST bar.
  let idx = -1;
  for (let i = ts.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c)) continue;
    const unix = ts[i] as number;
    const session = classifyBarSession(unix, period);
    if (session === "PRE" || session === "POST") {
      idx = i;
      break;
    }
  }
  if (idx < 0) return null;

  let price = closes[idx] as number;
  let asOfUnix = ts[idx] as number;
  const session = classifyBarSession(asOfUnix, period);

  const meta = r0.meta ?? {};
  const prevClose =
    meta.chartPreviousClose != null && Number.isFinite(meta.chartPreviousClose)
      ? (meta.chartPreviousClose as number)
      : meta.previousClose != null && Number.isFinite(meta.previousClose)
        ? (meta.previousClose as number)
        : null;

  let regularClose: number | null = null;
  if (session === "POST") {
    if (
      period?.post &&
      asOfUnix >= period.post.start &&
      asOfUnix < period.post.end &&
      meta.regularMarketPrice != null &&
      Number.isFinite(meta.regularMarketPrice)
    ) {
      regularClose = meta.regularMarketPrice as number;
    } else {
      const barTradeDate = tradeDateEtFromUnix(asOfUnix);
      for (let j = idx - 1; j >= 0; j--) {
        const cj = closes[j];
        if (cj == null || !Number.isFinite(cj)) continue;
        const uj = ts[j] as number;
        if (tradeDateEtFromUnix(uj) !== barTradeDate) break;
        if (classifyBarSession(uj, period) === "REGULAR") {
          regularClose = cj as number;
          break;
        }
      }
    }
  }

  // POST: when the chronologically last tick is a stale outlier but an earlier
  // same-day POST print sits near regular close, prefer the nearer print
  // (JACK: $13 last tick vs $12.84 cluster near the $12.82 close).
  if (
    session === "POST" &&
    regularClose != null &&
    regularClose > 0 &&
    Number.isFinite(regularClose)
  ) {
    const tradeDate = tradeDateEtFromUnix(asOfUnix);
    const latestPrice = price;
    const isPostBar = (u: number) => classifyEtTimeOfDay(u) === "POST";
    let maxPostMove = 0;
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c)) continue;
      const u = ts[i] as number;
      if (tradeDateEtFromUnix(u) !== tradeDate) continue;
      if (!isPostBar(u)) continue;
      maxPostMove = Math.max(
        maxPostMove,
        Math.abs((c as number) / regularClose - 1),
      );
    }
    let bestIdx = idx;
    let bestDist = Math.abs(latestPrice - regularClose);
    for (let i = 0; i < ts.length; i++) {
      const c = closes[i];
      if (c == null || !Number.isFinite(c)) continue;
      const u = ts[i] as number;
      if (tradeDateEtFromUnix(u) !== tradeDate) continue;
      if (!isPostBar(u)) continue;
      const cp = c as number;
      if (
        maxPostMove > 0.02 &&
        Math.abs(cp / regularClose - 1) < 0.001
      ) {
        continue;
      }
      const dist = Math.abs(cp - regularClose);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    const bestPrice = closes[bestIdx] as number;
    const latestMove = Math.abs(latestPrice / regularClose - 1);
    const bestMove = Math.abs(bestPrice / regularClose - 1);
    // Only reject the last tick when a near-close print exists — real AH
    // movers (ON −7%) stay on the chronologically latest bar.
    if (
      latestMove > 0.005 &&
      bestMove < 0.005 &&
      latestMove - bestMove > 0.01
    ) {
      price = bestPrice;
      asOfUnix = ts[bestIdx] as number;
    }
  }

  return { price, session, asOfUnix, prevClose, regularClose };
}

/**
 * Classify an epoch-seconds bar timestamp into PRE / REGULAR / POST.
 *
 * Primary: Yahoo's `currentTradingPeriod` (the only reliable source on early
 * closes / holidays). The windows describe TODAY's sessions in epoch seconds,
 * so when a bar matches one of them we trust it.
 *
 * Fallback: ET time-of-day classification — used when no window matches the
 * bar (the common case for a `range=5d` backfill query reaching back to
 * yesterday's POST or Friday's POST during a weekend boot). Without this
 * fallback every prior-day bar would silently default to REGULAR and the
 * sweep would drop it.
 */
function classifyBarSession(
  unix: number,
  period: YahooCurrentTradingPeriod | undefined,
): "PRE" | "REGULAR" | "POST" {
  if (period) {
    if (period.pre && unix >= period.pre.start && unix < period.pre.end) {
      return "PRE";
    }
    if (
      period.regular &&
      unix >= period.regular.start &&
      unix < period.regular.end
    ) {
      return "REGULAR";
    }
    if (period.post && unix >= period.post.start && unix < period.post.end) {
      return "POST";
    }
  }
  return classifyEtTimeOfDay(unix);
}

/**
 * Fetch one extended-hours quote. Reuses the same retry/backoff policy as
 * the rest of the file. Returns null on a non-recoverable error (delisted /
 * persistent throttle / parse failure) so the batch worker can skip the
 * symbol without aborting.
 *
 * `range` controls how far back Yahoo searches:
 *   - "1d" (default): today's bars only — used during PRE/POST when we want
 *     the freshest print and don't care about anything older.
 *   - "5d": last 5 trading days of bars — used during CLOSED-startup
 *     backfill so we can recover the most recent POST print whether it was
 *     earlier tonight or last Friday (weekend boot).
 */
export async function fetchYahooExtendedQuote(
  ticker: string,
  range: "1d" | "5d" = "1d",
): Promise<YahooExtendedQuote | null> {
  const sym = encodeURIComponent(toYahooSymbol(ticker));
  // 5-minute bars give a fine enough granularity that the "latest non-null
  // close" is at most 5 minutes stale during an active session; `range`
  // widens the search window for backfill (see JSDoc above).
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=5m&includePrePost=true`;

  const MAX_ATTEMPTS = 3;
  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "MarketMap/1.0 (+https://localhost)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      if (attempt === MAX_ATTEMPTS) return null;
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) return null;
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    break;
  }
  if (!res || !res.ok) return null;

  let json: { chart?: { result?: ExtendedChartResult[] } };
  try {
    json = (await res.json()) as { chart?: { result?: ExtendedChartResult[] } };
  } catch {
    return null;
  }
  const parsed = parseYahooExtendedQuote(json.chart?.result?.[0]);
  // #region agent log
  if (
    parsed &&
    (ticker === "JACK" ||
      (parsed.regularClose != null &&
        Math.abs(parsed.price / parsed.regularClose - 1) > 0.08))
  ) {
    fetch("http://127.0.0.1:7864/ingest/5261ce70-61cd-4eee-b332-43aa363b10f4", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Debug-Session-Id": "8f19ae",
      },
      body: JSON.stringify({
        sessionId: "8f19ae",
        location: "yahoo-chart-http.ts:fetchYahooExtendedQuote",
        message: "yahoo extended fetch",
        data: {
          ticker,
          price: parsed.price,
          session: parsed.session,
          regularClose: parsed.regularClose,
          prevClose: parsed.prevClose,
          asOfIso: new Date(parsed.asOfUnix * 1000).toISOString(),
          impliedAhPct:
            parsed.regularClose != null
              ? parsed.price / parsed.regularClose - 1
              : null,
        },
        timestamp: Date.now(),
        hypothesisId: "H2",
      }),
    }).catch(() => {});
  }
  // #endregion
  return parsed;
}

/**
 * Batch extended-hours quote fetch with a bounded-concurrency worker pool,
 * mirroring the universe-ingest pattern (low concurrency + small per-request
 * delay) so we don't burst Yahoo's anonymous endpoint into HTTP 429.
 *
 * Returns a Map keyed by the INPUT ticker (not the Yahoo-normalised symbol)
 * so callers don't have to re-normalise — extended-hours overlay matches
 * back to universe constituents by their user-facing ticker.
 */
export async function fetchYahooExtendedQuotes(
  tickers: string[],
  options: {
    concurrency?: number;
    perRequestDelayMs?: number;
    /** Yahoo `range` window — "1d" for live sweeps, "5d" for backfill (see
     *  `fetchYahooExtendedQuote`). Defaults to "1d". */
    range?: "1d" | "5d";
  } = {},
): Promise<Map<string, YahooExtendedQuote>> {
  const concurrency = options.concurrency ?? 5;
  const delay = options.perRequestDelayMs ?? 150;
  const range = options.range ?? "1d";
  const out = new Map<string, YahooExtendedQuote>();
  const queue = [...tickers];
  let cursor = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= queue.length) return;
      const t = queue[idx]!;
      try {
        const q = await fetchYahooExtendedQuote(t, range);
        if (q) out.set(t, q);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[extended-quote] ${t}: ${msg} — continuing batch`);
      }
      if (delay > 0) await sleep(delay);
    }
  });
  await Promise.all(workers);
  return out;
}
