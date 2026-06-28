/**
 * Core FMP HTTP client: key injection, retry/backoff, JSON + CSV helpers, and
 * a worker-pool runner that honors the per-minute politeness budget. Mirrors
 * the resilience approach of yahoo-chart-http.ts (retry 401/429/5xx, backoff,
 * bounded concurrency, per-request gap). No DB access — pure I/O.
 */
import Papa from "papaparse";
import { fmpApiKey, fmpBaseUrl, fmpCallsPerMinute } from "@/infrastructure/config/env";

export class FmpAuthError extends Error {}
export class FmpRequestError extends Error {}

const MAX_ATTEMPTS = 4;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type FmpParams = Record<string, string | number | boolean | undefined>;

function buildUrl(path: string, params: FmpParams): string {
  const key = fmpApiKey();
  if (!key) throw new FmpAuthError("FMP_API_KEY is not set.");
  const url = new URL(`${fmpBaseUrl()}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  }
  url.searchParams.set("apikey", key);
  return url.toString();
}

function redact(url: string): string {
  return url.replace(/apikey=[^&]+/, "apikey=***");
}

async function fmpFetch(path: string, params: FmpParams): Promise<Response> {
  const url = buildUrl(path, params);
  let lastReason = "";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { "User-Agent": "MarketMap/1.0 (+revision-engine)", Accept: "application/json" },
        signal: AbortSignal.timeout(45_000),
      });
    } catch (e) {
      lastReason = e instanceof Error ? e.message : String(e);
      if (attempt === MAX_ATTEMPTS) throw new FmpRequestError(`${redact(url)}: ${lastReason}`);
      await sleep(400 * 2 ** (attempt - 1));
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      throw new FmpAuthError(`FMP auth failed (HTTP ${res.status}) for ${redact(url)}`);
    }
    if (res.status === 429 || res.status >= 500) {
      lastReason = `HTTP ${res.status}`;
      if (attempt === MAX_ATTEMPTS) throw new FmpRequestError(`${redact(url)}: ${lastReason}`);
      await sleep(600 * 2 ** (attempt - 1));
      continue;
    }
    if (!res.ok) throw new FmpRequestError(`${redact(url)}: HTTP ${res.status}`);
    return res;
  }
  throw new FmpRequestError(`${redact(url)}: exhausted retries (${lastReason})`);
}

/** GET a JSON endpoint. Returns [] for empty bodies; throws on FMP error objects. */
export async function fmpGetJson<T>(path: string, params: FmpParams = {}): Promise<T> {
  const res = await fmpFetch(path, params);
  const text = await res.text();
  if (!text.trim()) return [] as unknown as T;
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new FmpRequestError(`${path}: non-JSON response (${text.slice(0, 120)})`);
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const msg = (body as Record<string, unknown>)["Error Message"];
    if (typeof msg === "string") throw new FmpRequestError(`${path}: ${msg}`);
  }
  return body as T;
}

/** GET a CSV (bulk) endpoint and parse to typed objects keyed by header row. */
export async function fmpGetCsv<T = Record<string, string>>(
  path: string,
  params: FmpParams = {},
): Promise<T[]> {
  const res = await fmpFetch(path, params);
  const text = await res.text();
  if (!text.trim()) return [];
  const parsed = Papa.parse<T>(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
  return (parsed.data ?? []).filter((r) => r && typeof r === "object");
}

/**
 * Run an async worker over items with bounded concurrency and a per-call gap
 * derived from the tier budget. Per-item failures are collected, never abort
 * the batch.
 */
export async function fmpPool<I, O>(
  items: I[],
  worker: (item: I, index: number) => Promise<O>,
  opts: { concurrency?: number; gapMs?: number } = {},
): Promise<{ results: Array<{ item: I; value: O }>; failures: Array<{ item: I; error: string }> }> {
  const concurrency = opts.concurrency ?? 6;
  const gapMs = opts.gapMs ?? Math.max(5, Math.ceil((60_000 / fmpCallsPerMinute()) * concurrency));
  const results: Array<{ item: I; value: O }> = [];
  const failures: Array<{ item: I; error: string }> = [];
  let cursor = 0;

  async function run(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      const item = items[idx]!;
      try {
        const value = await worker(item, idx);
        results.push({ item, value });
      } catch (e) {
        failures.push({ item, error: e instanceof Error ? e.message : String(e) });
      }
      if (gapMs > 0) await sleep(gapMs);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, () => run()));
  return { results, failures };
}

// ─── parsing helpers (defensive: API fields are spotty) ────────────────────

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length ? s : null;
}

/** Normalize an ISO/date string to YYYY-MM-DD (or null). */
export function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
  return d.toISOString().slice(0, 10);
}
