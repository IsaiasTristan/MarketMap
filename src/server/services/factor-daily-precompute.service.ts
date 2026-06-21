/**
 * factor-daily-precompute.service — single source of truth for the
 * "ingest latest close -> refresh factor pipeline -> precompute grids" chain.
 *
 * Consumed by:
 *   - scripts/daily-precompute.ts             (CLI / Windows Task Scheduler)
 *   - server/services/precompute-runner.ts    (server-startup catch-up)
 *
 * Idempotent — safe to call again concurrently in another process; per-row
 * upserts mean last writer wins.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  refreshBenchmarksTail,
  refreshUniverseTail,
} from "./ingest-universe.service";
import { refreshFactorPipeline } from "./factor-pipeline.service";
import { refreshMacroFactorPipeline } from "./factor-pipeline-macro.service";
import {
  precomputeAllPerStockGrids,
  type GridPrecomputeEntry,
} from "./factor-per-stock-cache.service";

export interface DailyPrecomputeSummary {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  prices: {
    bars: number;
    failures: string[];
  };
  factors: {
    ff: "fulfilled" | "rejected";
    macro: "fulfilled" | "rejected";
    ffError?: string;
    macroError?: string;
  };
  grids: GridPrecomputeEntry[];
}

/**
 * Run the full daily refresh chain end-to-end.
 *
 * Steps:
 *   1. Price tail refresh (benchmarks + every universe) — ingests the latest
 *      trading sessions so prices reach the last close.
 *   2. Factor pipeline refresh (Fama-French + Macro, in parallel).
 *   3. Per-stock grid precompute for every (model, window) the UI exposes.
 *
 * Never throws on per-step failures — failures are recorded in the summary so
 * the caller can decide what to do. Throws only on hard preconditions (no
 * universes configured, DB unavailable). The caller is expected to log.
 */
export async function runDailyPrecompute(
  opts: { tailDays?: number; log?: (msg: string) => void } = {},
): Promise<DailyPrecomputeSummary> {
  const tailDays = Math.max(1, opts.tailDays ?? 10);
  const log = opts.log ?? (() => {});
  const startedAt = new Date();
  log(`[daily-precompute] tailDays=${tailDays} starting…`);

  // --- Step 1: price tail refresh ------------------------------------------
  const universes = await prisma.universe.findMany({
    select: { id: true, name: true },
    orderBy: { createdAt: "asc" },
  });
  if (universes.length === 0) {
    throw new Error("No universes configured — nothing to refresh.");
  }

  let totalBars = 0;
  const priceFailures: string[] = [];
  try {
    const r = await refreshBenchmarksTail(prisma, tailDays);
    totalBars += r.bars;
    log(`[daily-precompute] benchmarks: ${r.bars} bars, ${r.failed.length} failed`);
    for (const f of r.failed) priceFailures.push(`benchmark:${f.code} — ${f.error}`);
  } catch (e) {
    priceFailures.push(`benchmarks — ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const u of universes) {
    try {
      const r = await refreshUniverseTail(prisma, u.id, tailDays);
      totalBars += r.bars;
      log(
        `[daily-precompute] ${u.name}: ${r.tickers} tickers, ${r.bars} bars, ${r.failed.length} failed`,
      );
      for (const f of r.failed) priceFailures.push(`${u.name}:${f.ticker} — ${f.error}`);
    } catch (e) {
      priceFailures.push(`${u.name} — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  log(
    `[daily-precompute] prices: ${totalBars} bars upserted, ${priceFailures.length} failures.`,
  );

  // --- Step 2: factor pipeline refresh -------------------------------------
  const [ff, macro] = await Promise.allSettled([
    refreshFactorPipeline(),
    refreshMacroFactorPipeline(),
  ]);
  log(
    `[daily-precompute] factor pipeline: FF=${ff.status}, macro=${macro.status}`,
  );
  if (ff.status === "rejected") log(`  FF — ${(ff.reason as Error).message}`);
  if (macro.status === "rejected") log(`  macro — ${(macro.reason as Error).message}`);

  // --- Step 3: per-stock grid precompute -----------------------------------
  const grid = await precomputeAllPerStockGrids();
  for (const e of grid.entries) {
    const detail =
      e.status === "ok"
        ? `${e.rows} rows, asOf ${e.asOfDate}`
        : e.status === "error"
          ? `ERROR ${e.error}`
          : "empty";
    log(
      `[daily-precompute] grid ${e.model} w${e.window}: ${e.status} (${detail}) in ${(e.elapsedMs / 1000).toFixed(1)}s`,
    );
  }

  const finishedAt = new Date();
  const totalMs = finishedAt.getTime() - startedAt.getTime();
  log(
    `[daily-precompute] done in ${(totalMs / 1000).toFixed(1)}s. ${grid.entries.filter((e) => e.status === "ok").length}/${grid.entries.length} grids cached.`,
  );

  return {
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    totalMs,
    prices: { bars: totalBars, failures: priceFailures },
    factors: {
      ff: ff.status,
      macro: macro.status,
      ffError: ff.status === "rejected" ? (ff.reason as Error).message : undefined,
      macroError:
        macro.status === "rejected" ? (macro.reason as Error).message : undefined,
    },
    grids: grid.entries,
  };
}
