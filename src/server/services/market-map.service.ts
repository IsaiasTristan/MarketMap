import type { PrismaClient } from "@prisma/client";
import type { BenchmarkCode, MetricKind, RowLevel } from "@/domain/entities/analytics";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { Horizon } from "@/domain/entities/horizons";
import type { DateClose } from "@/domain/calculations/alignment";
import { securityHorizonMetrics } from "@/domain/calculations/security-metrics";
import { riskFreeAnnual } from "@/infrastructure/config/env";

function dec(x: { toString(): string }): number {
  return Number(x.toString());
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function loadRecentPrices(
  db: PrismaClient,
  securityId: string,
  take = 320
): Promise<DateClose[]> {
  const rows = await db.priceHistory.findMany({
    where: { securityId },
    orderBy: { tradeDate: "desc" },
    take,
  });
  return rows
    .reverse()
    .map((p) => ({ date: iso(p.tradeDate), adjClose: dec(p.adjClose) }));
}

async function loadBenchmarkSeries(
  db: PrismaClient,
  code: BenchmarkCode
): Promise<DateClose[]> {
  const b = await db.benchmark.findUnique({ where: { code } });
  if (!b) return [];
  const rows = await db.benchmarkPriceHistory.findMany({
    where: { benchmarkId: b.id },
    orderBy: { tradeDate: "desc" },
    take: 320,
  });
  return rows
    .reverse()
    .map((p) => ({ date: iso(p.tradeDate), adjClose: dec(p.adjClose) }));
}

type CompanyRow = {
  ticker: string;
  name: string;
  sector: string;
  subTheme: string;
  lastDate: string | null;
  metrics: ReturnType<typeof securityHorizonMetrics>;
};

function pickMetric(
  m: ReturnType<typeof securityHorizonMetrics>,
  h: Horizon,
  metric: MetricKind
): number | null {
  const cell = m[h];
  if (!cell) return null;
  switch (metric) {
    case "RETURN":
      return cell.return;
    case "EXCESS_RETURN":
      return cell.excessReturn;
    case "VOLATILITY":
      return cell.volatility;
    case "SHARPE":
      return cell.sharpe;
    default:
      return null;
  }
}

function averageNullable(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export type MarketMapApiRow = {
  key: string;
  label: string;
  sector?: string;
  subTheme?: string;
  ticker?: string;
  cells: Record<Horizon, number | null>;
};

export async function computeMarketMap(
  db: PrismaClient,
  universeId: string,
  metric: MetricKind,
  rowLevel: RowLevel,
  benchmark: BenchmarkCode,
  filters: { sector?: string; subTheme?: string }
): Promise<{ rows: MarketMapApiRow[]; asOf: string | null; warnings: string[] }> {
  const warnings: string[] = [];
  const rf = riskFreeAnnual();

  const constituents = await db.universeConstituent.findMany({
    where: {
      universeId,
      ...(filters.sector ? { sector: filters.sector } : {}),
      ...(filters.subTheme ? { subTheme: filters.subTheme } : {}),
    },
    include: { security: true },
    orderBy: { sortOrder: "asc" },
  });

  if (constituents.length === 0) {
    return { rows: [], asOf: null, warnings: ["No constituents in this universe."] };
  }

  const benchSeries = await loadBenchmarkSeries(db, benchmark);
  if (metric === "EXCESS_RETURN" && benchSeries.length < 5) {
    warnings.push(
      "Benchmark series is empty or too short. Run “Refresh benchmarks” on the Universe page."
    );
  }

  const benchForStock =
    metric === "EXCESS_RETURN" && benchSeries.length >= 5 ? benchSeries : null;

  const companies: CompanyRow[] = [];

  for (const c of constituents) {
    const series = await loadRecentPrices(db, c.securityId);
    const lastDate = series.length ? series[series.length - 1]!.date : null;
    if (series.length < 5) {
      warnings.push(`Insufficient prices for ${c.security.ticker}`);
      continue;
    }
    const metrics = securityHorizonMetrics(series, benchForStock, rf);
    companies.push({
      ticker: c.security.ticker,
      name: c.security.name,
      sector: c.sector,
      subTheme: c.subTheme,
      lastDate,
      metrics,
    });
  }

  if (companies.length === 0) {
    return { rows: [], asOf: null, warnings };
  }

  const asOf = companies.reduce<string | null>((min, co) => {
    const d = co.lastDate;
    if (!d) return min;
    if (!min || d < min) return d;
    return min;
  }, null);

  const buildCells = (m: ReturnType<typeof securityHorizonMetrics>) => {
    const cells = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      cells[h] = pickMetric(m, h, metric);
    }
    return cells;
  };

  if (rowLevel === "COMPANY") {
    return {
      asOf,
      warnings,
      rows: companies.map((co) => ({
        key: co.ticker,
        label: `${co.ticker} — ${co.name}`,
        sector: co.sector,
        subTheme: co.subTheme,
        ticker: co.ticker,
        cells: buildCells(co.metrics),
      })),
    };
  }

  if (rowLevel === "SECTOR") {
    const sectors = [...new Set(companies.map((c) => c.sector))].sort();
    const rows: MarketMapApiRow[] = [];
    for (const s of sectors) {
      const group = companies.filter((c) => c.sector === s);
      const cells = {} as Record<Horizon, number | null>;
      for (const h of HORIZON_ORDER) {
        cells[h] = averageNullable(
          group.map((g) => pickMetric(g.metrics, h, metric))
        );
      }
      rows.push({ key: s, label: s, cells });
    }
    return { rows, asOf, warnings };
  }

  const keys = [
    ...new Set(companies.map((c) => `${c.sector}|||${c.subTheme}`)),
  ].sort();
  const rows: MarketMapApiRow[] = [];
  for (const k of keys) {
    const [sector, subTheme] = k.split("|||") as [string, string];
    const group = companies.filter(
      (c) => c.sector === sector && c.subTheme === subTheme
    );
    const cells = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      cells[h] = averageNullable(
        group.map((g) => pickMetric(g.metrics, h, metric))
      );
    }
    rows.push({
      key: k,
      label: `${sector} / ${subTheme}`,
      sector,
      subTheme,
      cells,
    });
  }
  return { rows, asOf, warnings };
}
