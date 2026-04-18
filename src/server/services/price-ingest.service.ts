import type { PrismaClient } from "@prisma/client";
import { Decimal } from "@prisma/client/runtime/library";
import { getMarketDataProvider } from "@/infrastructure/providers/factory";
import type { BenchmarkId } from "@/infrastructure/providers/market-data";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";

function toDateOnly(isoDate: string): Date {
  return new Date(`${isoDate}T12:00:00.000Z`);
}

function yearsAgoIso(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export async function ingestSecurityHistory(
  db: PrismaClient,
  ticker: string,
  years = 10
): Promise<{ securityId: string; bars: number }> {
  const provider = getMarketDataProvider();
  const upper = ticker.trim().toUpperCase();
  const meta =
    (await provider.fetchSecurityMetadata(upper)) ?? {
      ticker: upper,
      name: upper,
    };

  const security = await db.security.upsert({
    where: { ticker: upper },
    create: { ticker: upper, name: meta.name },
    update: { name: meta.name, isActive: true },
  });

  const start = yearsAgoIso(years);
  const end = new Date().toISOString().slice(0, 10);
  const bars = await provider.fetchHistoricalPrices(upper, start, end);

  for (const b of bars) {
    await db.priceHistory.upsert({
      where: {
        securityId_tradeDate: {
          securityId: security.id,
          tradeDate: toDateOnly(b.date),
        },
      },
      create: {
        securityId: security.id,
        tradeDate: toDateOnly(b.date),
        adjClose: new Decimal(b.adjClose),
        close: b.close != null ? new Decimal(b.close) : null,
        volume: null,
      },
      update: {
        adjClose: new Decimal(b.adjClose),
        close: b.close != null ? new Decimal(b.close) : null,
      },
    });
  }

  return { securityId: security.id, bars: bars.length };
}

export async function ingestBenchmarkHistory(
  db: PrismaClient,
  code: BenchmarkId,
  years = 10
): Promise<{ benchmarkId: string; bars: number }> {
  await ensureBenchmarksSeeded(db);
  const bench = await db.benchmark.findUniqueOrThrow({ where: { code } });
  const provider = getMarketDataProvider();
  const start = yearsAgoIso(years);
  const end = new Date().toISOString().slice(0, 10);
  const bars = await provider.fetchBenchmarkSeries(code, start, end);

  for (const b of bars) {
    await db.benchmarkPriceHistory.upsert({
      where: {
        benchmarkId_tradeDate: {
          benchmarkId: bench.id,
          tradeDate: toDateOnly(b.date),
        },
      },
      create: {
        benchmarkId: bench.id,
        tradeDate: toDateOnly(b.date),
        adjClose: new Decimal(b.adjClose),
      },
      update: { adjClose: new Decimal(b.adjClose) },
    });
  }

  return { benchmarkId: bench.id, bars: bars.length };
}
