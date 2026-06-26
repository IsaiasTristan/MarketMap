/**
 * Snapshot-refresh runner — long-lived server-side interval that keeps the
 * "hot" precomputed snapshots warm during the REGULAR US session so warm GET
 * reads stay sub-second and at most ~one interval stale.
 *
 * Singleton: `startSnapshotRefreshRunner()` is idempotent; calling it more than
 * once is a no-op so `instrumentation.ts` can call it on every boot.
 *
 * Self-guarded: each tick acts only during REGULAR (off-hours daily data is
 * static — the daily job + cold-miss write-through cover everything else) and
 * skips if a prior refresh is still in flight.
 *
 * Hot set (bounded to avoid re-creating a compute storm on the shared host):
 *   - market-map RETURN × SP500 for every universe,
 *   - factor-performance RETURN × SP500,
 *   - exposure + attribution for every portfolio at the default MACRO14 / 252
 *     (one engine run feeds both).
 * Every other (metric, benchmark, model, window) combo stays warmed by the
 * daily job and self-heals via the routes' cold-miss write-through.
 */
import { prisma } from "@/infrastructure/db/client";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import { computeAndCacheMarketMap } from "./market-map-cache.service";
import { computeAndCacheFactorPerformance } from "./factor-performance-cache.service";
import { runFactorEngine } from "./factor-engine.service";
import { computeAndCacheFactorExposure } from "./factor-exposure-cache.service";
import { computeAndCacheFactorAttribution } from "./factor-attribution-cache.service";
import type { ModelPresetName } from "@/types/factors";

/** Refresh cadence during REGULAR. Mirrors the market-map auto-poll (30s) plus
 *  headroom; warm reads are therefore at most ~this stale intraday. */
const REFRESH_INTERVAL_MS = 60_000;

/** The hot-set defaults — the combo the UI lands on by default. */
const HOT_MODEL: ModelPresetName = "MACRO14";
const HOT_WINDOW = 252;

let started = false;
let running = false;
let lastRefreshAt: string | null = null;
let lastError: string | null = null;

export interface SnapshotRunnerState {
  started: boolean;
  running: boolean;
  lastRefreshAt: string | null;
  lastError: string | null;
}

export function getSnapshotRunnerState(): SnapshotRunnerState {
  return { started, running, lastRefreshAt, lastError };
}

/**
 * Start the singleton refresh loop. Idempotent — repeated calls are no-ops.
 * Fire-and-forget: never throws; swallows any error into the runner state.
 */
export function startSnapshotRefreshRunner(): void {
  if (started) return;
  started = true;
  console.log(
    `[snapshot-refresh] runner started (refresh hot set every ${REFRESH_INTERVAL_MS / 1000}s during REGULAR)`,
  );
  // Fire once on boot so a server restart mid-session warms the hot set
  // without waiting a full interval.
  void tick();
  setInterval(() => {
    void tick();
  }, REFRESH_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  if (getUsMarketSession(new Date()) !== "REGULAR") return;

  running = true;
  try {
    const [universes, portfolios] = await Promise.all([
      prisma.universe.findMany({ select: { id: true } }),
      prisma.portfolio.findMany({ select: { id: true } }),
    ]);

    for (const { id: universeId } of universes) {
      await computeAndCacheMarketMap(universeId, "RETURN", "SP500");
    }

    await computeAndCacheFactorPerformance("RETURN", "SP500");

    for (const { id: portfolioId } of portfolios) {
      const engineResult = await runFactorEngine({
        portfolioId,
        model: HOT_MODEL,
        window: HOT_WINDOW,
      });
      if (!engineResult) continue;
      await computeAndCacheFactorExposure(
        portfolioId,
        HOT_MODEL,
        HOT_WINDOW,
        engineResult,
      );
      await computeAndCacheFactorAttribution(
        portfolioId,
        HOT_MODEL,
        HOT_WINDOW,
        engineResult,
      );
    }

    lastRefreshAt = new Date().toISOString();
    lastError = null;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[snapshot-refresh] refresh failed:", e);
  } finally {
    running = false;
  }
}
