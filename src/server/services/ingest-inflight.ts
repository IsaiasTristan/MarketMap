/**
 * ingest-inflight — process-wide dedup guard for admin-triggered price ingest.
 *
 * Multiple admin browser tabs each fire the market-map auto-ingest (and again
 * every 60s during REGULAR). Without a guard, N tabs launch N overlapping
 * ~1,229-ticker Yahoo sweeps that stampede the upstream and the DB. This mirror
 * of `startPrecompute`'s "already-running" pattern lets a second concurrent
 * ingest for the same key short-circuit instead of launching a parallel sweep.
 *
 * Keyed by an operation string (e.g. `universe:<id>:tail`). The in-flight set
 * lives on `globalThis` so it is shared across the separate Next.js dev server
 * bundles (same reasoning as the Prisma client and the snapshot caches).
 */
const g = globalThis as unknown as { __ingestInFlight?: Set<string> };
const inFlight: Set<string> = g.__ingestInFlight ?? (g.__ingestInFlight = new Set());

export type IngestLockOutcome<T> =
  | { ran: true; result: T }
  | { ran: false };

/**
 * Run `fn` under the in-flight lock for `key`. If an ingest for the same key
 * is already running, returns `{ ran: false }` immediately without launching a
 * second sweep. The lock is always released when `fn` settles.
 */
export async function withIngestLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<IngestLockOutcome<T>> {
  if (inFlight.has(key)) return { ran: false };
  inFlight.add(key);
  try {
    return { ran: true, result: await fn() };
  } finally {
    inFlight.delete(key);
  }
}
