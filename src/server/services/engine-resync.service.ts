/**
 * engine-resync — propagate market-map taxonomy edits to the downstream engines.
 *
 * Manage Tickers edits only touch `UniverseConstituent` (sector / sub-theme).
 * Research (Engine 1) and Fundamentals (Engine 2) read peer-group membership +
 * labels from `RevisionReference`, which is normally refreshed only by the
 * weekly job. This service performs an on-demand resync so new sectors /
 * subsectors flow across the whole program immediately:
 *
 *   1. buildReferenceFromMarketMap — UniverseConstituent -> RevisionReference
 *      (sub-theme -> subsector). MUST run first; scoring reads peer groups
 *      from RevisionReference.
 *   2. scoreRevisionWeek           — re-score Engine 1 from the latest stored
 *      RevisionSnapshot (no external FMP calls).
 *   3. scoreFundamentalBoxesWeek   — re-score Engine 2 from stored fundamentals
 *      (no external FMP calls).
 *
 * The run is CPU/DB-bound over the active universe, so it executes as a
 * fire-and-forget background task; callers poll `getEngineResyncState()` for
 * completion. Status lives on `globalThis` so it is shared across the separate
 * Next.js dev-server bundles (same pattern as the Prisma client and the
 * snapshot caches). Never throws — failures are recorded in the shared state.
 */
import { buildReferenceFromMarketMap } from "./revision/reference-ingest.service";
import { scoreRevisionWeek } from "./revision/revision-scoring.service";
import { scoreFundamentalBoxesWeek } from "./fundamental/fundamental-box-scoring.service";

export type EngineResyncStatus = "idle" | "running" | "done" | "error";

export interface EngineResyncState {
  status: EngineResyncStatus;
  /** When the current/last run started. */
  startedAt: string | null;
  /** When the last run finished (done | error). */
  finishedAt: string | null;
  /** Error message when `status === "error"`. */
  error: string | null;
}

const g = globalThis as unknown as { __engineResyncState?: EngineResyncState };
const state: EngineResyncState =
  g.__engineResyncState ??
  (g.__engineResyncState = {
    status: "idle",
    startedAt: null,
    finishedAt: null,
    error: null,
  });

export function getEngineResyncState(): EngineResyncState {
  return { ...state };
}

export interface EngineResyncOptions {
  /** Universe to source taxonomy from; defaults to the single active universe. */
  universeId?: string;
  log?: (msg: string) => void;
}

/**
 * Run the full resync chain in order. Updates the shared status object as it
 * progresses. Never throws — intended to be called fire-and-forget from the
 * resync route (which returns immediately while this continues in-process).
 */
export async function runEngineResync(
  opts: EngineResyncOptions = {},
): Promise<void> {
  const log = opts.log ?? ((m: string) => console.log(`[engine-resync] ${m}`));

  state.status = "running";
  state.startedAt = new Date().toISOString();
  state.finishedAt = null;
  state.error = null;

  try {
    const ref = await buildReferenceFromMarketMap({
      universeId: opts.universeId,
      log,
    });
    log(
      `reference: upserted ${ref.upserted} (${ref.failures.length} failures)`,
    );

    const rev = await scoreRevisionWeek({ log });
    log(
      `research: scored ${rev.scored} (${rev.subsectorGroups} subsector / ${rev.sectorGroups} sector groups)`,
    );

    const fun = await scoreFundamentalBoxesWeek({ log });
    log(
      `fundamentals: scored ${fun.scored} (${fun.subsectorGroups} subsector / ${fun.sectorGroups} sector groups)`,
    );

    state.status = "done";
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    state.status = "error";
    console.error("[engine-resync] failed:", e);
  } finally {
    state.finishedAt = new Date().toISOString();
  }
}
