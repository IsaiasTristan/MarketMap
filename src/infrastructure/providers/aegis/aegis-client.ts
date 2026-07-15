/**
 * Core AEGIS OData HTTP client. HTTP Basic auth (email + "OData Auth" JWT),
 * retry/backoff on 429/5xx, typed auth error on 401/403 (token expiry must
 * surface loudly — AEGIS tokens expire quarterly). Mirrors fmp-client.ts.
 * No DB access — pure I/O.
 *
 * AEGIS quirk: unknown product codes return HTTP 200 with an empty value
 * array (no error), so "empty" is a first-class outcome callers must treat
 * as a failure for active curves.
 */
import { aegisOdataBaseUrl, aegisOdataToken, aegisOdataUser } from "@/infrastructure/config/env";

export class AegisAuthError extends Error {}
export class AegisRequestError extends Error {}

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function authHeader(): string {
  const token = aegisOdataToken();
  if (!token) throw new AegisAuthError("AEGIS_ODATA_TOKEN is not set.");
  return `Basic ${Buffer.from(`${aegisOdataUser()}:${token}`).toString("base64")}`;
}

/**
 * GET an OData path (e.g. "/Underlyings" or
 * "/MarketData.ForDate(asOfDate=2026-07-13,productCodes='CL')") and return
 * the `value` array. Throws AegisAuthError on 401/403, AegisRequestError on
 * anything else unrecoverable.
 */
export async function aegisGetValues<T>(pathWithQuery: string): Promise<T[]> {
  const url = `${aegisOdataBaseUrl()}${pathWithQuery}`;
  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: authHeader(), Accept: "application/json" },
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_ATTEMPTS) throw new AegisRequestError(`${url}: ${lastReason}`);
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new AegisAuthError(
        `AEGIS auth failed (HTTP ${res.status}) — the OData token has likely expired; refresh it from the platform (username menu, bottom-left) into AEGIS_ODATA_TOKEN.`,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      lastReason = `HTTP ${res.status}`;
      if (attempt === MAX_ATTEMPTS) throw new AegisRequestError(`${url}: ${lastReason}`);
      await sleep(600 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) throw new AegisRequestError(`${url}: HTTP ${res.status}`);
    const body = (await res.json().catch(() => null)) as { value?: T[] } | null;
    if (!body || !Array.isArray(body.value)) {
      throw new AegisRequestError(`${url}: unexpected response shape`);
    }
    return body.value;
  }
  throw new AegisRequestError(`${url}: exhausted retries (${lastReason})`);
}

/**
 * Bounded-concurrency worker pool with a per-call gap (politeness). Per-item
 * failures are collected, never abort the batch — EXCEPT auth errors, which
 * abort immediately (retrying every curve against an expired token is noise).
 */
export async function aegisPool<I, O>(
  items: I[],
  worker: (item: I, index: number) => Promise<O>,
  opts: { concurrency?: number; gapMs?: number } = {},
): Promise<{ results: Array<{ item: I; value: O }>; failures: Array<{ item: I; error: string }> }> {
  const concurrency = opts.concurrency ?? 3;
  const gapMs = opts.gapMs ?? 150;
  const results: Array<{ item: I; value: O }> = [];
  const failures: Array<{ item: I; error: string }> = [];
  let cursor = 0;
  let authError: AegisAuthError | null = null;

  async function run(): Promise<void> {
    while (true) {
      if (authError) return;
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx]!;
      try {
        const value = await worker(item, idx);
        results.push({ item, value });
      } catch (e) {
        if (e instanceof AegisAuthError) {
          authError = e;
          return;
        }
        failures.push({ item, error: e instanceof Error ? e.message : String(e) });
      }
      if (gapMs > 0) await sleep(gapMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => run()));
  if (authError) throw authError;
  return { results, failures };
}
