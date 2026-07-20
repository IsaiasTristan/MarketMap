/**
 * fetch-json — client-side JSON fetch that survives server restarts.
 *
 * The prod server is supervised: when it crashes or restarts, requests during
 * the ~5-30s gap get an HTML error page (Cloudflare 502 / Next error page)
 * instead of JSON. Calling `res.json()` on that HTML throws the cryptic
 * `Unexpected token '<', "<!DOCTYPE"... is not valid JSON` that components
 * then render verbatim.
 *
 * This helper checks `res.ok` AND the Content-Type BEFORE parsing, maps
 * failures to clean human-readable messages, and retries transient failures
 * (non-JSON responses, 5xx, network errors) with backoff — long enough in
 * total (~17s by default) to ride out a typical supervisor restart, so the
 * panel self-heals without a manual page refresh.
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface FetchJsonOptions {
  /** Retry attempts after the first failure (default 3). */
  retries?: number;
  /** Delay before each retry, in ms (default [2000, 5000, 10000]). */
  retryDelaysMs?: number[];
}

const DEFAULT_RETRY_DELAYS_MS = [2000, 5000, 10000];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function attemptFetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    // Network-level failure (server down, connection reset) — retryable.
    throw new ApiError(
      "Cannot reach the server — it may be restarting.",
      null,
      true,
    );
  }

  const contentType = res.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");

  if (!isJson) {
    // HTML error page (502 from the tunnel, Next error page, auth redirect).
    // Never parse it — that is where "Unexpected token '<'" came from.
    throw new ApiError(
      `Server unavailable (HTTP ${res.status}) — retrying shortly usually fixes this.`,
      res.status,
      true,
    );
  }

  const body = (await res.json()) as T & { error?: unknown };

  if (!res.ok) {
    const message =
      typeof body?.error === "string" && body.error.length > 0
        ? body.error
        : `Request failed (HTTP ${res.status})`;
    // 5xx: the server hiccuped — retryable. 4xx: the request itself is bad —
    // retrying will not help, surface immediately.
    throw new ApiError(message, res.status, res.status >= 500);
  }

  return body;
}

/**
 * Fetch `url` and return its parsed JSON body, retrying transient failures.
 * Throws `ApiError` (with a clean message) once retries are exhausted or the
 * failure is non-retryable.
 */
export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  opts: FetchJsonOptions = {},
): Promise<T> {
  const delays = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const retries = opts.retries ?? delays.length;

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await attemptFetchJson<T>(url, init);
    } catch (e) {
      lastError = e;
      const retryable = e instanceof ApiError ? e.retryable : false;
      if (!retryable || attempt === retries) throw e;
      await sleep(delays[Math.min(attempt, delays.length - 1)]);
    }
  }
  throw lastError; // unreachable, satisfies the compiler
}
