/**
 * Precompute freshness — answers "is the saved per-stock regression grid
 * current to the last completed trading close?"
 *
 * Used by:
 *   - server/services/precompute-runner.ts (startup catch-up decision)
 *   - api/analysis/factors/precompute-status (UI indicator)
 *
 * Time semantics
 * --------------
 * The reference "last completed trading close" is the most recent weekday in
 * the *server's local timezone* whose 17:00 close has passed. This matches the
 * Windows Scheduled Task that fires at 17:00 local on weekdays — both surfaces
 * are anchored to the same wall clock. Holidays are not detected; on a market
 * holiday the catch-up runs idempotently (the price ingest finds no new bars
 * to upsert, and the grids are recomputed from unchanged inputs — harmless).
 *
 * Freshness signal
 * ----------------
 * `computedAt` (not `asOfDate`) is the primary signal because we are asking
 * "has the run happened since the last close?" — not "what trading day are
 * the betas based on?". Using `asOfDate` would produce a false-stale loop
 * whenever Kenneth-French / AQR publish lag exceeds a day, which is the
 * common case.
 */
import type { PrismaClient } from "@prisma/client";

/** A weekday in {1, 2, 3, 4, 5}. Sunday = 0, Saturday = 6 are excluded. */
function isWeekday(d: Date): boolean {
  const dow = d.getDay();
  return dow >= 1 && dow <= 5;
}

/**
 * Most recent weekday whose 17:00 local close has passed.
 *
 * Algorithm:
 *   1. Take `today at 17:00 local`. If that is still in the future, step back
 *      one day (the close has not happened yet today).
 *   2. Walk back over Sat/Sun.
 *
 * The returned Date is the close timestamp itself (17:00 local on that day),
 * suitable for `>=` comparison against a `Date`-typed `computedAt`.
 */
export function lastTradingClose(now: Date = new Date()): Date {
  const candidate = new Date(now);
  candidate.setHours(17, 0, 0, 0);
  if (candidate > now) {
    candidate.setDate(candidate.getDate() - 1);
    candidate.setHours(17, 0, 0, 0);
  }
  while (!isWeekday(candidate)) {
    candidate.setDate(candidate.getDate() - 1);
    candidate.setHours(17, 0, 0, 0);
  }
  return candidate;
}

export interface PrecomputeGridStatus {
  /** Trading days regression window. */
  window: number;
  /** Last factor date inside the cached result. */
  asOfDate: string;
  /** When this row was upserted (i.e. when the precompute ran). */
  computedAt: string;
}

export interface PrecomputeFreshness {
  /** ISO timestamp of the reference last-close used for the verdict. */
  lastTradingClose: string;
  /** Oldest `computedAt` across the expected (model, window) rows; null if any expected row is missing. */
  freshestComputedAt: string | null;
  /** Most recent `computedAt` across the cached rows; null when the cache is empty. */
  latestComputedAt: string | null;
  /** Oldest `asOfDate` across the cached rows; null when the cache is empty. */
  oldestAsOfDate: string | null;
  /** True if any expected (model, window) row is missing or older than the last close. */
  stale: boolean;
  /** One row per cached (model, window). Sorted by window ascending. */
  grids: PrecomputeGridStatus[];
}

/**
 * Read the cache and compute the freshness verdict.
 *
 * @param db                   Prisma client.
 * @param expectedModel        Model whose rows are required for "fresh" (default MACRO14).
 * @param expectedWindows      Windows whose rows are required for "fresh" (default the 4 HORIZON presets).
 * @param now                  Reference time for `lastTradingClose` (injectable for tests).
 */
export async function getPrecomputeFreshness(
  db: PrismaClient,
  expectedModel: string = "MACRO14",
  expectedWindows: number[] = [63, 252, 504, 756],
  now: Date = new Date(),
): Promise<PrecomputeFreshness> {
  const rows = await db.perStockGridSnapshot.findMany({
    where: { model: expectedModel },
    select: { regressionWindow: true, asOfDate: true, computedAt: true },
    orderBy: { regressionWindow: "asc" },
  });

  const reference = lastTradingClose(now);
  const grids: PrecomputeGridStatus[] = rows.map((r) => ({
    window: r.regressionWindow,
    asOfDate: r.asOfDate.toISOString().slice(0, 10),
    computedAt: r.computedAt.toISOString(),
  }));

  const expectedSet = new Set(expectedWindows);
  const haveSet = new Set(rows.map((r) => r.regressionWindow));
  const missing = [...expectedSet].filter((w) => !haveSet.has(w));

  let freshestComputedAt: string | null = null;
  if (missing.length === 0 && rows.length > 0) {
    // "Freshest" = oldest computedAt across the expected rows: that is the
    // moment from which ALL expected grids have been refreshed.
    let oldest = rows[0]!.computedAt;
    for (const r of rows) {
      if (r.computedAt < oldest) oldest = r.computedAt;
    }
    freshestComputedAt = oldest.toISOString();
  }

  const latestComputedAt =
    rows.length > 0
      ? rows.reduce((m, r) => (r.computedAt > m ? r.computedAt : m), rows[0]!.computedAt).toISOString()
      : null;

  const oldestAsOfDate =
    rows.length > 0
      ? rows
          .reduce((m, r) => (r.asOfDate < m ? r.asOfDate : m), rows[0]!.asOfDate)
          .toISOString()
          .slice(0, 10)
      : null;

  const stale =
    freshestComputedAt === null ||
    new Date(freshestComputedAt) < reference;

  return {
    lastTradingClose: reference.toISOString(),
    freshestComputedAt,
    latestComputedAt,
    oldestAsOfDate,
    stale,
    grids,
  };
}
