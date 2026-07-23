/**
 * Extended-hours quote snapshot + sweep.
 *
 * Maintains an in-memory cache of the latest pre-market / after-hours print
 * for every active universe ticker. The market-map API reads this cache to
 * overlay extended-hours prices onto the regular-close daily series WITHOUT
 * persisting anything to PriceHistory (which is the EOD adjClose tape and
 * must stay clean).
 */
import type { PrismaClient } from "@prisma/client";
import type { MarketSession } from "@/lib/market-map/market-session";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import { fetchYahooExtendedQuotes } from "@/infrastructure/providers/yahoo-chart-http";
import {
  readSnapshotFile,
  snapshotFileMtimeMs,
  writeSnapshotFile,
} from "./live-snapshot-store";

/** Per-ticker extended-hours quote stored in the snapshot. */
export type ExtendedTickerQuote = {
  price: number;
  session: "PRE" | "POST";
  asOfUnix: number;
  /** yyyy-MM-dd in America/New_York for the bar's timestamp. */
  tradeDateEt: string;
  /** Today's regular-session close when session=POST (4pm print). */
  regularClose: number | null;
};

/**
 * In-memory snapshot of the most recent extended-hours sweep.
 */
export interface ExtendedSnapshot {
  session: MarketSession | null;
  asOf: string | null;
  quotes: Map<string, ExtendedTickerQuote>;
}

function emptySnapshot(): ExtendedSnapshot {
  return {
    session: null,
    asOf: null,
    quotes: new Map(),
  };
}

const globalForExt = globalThis as unknown as {
  __extendedHoursSnapshot?: ExtendedSnapshot;
};
if (!globalForExt.__extendedHoursSnapshot) {
  globalForExt.__extendedHoursSnapshot = emptySnapshot();
}

// ── Out-of-process bridge ──────────────────────────────────────────────────
// The heavy per-ticker extended-hours sweep runs in the live-sweep daemon
// (LIVE_SWEEP_DAEMON=1), which writes each result to a shared file. The web
// process never sweeps; its getter refreshes from that file (mtime-gated) so
// the snapshot API and every consumer stay unchanged. In the daemon the getter
// returns its own freshly-swept in-memory snapshot (no read-through).

const IS_DAEMON = process.env.LIVE_SWEEP_DAEMON === "1";
const EXT_SNAPSHOT_FILE = "extended-hours";
const FILE_CHECK_INTERVAL_MS = 2_000;

interface SerializedExtended {
  session: MarketSession | null;
  asOf: string | null;
  quotes: Array<[string, ExtendedTickerQuote]>;
}

let lastFileCheckAt = 0;
let lastLoadedMtime = 0;

/** Persist the current snapshot for the web process to read (daemon only). */
function persistExtendedSnapshot(snap: ExtendedSnapshot): void {
  const payload: SerializedExtended = {
    session: snap.session,
    asOf: snap.asOf,
    quotes: [...snap.quotes.entries()],
  };
  writeSnapshotFile(EXT_SNAPSHOT_FILE, payload);
}

/** Write the snapshot to memory, and — in the daemon — to the shared file. */
function setExtendedSnapshot(snap: ExtendedSnapshot): void {
  globalForExt.__extendedHoursSnapshot = snap;
  if (IS_DAEMON) persistExtendedSnapshot(snap);
}

/** Web-process read-through: reload globalThis from the file when the daemon
 *  has written a newer one. Throttled to one stat per FILE_CHECK_INTERVAL_MS;
 *  parses only when the mtime actually changes (~once per 60s sweep). */
function maybeReloadExtendedFromFile(): void {
  const now = Date.now();
  if (now - lastFileCheckAt < FILE_CHECK_INTERVAL_MS) return;
  lastFileCheckAt = now;
  const mtime = snapshotFileMtimeMs(EXT_SNAPSHOT_FILE);
  if (mtime == null || mtime === lastLoadedMtime) return;
  const ser = readSnapshotFile<SerializedExtended>(EXT_SNAPSHOT_FILE);
  if (!ser || !Array.isArray(ser.quotes)) return; // partial/parse miss — keep current
  lastLoadedMtime = mtime;
  globalForExt.__extendedHoursSnapshot = {
    session: ser.session,
    asOf: ser.asOf,
    quotes: new Map(ser.quotes),
  };
}

/** Read-only accessor — returns the most recent snapshot. */
export function getExtendedSnapshot(): ExtendedSnapshot {
  if (!IS_DAEMON) maybeReloadExtendedFromFile();
  const snap = globalForExt.__extendedHoursSnapshot!;
  // Hot-reload / schema migration: prior builds stored `prices` only.
  // Drop the stale shape so the runner's next BACKFILL repopulates quotes.
  if (!snap.quotes) {
    globalForExt.__extendedHoursSnapshot = emptySnapshot();
    return globalForExt.__extendedHoursSnapshot!;
  }
  return snap;
}

/** Wipe the cache. Called by the runner when leaving an extended window. */
export function clearExtendedSnapshot(): void {
  setExtendedSnapshot(emptySnapshot());
}

export interface SweepResult {
  ticker: string;
  price: number;
  session: "PRE" | "POST";
}

export interface SweepSummary {
  attempted: number;
  applied: number;
  results: SweepResult[];
}

export async function sweepExtendedHours(
  db: PrismaClient,
  mode: "PRE" | "POST" | "BACKFILL",
): Promise<SweepSummary> {
  const constituents = await db.universeConstituent.findMany({
    where: { security: { isActive: true } },
    select: { security: { select: { ticker: true } } },
  });
  const tickers = Array.from(
    new Set(constituents.map((c) => c.security.ticker)),
  );

  const snapshotSession: "PRE" | "POST" = mode === "PRE" ? "PRE" : "POST";

  if (tickers.length === 0) {
    setExtendedSnapshot({
      session: snapshotSession,
      asOf: new Date().toISOString(),
      quotes: new Map(),
    });
    return { attempted: 0, applied: 0, results: [] };
  }

  const range = mode === "BACKFILL" ? "5d" : "1d";
  const yahooQuotes = await fetchYahooExtendedQuotes(tickers, { range });
  const quotes = new Map<string, ExtendedTickerQuote>();
  const results: SweepResult[] = [];
  let latestBarUnix = 0;

  for (const [ticker, q] of yahooQuotes) {
    if (q.session !== "PRE" && q.session !== "POST") continue;
    // POST / BACKFILL sweeps must not store stale same-day PRE prints (BAYRY
    // case: morning PRE bar survives into the evening snapshot and ranks as a
    // bogus −14% "after-hours" loser). PRE sweeps accept PRE only.
    if (snapshotSession === "POST" && q.session !== "POST") continue;
    if (snapshotSession === "PRE" && q.session !== "PRE") continue;
    const tradeDateEt = tradeDateEtFromUnix(q.asOfUnix);
    quotes.set(ticker, {
      price: q.price,
      session: q.session,
      asOfUnix: q.asOfUnix,
      tradeDateEt,
      regularClose: q.regularClose,
    });
    results.push({ ticker, price: q.price, session: q.session });
    if (q.asOfUnix > latestBarUnix) latestBarUnix = q.asOfUnix;
  }

  const asOf =
    mode === "BACKFILL" && latestBarUnix > 0
      ? new Date(latestBarUnix * 1000).toISOString()
      : new Date().toISOString();

  setExtendedSnapshot({
    session: snapshotSession,
    asOf,
    quotes,
  });

  return { attempted: tickers.length, applied: quotes.size, results };
}
