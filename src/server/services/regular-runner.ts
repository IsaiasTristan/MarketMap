/**
 * Regular-hours market-map runner — long-lived server-side interval that bakes
 * today's live intraday move into the precomputed market-map cache during the
 * REGULAR US session.
 *
 * This replaces the old admin-browser-driven 60s `mode=tail` ingest: the grid
 * is now correct at the open for every viewer (and at ~2000 tickers) without
 * any browser open, because the server owns the refresh.
 *
 * Singleton + idempotent (safe to call on every boot from instrumentation).
 * Self-guarded: skips if a prior tick is still in flight.
 *
 * Lifecycle (the freeze-at-close policy, distinct from the extended runner's
 * clear-on-leave policy, is what closes the 4pm reversion-to-yesterday gap):
 *   - REGULAR: sweep live quotes, then rewrite the RETURN/SP500 cache for every
 *     universe with the live overlay applied (`liveMode: "live"` — a same-day
 *     bar is replaced).
 *   - First tick after leaving REGULAR (prevSession REGULAR -> not REGULAR):
 *     one final freeze sweep + one frozen cache write (`liveMode: "frozen"` —
 *     a same-day bar is a no-op so the official EOD close wins), then stop.
 *   - PRE / POST / CLOSED otherwise: no sweep, no write, no clear. The cache
 *     keeps today's frozen-overlay grid until the daily job writes the official
 *     close to PriceHistory and recomputes the cache from the clean tape.
 *
 * The market-map cache is owned by THIS runner during REGULAR; the
 * snapshot-refresh runner no longer rewrites it (it would clobber the overlay
 * with stale close-to-close data).
 */
import { prisma } from "@/infrastructure/db/client";
import {
  getUsMarketSession,
  type MarketSession,
} from "@/lib/market-map/market-session";
import {
  getLiveRegularSnapshot,
  sweepRegularQuotes,
} from "./live-regular.service";
import { computeAndCacheMarketMap } from "./market-map-cache.service";
import type { LiveOverlayMode } from "./market-map.service";

/** Sweep + cache-write cadence. Matches the client grid poll (30s) plus
 *  headroom; warm reads are therefore at most ~this stale intraday. */
const SWEEP_INTERVAL_MS = 60_000;

/** The hot combo the UI lands on by default and the only one kept live during
 *  REGULAR (mirrors the snapshot-refresh runner's market-map scope). Other
 *  (metric, benchmark) combos stay at the daily-job value and self-heal on a
 *  cold miss — same behaviour as before this runner existed. */
const HOT_METRIC = "RETURN" as const;
const HOT_BENCHMARK = "SP500" as const;

let started = false;
let running = false;
let prevSession: MarketSession | null = null;
let lastSweepAt: string | null = null;
let lastError: string | null = null;

export interface RegularRunnerState {
  started: boolean;
  running: boolean;
  prevSession: MarketSession | null;
  lastSweepAt: string | null;
  lastError: string | null;
}

export function getRegularRunnerState(): RegularRunnerState {
  return { started, running, prevSession, lastSweepAt, lastError };
}

/**
 * Start the singleton sweep loop. Idempotent — repeated calls are no-ops.
 * Fire-and-forget: never throws; swallows any error into the runner state.
 */
export function startRegularRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[live-regular] runner started (sweep + cache write every ${SWEEP_INTERVAL_MS / 1000}s during REGULAR)`,
  );
  // Fire once on boot so a restart mid-session warms the cache without waiting
  // a full interval.
  void tick();
  setInterval(() => {
    void tick();
  }, SWEEP_INTERVAL_MS);
}

async function writeOverlayCaches(mode: LiveOverlayMode): Promise<void> {
  const snap = getLiveRegularSnapshot();
  if (snap.quotes.size === 0) return;
  const universes = await prisma.universe.findMany({ select: { id: true } });
  for (const { id } of universes) {
    await computeAndCacheMarketMap(id, HOT_METRIC, HOT_BENCHMARK, {
      liveQuotes: snap.quotes,
      liveMode: mode,
    });
  }
}

async function tick(): Promise<void> {
  if (running) return;
  const session = getUsMarketSession(new Date());

  const leavingRegular = prevSession === "REGULAR" && session !== "REGULAR";

  // Off-hours steady state (not REGULAR, not the close transition): nothing to
  // do. Leave the frozen snapshot + cache in place.
  if (session !== "REGULAR" && !leavingRegular) {
    prevSession = session;
    return;
  }

  running = true;
  try {
    const summary = await sweepRegularQuotes(prisma);
    const mode: LiveOverlayMode = session === "REGULAR" ? "live" : "frozen";
    await writeOverlayCaches(mode);
    lastSweepAt = new Date().toISOString();
    lastError = null;
    console.log(
      `[live-regular] swept ${summary.applied}/${summary.attempted} via ${summary.servedVia ?? "?"} (${session}${
        leavingRegular ? " freeze" : ""
      })`,
    );
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[live-regular] sweep failed:", e);
  } finally {
    running = false;
    prevSession = session;
  }
}
