/**
 * Shared Yahoo fetch wrapper: retry/backoff + a PROCESS-WIDE circuit breaker.
 *
 * All anonymous Yahoo v8 traffic (per-ticker chart, bulk spark) funnels through
 * here so that when Yahoo starts throttling this IP — a burst of HTTP 401/429/
 * 5xx or request timeouts — the breaker OPENS and every caller short-circuits
 * to `null` for a short cool-off instead of independently retry-storming. That
 * retry storm (each of ~2,872 per-minute sweep requests waiting out its own
 * 3× backoff) is what floods the server log with TimeoutErrors and pins the
 * event loop; backing off together lets the throttle clear far faster.
 *
 * Breaker state is hoisted onto globalThis (same rationale as the live
 * snapshots / the Prisma client) so every Next.js route + runner bundle in the
 * single-process desktop deployment shares one breaker.
 */

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const num = (v: string | undefined, d: number): number => {
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) ? n : d;
};

// Env-overridable so ops can retune the breaker without a redeploy.
const FAIL_WINDOW_MS = num(process.env.YAHOO_BREAKER_WINDOW_MS, 30_000);
const FAIL_THRESHOLD = num(process.env.YAHOO_BREAKER_THRESHOLD, 12);
const COOLOFF_MS = num(process.env.YAHOO_BREAKER_COOLOFF_MS, 20_000);

interface BreakerState {
  /** Failures since the last success (within the rolling window). */
  failures: number;
  /** Start of the current failure window (epoch ms). */
  windowStart: number;
  /** Breaker is OPEN while `Date.now() < openUntil`. */
  openUntil: number;
  /** Whether we've already logged the current OPEN episode (avoid log spam). */
  loggedOpen: boolean;
}

const g = globalThis as unknown as { __yahooBreaker?: BreakerState };
const breaker: BreakerState =
  g.__yahooBreaker ?? {
    failures: 0,
    windowStart: 0,
    openUntil: 0,
    loggedOpen: false,
  };
g.__yahooBreaker = breaker;

/** True while the breaker is OPEN — callers skip Yahoo entirely. */
export function yahooBreakerOpen(now: number = Date.now()): boolean {
  return now < breaker.openUntil;
}

/** A reachable Yahoo response closes the breaker (Yahoo isn't throttling us). */
export function recordYahooSuccess(): void {
  breaker.failures = 0;
  breaker.windowStart = 0;
  breaker.openUntil = 0;
  breaker.loggedOpen = false;
}

/** A timeout / 401 / 429 / 5xx after exhausting retries trips the breaker. */
export function recordYahooFailure(now: number = Date.now()): void {
  if (now - breaker.windowStart > FAIL_WINDOW_MS) {
    breaker.windowStart = now;
    breaker.failures = 0;
  }
  breaker.failures += 1;
  if (breaker.failures >= FAIL_THRESHOLD && now >= breaker.openUntil) {
    breaker.openUntil = now + COOLOFF_MS;
    if (!breaker.loggedOpen) {
      breaker.loggedOpen = true;
      console.warn(
        `[yahoo-breaker] OPEN for ${Math.round(COOLOFF_MS / 1000)}s after ` +
          `${breaker.failures} failures — skipping Yahoo to let the throttle clear`,
      );
    }
  }
}

/** Test / monitoring hook. */
export function _resetYahooBreaker(): void {
  breaker.failures = 0;
  breaker.windowStart = 0;
  breaker.openUntil = 0;
  breaker.loggedOpen = false;
}

const YAHOO_HEADERS = {
  "User-Agent": "MarketMap/1.0 (+https://localhost)",
  Accept: "application/json",
} as const;

export interface YahooFetchOptions {
  /** Per-request abort timeout. Default 15s. */
  timeoutMs?: number;
  /** Max attempts including the first. Default 4. */
  maxAttempts?: number;
}

/**
 * Fetch a Yahoo URL with retry/backoff, honoring the shared circuit breaker.
 *
 * Returns the `Response` for any non-retryable status (2xx / 3xx / 404 / 400 —
 * the CALLER decides how to interpret those, e.g. 404 = delisted). Returns
 * `null` when the breaker is OPEN, the request times out, or retries are
 * exhausted on 401/429/5xx. Never throws.
 */
export async function yahooFetchRetry(
  url: string,
  opts: YahooFetchOptions = {},
): Promise<Response | null> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxAttempts = opts.maxAttempts ?? 4;

  // Breaker OPEN — skip the network so we don't pile onto an active throttle.
  if (yahooBreakerOpen()) return null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: YAHOO_HEADERS,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (attempt === maxAttempts) {
        recordYahooFailure();
        return null;
      }
      await sleep(250 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401 || res.status === 429 || res.status >= 500) {
      if (attempt === maxAttempts) {
        recordYahooFailure();
        return null;
      }
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    // Reachable response (2xx/3xx/404/400) — Yahoo isn't throttling us.
    recordYahooSuccess();
    return res;
  }
  return null;
}
