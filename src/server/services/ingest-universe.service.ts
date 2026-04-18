import type { PrismaClient } from "@prisma/client";
import {
  ingestBenchmarkHistory,
  ingestSecurityHistory,
} from "@/server/services/price-ingest.service";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";

export async function ingestUniverseSecurities(
  db: PrismaClient,
  universeId: string,
  years = 10
): Promise<{ tickers: number; bars: number }> {
  const job = await db.refreshJob.create({
    data: {
      type: "MARKET_DATA",
      status: "RUNNING",
      startedAt: new Date(),
      metadata: { universeId },
    },
  });
  let bars = 0;
  try {
    const cons = await db.universeConstituent.findMany({
      where: { universeId },
      include: { security: true },
    });
    for (const c of cons) {
      const r = await ingestSecurityHistory(db, c.security.ticker, years);
      bars += r.bars;
    }
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        metadata: { universeId, tickers: cons.length, bars },
      },
    });
    return { tickers: cons.length, bars };
  } catch (e) {
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}

export async function ingestAllBenchmarks(
  db: PrismaClient,
  years = 10
): Promise<{ bars: number }> {
  await ensureBenchmarksSeeded(db);
  const job = await db.refreshJob.create({
    data: {
      type: "BENCHMARK",
      status: "RUNNING",
      startedAt: new Date(),
    },
  });
  let bars = 0;
  try {
    for (const code of ["SP500", "NASDAQ", "DOW"] as const) {
      const r = await ingestBenchmarkHistory(db, code, years);
      bars += r.bars;
    }
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "SUCCEEDED",
        finishedAt: new Date(),
        metadata: { bars },
      },
    });
    return { bars };
  } catch (e) {
    await db.refreshJob.update({
      where: { id: job.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage: e instanceof Error ? e.message : String(e),
      },
    });
    throw e;
  }
}
