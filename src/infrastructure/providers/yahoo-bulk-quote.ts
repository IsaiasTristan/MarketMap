/**
 * Bulk live-quote provider via Yahoo's anonymous v8 `spark` endpoint.
 *
 * The market-map REGULAR-hours overlay needs today's live price + the prior
 * regular close for every active universe ticker (~2000) on a 60s cadence.
 * Issuing one chart request per ticker (the extended-hours pattern) does not
 * scale to that count, so we use the `spark` multi-symbol endpoint:
 *
 *   GET /v8/finance/spark?symbols=AAPL,MSFT,...&range=1d&interval=1d
 *
 * which returns one aggregated bar per symbol in a single request. Yahoo caps
 * the endpoint at 20 symbols/request (HTTP 400 "Number of symbols needs to be
 * less than or equal to 20" above that), so we chunk at 20 and run the chunks
 * through a small concurrent worker pool to keep a full ~2000-ticker sweep
 * comfortably inside the runner's 60s cadence.
 *
 * Spark is currently reachable anonymously (HTTP 200) and returns
 * `chartPreviousClose` (prior regular close) + a single `close` (live tape),
 * so no cookie/crumb handshake is needed. The v7 `quote` endpoint now returns
 * 401 to anonymous traffic; a cookie+crumb fallback for v7 is a documented
 * follow-up (see AGENTS.md) but is intentionally NOT built here. The
 * `servedVia` field is carried through so a future fallback and runtime
 * monitoring can report which path served each sweep.
 */
import { toYahooSymbol } from "@/infrastructure/providers/yahoo-chart-http";

/** One live quote for a single ticker. */
export interface BulkQuote {
  /** Latest live print (regular-session tape). */
  price: number;
  /** Prior regular-session close (basis for the 1D return). */
  prevClose: number;
  /** Bar timestamp (epoch seconds) — used to derive the ET trade date. */
  asOfUnix: number;
}

/** Which upstream path served the quotes. Only `spark` is wired today. */
export type ServedVia = "spark" | "crumb" | "mixed";

export interface BulkQuoteResult {
  /** Keyed by the INPUT ticker (not the Yahoo-normalised symbol). */
  quotes: Map<string, BulkQuote>;
  servedVia: ServedVia;
  /** Input tickers that produced no usable quote. */
  failed: string[];
}

/** Symbols per spark request. Yahoo rejects requests with more than 20 symbols
 *  (HTTP 400), so this is a hard upstream cap, not a tunable. */
const CHUNK_SIZE = 20;
/** Concurrent chunk requests. ~2871 tickers / 20 = ~144 chunks; at 5 workers a
 *  full sweep finishes in ~15-20s, well inside the runner's 60s cadence. */
const CONCURRENCY = 5;
/** Per-worker politeness gap between chunk requests so a full sweep does not
 *  burst Yahoo into HTTP 429. */
const CHUNK_DELAY_MS = 150;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Per-symbol shape inside a spark response (flat or legacy-wrapped). */
interface SparkSymbol {
  symbol?: string;
  close?: (number | null)[] | null;
  previousClose?: number | null;
  chartPreviousClose?: number | null;
  timestamp?: (number | null)[] | null;
}

/**
 * Pure parser for a spark JSON body. Handles both the current flat shape
 * (`{ "AAPL": {...}, "MSFT": {...} }`) and the legacy wrapped shape
 * (`{ spark: { result: [{ symbol, response: [{ meta, timestamp, indicators }] }] } }`).
 * Returns a Map keyed by the Yahoo symbol; callers re-key to input tickers.
 */
export function parseSparkBody(
  json: unknown,
): Map<string, BulkQuote> {
  const out = new Map<string, BulkQuote>();
  if (!json || typeof json !== "object") return out;

  const obj = json as Record<string, unknown>;

  // Legacy wrapped shape.
  const wrapped = (obj.spark as { result?: unknown[] } | undefined)?.result;
  if (Array.isArray(wrapped)) {
    for (const entry of wrapped) {
      const e = entry as {
        symbol?: string;
        response?: Array<{
          meta?: { previousClose?: number; chartPreviousClose?: number };
          timestamp?: (number | null)[];
          indicators?: { quote?: Array<{ close?: (number | null)[] }> };
        }>;
      };
      const sym = e.symbol;
      const resp = e.response?.[0];
      if (!sym || !resp) continue;
      const quote = sparkEntryToQuote({
        symbol: sym,
        close: resp.indicators?.quote?.[0]?.close ?? null,
        previousClose: resp.meta?.previousClose ?? null,
        chartPreviousClose: resp.meta?.chartPreviousClose ?? null,
        timestamp: resp.timestamp ?? null,
      });
      if (quote) out.set(sym, quote);
    }
    return out;
  }

  // Flat shape: each top-level key is a symbol.
  for (const [sym, raw] of Object.entries(obj)) {
    if (!raw || typeof raw !== "object") continue;
    const quote = sparkEntryToQuote({ symbol: sym, ...(raw as SparkSymbol) });
    if (quote) out.set(sym, quote);
  }
  return out;
}

function sparkEntryToQuote(e: SparkSymbol): BulkQuote | null {
  const closes = Array.isArray(e.close) ? e.close : [];
  let price: number | null = null;
  let asOfUnix = 0;
  const ts = Array.isArray(e.timestamp) ? e.timestamp : [];
  for (let i = closes.length - 1; i >= 0; i--) {
    const c = closes[i];
    if (c != null && Number.isFinite(c)) {
      price = c;
      const t = ts[i];
      if (t != null && Number.isFinite(t)) asOfUnix = t;
      break;
    }
  }
  if (price == null) return null;

  const prev =
    e.previousClose != null && Number.isFinite(e.previousClose)
      ? e.previousClose
      : e.chartPreviousClose != null && Number.isFinite(e.chartPreviousClose)
        ? e.chartPreviousClose
        : null;
  if (prev == null || prev <= 0) return null;

  // No usable timestamp (spark occasionally returns null timestamps) — fall
  // back to "now" so the ET trade-date derivation still works during a live
  // sweep. asOfUnix only feeds tradeDateEt, which is robust to a few minutes.
  if (asOfUnix === 0) asOfUnix = Math.floor(Date.now() / 1000);

  return { price, prevClose: prev, asOfUnix };
}

async function fetchSparkChunk(
  symbols: string[],
): Promise<Map<string, BulkQuote> | null> {
  const symbolParam = encodeURIComponent(symbols.join(","));
  const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${symbolParam}&range=1d&interval=1d`;

  let res: Response | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          "User-Agent": "MarketMap/1.0 (+https://localhost)",
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15_000),
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
  if (!res) return null;
  if (!res.ok) {
    // Non-retryable upstream rejection (e.g. HTTP 400 if Yahoo lowers the
    // per-request symbol cap below CHUNK_SIZE). Surface it loudly — a silent
    // null here means the whole live sweep returns zero quotes and the grid
    // quietly serves the stale close-to-close cache.
    let snippet = "";
    try {
      snippet = (await res.text()).slice(0, 200);
    } catch {
      /* ignore body read failure */
    }
    console.warn(
      `[bulk-quote] spark chunk failed: HTTP ${res.status} (${symbols.length} symbols)${
        snippet ? ` — ${snippet}` : ""
      }`,
    );
    return null;
  }

  try {
    const json = (await res.json()) as unknown;
    return parseSparkBody(json);
  } catch {
    return null;
  }
}

/**
 * Fetch live quotes for many tickers via chunked spark requests. Never throws:
 * a chunk that fails or omits a symbol leaves those tickers in `failed`. Keys
 * the result by the INPUT ticker so callers do not have to re-normalise.
 */
export async function fetchYahooBulkQuotes(
  tickers: string[],
): Promise<BulkQuoteResult> {
  const quotes = new Map<string, BulkQuote>();
  const failed: string[] = [];

  // Map Yahoo symbol -> input ticker so we can re-key the response. When two
  // input tickers normalise to the same symbol, last wins (degenerate edge).
  const symToTicker = new Map<string, string>();
  for (const t of tickers) symToTicker.set(toYahooSymbol(t), t);

  const symbols = [...symToTicker.keys()];
  const chunks = chunk(symbols, CHUNK_SIZE);

  // Bounded-concurrency worker pool over the chunks (mirrors the universe /
  // extended-hours sweep pattern). Workers share a cursor and write into the
  // result Map / failed array; safe under JS single-threaded turn semantics.
  let cursor = 0;
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= chunks.length) return;
      const symChunk = chunks[idx]!;
      const bySym = await fetchSparkChunk(symChunk);
      for (const sym of symChunk) {
        const ticker = symToTicker.get(sym)!;
        const q = bySym?.get(sym);
        if (q) quotes.set(ticker, q);
        else failed.push(ticker);
      }
      if (CHUNK_DELAY_MS > 0) await sleep(CHUNK_DELAY_MS);
    }
  });
  await Promise.all(workers);

  return { quotes, servedVia: "spark", failed };
}
