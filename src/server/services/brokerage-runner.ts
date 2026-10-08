/**
 * Brokerage-sync background runner — post-close daily mirror.
 *
 * Brokerage holdings settle after the market close, so this runner refreshes
 * every managed account once per US-Eastern day after 16:30 ET (the
 * `isBrokerageSyncDue` gate). Each tick it re-discovers accounts under every
 * active link (to pick up a newly connected account) and syncs those due.
 *
 * Same constraints as the other runners: singleton, hourly tick, gated by
 * ET-date + DB state so it self-heals across restarts, never throws, guarded
 * against overlap, single-process desktop model. Skips entirely when SnapTrade
 * is unconfigured. The manual "Sync now" button is independent of this runner.
 */
import { prisma } from "@/infrastructure/db/client";
import { snaptradeConfigured } from "@/infrastructure/config/env";
import { isBrokerageSyncDue } from "@/lib/brokerage/sync-gate";
import { discoverAndLinkAccounts } from "./brokerage/snaptrade-link.service";
import { syncBrokerageAccount } from "./brokerage/snaptrade-sync.service";

/** Hourly tick. Actual work is gated by ET-date + DB state, not the interval. */
const TICK_INTERVAL_MS = 60 * 60_000;

let started = false;
let running = false;
let lastRunAt: string | null = null;
let lastError: string | null = null;

export interface BrokerageRunnerState {
  started: boolean;
  running: boolean;
  lastRunAt: string | null;
  lastError: string | null;
}

export function getBrokerageRunnerState(): BrokerageRunnerState {
  return { started, running, lastRunAt, lastError };
}

/** Start the singleton runner. Idempotent — repeated calls are no-ops. */
export function startBrokerageRunner(): void {
  if (started) return;
  if (!snaptradeConfigured()) {
    console.log("[brokerage-runner] SnapTrade not configured — runner idle.");
    return;
  }
  started = true;
  console.log(
    `[brokerage-runner] started (post-close daily mirror; tick every ${TICK_INTERVAL_MS / 60_000}m)`,
  );
  void tick();
  setInterval(() => {
    void tick();
  }, TICK_INTERVAL_MS);
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    const links = await prisma.brokerageLink.findMany({ where: { status: "ACTIVE" } });
    if (links.length === 0) return;

    for (const link of links) {
      try {
        // Pick up any newly connected account under this link.
        await discoverAndLinkAccounts(link.userId);
      } catch (e) {
        console.error(`[brokerage-runner] discovery failed for link ${link.id}:`, e);
      }
      const accounts = await prisma.brokerageAccountLink.findMany({
        where: { brokerageLinkId: link.id },
        select: { id: true, lastSyncAt: true },
      });
      for (const a of accounts) {
        if (!isBrokerageSyncDue(a.lastSyncAt, now)) continue;
        const r = await syncBrokerageAccount(a.id);
        if (r.ok) {
          lastRunAt = new Date().toISOString();
          lastError = null;
        } else if (!r.deduped) {
          lastError = r.error ?? "unknown sync error";
          console.error(`[brokerage-runner] sync failed for account ${a.id}: ${lastError}`);
        }
      }
    }
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    console.error("[brokerage-runner] tick failed:", e);
  } finally {
    running = false;
  }
}
