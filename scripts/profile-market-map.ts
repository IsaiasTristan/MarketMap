/**
 * Read-only profiler for the GET /market-map live-compute path.
 *
 * Context: the market-map route already serves a precomputed snapshot cache for
 * the COMPANY / non-overlay / unfiltered case (warm ~200ms). But the client
 * defaults `showExtended = true` (sends `extended=1`), and whenever a PRE/POST
 * extended-hours snapshot is in memory the route BYPASSES the cache and runs
 * the live `computeMarketMap(...)` synchronously on every request. That live
 * path is the suspected ~30s after-hours cost. This script measures exactly
 * that path, decomposed into:
 *
 *   in-DB SQL ms | Node Decimal deserialize ms | compute ms | serialize bytes
 *
 * It writes nothing. It uses its OWN PrismaClient with query-event logging so
 * `e.duration` (the Postgres-side execution time) can be subtracted from the
 * Node-side wall time to isolate the decimal.js materialization cost. A
 * `$queryRaw ... ::float8` probe over the same window quantifies the
 * Decimal-vs-float deserialization overhead directly.
 *
 * Mirrors the hot path in src/server/services/market-map.service.ts
 * (loadRecentPricesBatch + securityHorizonMetrics) so the numbers map 1:1.
 *
 * Usage: `npx tsx scripts/profile-market-map.ts [RUNS]`   (default RUNS=3)
 */
import { performance } from "node:perf_hooks";
import { PrismaClient, Prisma, type BenchmarkCode } from "@prisma/client";
import { securityHorizonMetrics } from "../src/domain/calculations/security-metrics";
import type { DateClose } from "../src/domain/calculations/alignment";
import { riskFreeAnnual } from "../src/infrastructure/config/env";
import { HORIZON_ORDER, type Horizon } from "../src/domain/entities/horizons";

// Mirror the service constants exactly.
const RECENT_BARS = 320;
const PRICE_LOOKBACK_DAYS = 600;

type QueryEvent = { query: string; durationMs: number };
const queryEvents: QueryEvent[] = [];

const prisma = new PrismaClient({
  log: [{ emit: "event", level: "query" }],
});
// Prisma's typed $on for "query" needs the event-typed overload; the client
// is constructed with the event emitter above so this is safe at runtime.
(prisma as unknown as {
  $on: (e: "query", cb: (ev: Prisma.QueryEvent) => void) => void;
}).$on("query", (ev) => {
  queryEvents.push({ query: ev.query, durationMs: ev.duration });
});

function dec(x: { toString(): string }): number {
  return Number(x.toString());
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function median(xs: number[]): number {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
/** Sum of Postgres-side durations for every query logged since `startIdx`. */
function sqlMsSince(startIdx: number): number {
  return queryEvents.slice(startIdx).reduce((a, e) => a + e.durationMs, 0);
}
/** Largest single Postgres-side duration since `startIdx` (the dominant query). */
function maxSqlMsSince(startIdx: number): number {
  return queryEvents.slice(startIdx).reduce((a, e) => Math.max(a, e.durationMs), 0);
}
function fmt(ms: number): string {
  return `${ms.toFixed(1)}ms`;
}

async function resolveUniverseId(): Promise<{ id: string; name: string }> {
  // Same selection the app uses (getOrCreateDefaultUniverse), read-only — we
  // never create, so if none exists we fail loudly rather than seeding.
  const u = await prisma.universe.findFirst({
    orderBy: { updatedAt: "desc" },
    select: { id: true, name: true },
  });
  if (!u) throw new Error("No universe found in the DB.");
  return u;
}

type StageTimings = {
  constituents: number;
  constituentCount: number;
  dbReadWall: number;
  dbReadSqlMax: number;
  dbReadSqlSum: number;
  rowCount: number;
  floatProbeWall: number;
  floatProbeSqlMax: number;
  computeReturn: number;
  computeExcess: number;
  serializeBytes: number;
};

/** Build the per-security map exactly like loadRecentPricesBatch. */
function groupAndTrim(
  rows: { securityId: string; tradeDate: Date; adjClose: { toString(): string } }[]
): Map<string, DateClose[]> {
  const out = new Map<string, DateClose[]>();
  for (const r of rows) {
    let arr = out.get(r.securityId);
    if (!arr) {
      arr = [];
      out.set(r.securityId, arr);
    }
    arr.push({ date: iso(r.tradeDate), adjClose: dec(r.adjClose) });
  }
  for (const [id, arr] of out) {
    if (arr.length > RECENT_BARS) out.set(id, arr.slice(-RECENT_BARS));
  }
  return out;
}

async function loadBenchSeries(code: string): Promise<DateClose[]> {
  const b = await prisma.benchmark.findUnique({ where: { code: code as BenchmarkCode } });
  if (!b) return [];
  const rows = await prisma.benchmarkPriceHistory.findMany({
    where: { benchmarkId: b.id },
    orderBy: { tradeDate: "desc" },
    take: 320,
  });
  return rows
    .reverse()
    .map((p) => ({ date: iso(p.tradeDate), adjClose: dec(p.adjClose) }));
}

async function runOnce(
  universeId: string,
  benchSeries: DateClose[]
): Promise<StageTimings> {
  const rf = riskFreeAnnual();

  // ── Stage A: constituents ────────────────────────────────────────────────
  let t0 = performance.now();
  const constituents = await prisma.universeConstituent.findMany({
    where: { universeId, security: { isActive: true } },
    include: { security: true },
    orderBy: { sortOrder: "asc" },
  });
  const constituentsMs = performance.now() - t0;
  const securityIds = constituents.map((c) => c.securityId);

  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - PRICE_LOOKBACK_DAYS);

  // ── Stage B: batched price read (Decimal) ────────────────────────────────
  const evIdxB = queryEvents.length;
  t0 = performance.now();
  const rows = await prisma.priceHistory.findMany({
    where: { securityId: { in: securityIds }, tradeDate: { gte: cutoff } },
    orderBy: { tradeDate: "asc" },
    select: { securityId: true, tradeDate: true, adjClose: true },
  });
  const dbReadWall = performance.now() - t0;
  const dbReadSqlMax = maxSqlMsSince(evIdxB);
  const dbReadSqlSum = sqlMsSince(evIdxB);

  // ── Stage B probe: same window, adjClose cast to float8 (no decimal.js) ──
  const evIdxF = queryEvents.length;
  t0 = performance.now();
  await prisma.$queryRaw<
    { securityId: string; tradeDate: Date; adjclose: number }[]
  >(
    Prisma.sql`SELECT "securityId", "tradeDate", "adjClose"::float8 AS adjclose
               FROM "PriceHistory"
               WHERE "securityId" IN (${Prisma.join(securityIds)})
                 AND "tradeDate" >= ${cutoff}
               ORDER BY "tradeDate" ASC`
  );
  const floatProbeWall = performance.now() - t0;
  const floatProbeSqlMax = maxSqlMsSince(evIdxF);

  // ── Stage C: compute (no DB) ─────────────────────────────────────────────
  const pricesBySecurity = groupAndTrim(rows);

  t0 = performance.now();
  for (const c of constituents) {
    const series = pricesBySecurity.get(c.securityId) ?? [];
    if (series.length < 5) continue;
    securityHorizonMetrics(series, null, rf);
  }
  const computeReturn = performance.now() - t0;

  const benchForStock = benchSeries.length >= 5 ? benchSeries : null;
  t0 = performance.now();
  for (const c of constituents) {
    const series = pricesBySecurity.get(c.securityId) ?? [];
    if (series.length < 5) continue;
    securityHorizonMetrics(series, benchForStock, rf);
  }
  const computeExcess = performance.now() - t0;

  // ── Stage D: serialize the COMPANY rows (transport payload proxy) ────────
  const apiRows = constituents
    .map((c) => {
      const series = pricesBySecurity.get(c.securityId) ?? [];
      if (series.length < 5) return null;
      const m = securityHorizonMetrics(series, null, rf);
      const cells = {} as Record<Horizon, number | null>;
      for (const h of HORIZON_ORDER) cells[h] = m[h]?.return ?? null;
      return {
        key: c.security.ticker,
        label: `${c.security.ticker} — ${c.security.name}`,
        sector: c.sector,
        subTheme: c.subTheme,
        ticker: c.security.ticker,
        cells,
        lastDate: series[series.length - 1]!.date,
      };
    })
    .filter((r) => r !== null);
  const serializeBytes = Buffer.byteLength(JSON.stringify(apiRows), "utf8");

  return {
    constituents: constituentsMs,
    constituentCount: constituents.length,
    dbReadWall,
    dbReadSqlMax,
    dbReadSqlSum,
    rowCount: rows.length,
    floatProbeWall,
    floatProbeSqlMax,
    computeReturn,
    computeExcess,
    serializeBytes,
  };
}

async function main() {
  const RUNS = Number.parseInt(process.argv[2] ?? "3", 10);
  const { id: universeId, name } = await resolveUniverseId();
  console.log(`[profile] universe: ${name} (${universeId})`);
  console.log(`[profile] RUNS=${RUNS} (+1 warmup), PRICE_LOOKBACK_DAYS=${PRICE_LOOKBACK_DAYS}, RECENT_BARS=${RECENT_BARS}`);

  const benchSeries = await loadBenchSeries("SP500");
  console.log(`[profile] SP500 benchmark bars loaded: ${benchSeries.length}`);

  // Cheap magnitude confirmation (counts only).
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - PRICE_LOOKBACK_DAYS);
  const activeConstituents = await prisma.universeConstituent.findMany({
    where: { universeId, security: { isActive: true } },
    select: { securityId: true },
  });
  const priceRowCount = await prisma.priceHistory.count({
    where: {
      securityId: { in: activeConstituents.map((c) => c.securityId) },
      tradeDate: { gte: cutoff },
    },
  });
  console.log(
    `[profile] magnitude: ${activeConstituents.length} active tickers, ${priceRowCount} price rows in the ${PRICE_LOOKBACK_DAYS}d window`
  );

  console.log("\n[profile] warmup run...");
  await runOnce(universeId, benchSeries);

  const results: StageTimings[] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runOnce(universeId, benchSeries);
    results.push(r);
    console.log(
      `[profile] run ${i + 1}: dbReadWall=${fmt(r.dbReadWall)} (sql=${fmt(r.dbReadSqlMax)}) compute(RET)=${fmt(r.computeReturn)} compute(EXC)=${fmt(r.computeExcess)}`
    );
  }

  const med = (sel: (t: StageTimings) => number) => median(results.map(sel));
  const dbReadWall = med((t) => t.dbReadWall);
  const dbReadSqlMax = med((t) => t.dbReadSqlMax);
  const dbReadSqlSum = med((t) => t.dbReadSqlSum);
  const nodeDeserialize = dbReadWall - dbReadSqlMax;
  const floatProbeWall = med((t) => t.floatProbeWall);
  const floatProbeSqlMax = med((t) => t.floatProbeSqlMax);
  const floatNodeDeserialize = floatProbeWall - floatProbeSqlMax;
  const computeReturn = med((t) => t.computeReturn);
  const computeExcess = med((t) => t.computeExcess);

  const constituentCount = results[0]!.constituentCount;
  const rowCount = results[0]!.rowCount;
  const serializeBytes = med((t) => t.serializeBytes);

  console.log("\n══════════════════ MEDIAN BREAKDOWN (live computeMarketMap path) ══════════════════");
  console.log(`tickers (active constituents) : ${constituentCount}`);
  console.log(`price rows materialized       : ${rowCount}`);
  console.log("");
  console.log(`Stage A  constituents findMany : ${fmt(med((t) => t.constituents))}`);
  console.log("Stage B  price read (Decimal):");
  console.log(`           in-DB SQL (max)     : ${fmt(dbReadSqlMax)}`);
  console.log(`           in-DB SQL (sum)     : ${fmt(dbReadSqlSum)}`);
  console.log(`           wall (Prisma+Node)  : ${fmt(dbReadWall)}`);
  console.log(`           Node deserialize    : ${fmt(nodeDeserialize)}  <- decimal.js materialization`);
  console.log("Stage B  probe (adjClose::float8):");
  console.log(`           in-DB SQL (max)     : ${fmt(floatProbeSqlMax)}`);
  console.log(`           wall                : ${fmt(floatProbeWall)}`);
  console.log(`           Node deserialize    : ${fmt(floatNodeDeserialize)}  <- float path (no Decimal)`);
  console.log(`           Decimal overhead    : ${fmt(nodeDeserialize - floatNodeDeserialize)}  (Decimal wall - float wall on Node side)`);
  console.log("Stage C  compute (securityHorizonMetrics):");
  console.log(`           metric=RETURN       : ${fmt(computeReturn)}`);
  console.log(`           metric=EXCESS_RETURN: ${fmt(computeExcess)}  (per-stock alignCloseSeries)`);
  console.log(`Stage D  JSON serialize        : ${(serializeBytes / 1024).toFixed(1)} KB (${serializeBytes} bytes)`);
  console.log("");
  const serverTotalReturn =
    med((t) => t.constituents) + dbReadWall + computeReturn;
  console.log(`Approx server time (A + B + C[RETURN]) : ${fmt(serverTotalReturn)}`);
  console.log("════════════════════════════════════════════════════════════════════════════════════");
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
