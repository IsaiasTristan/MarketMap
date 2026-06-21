/**
 * Read-only diagnostic: for every active universe constituent, report the
 * most recent PriceHistory tradeDate (and how many calendar days behind
 * "now" that is), sorted oldest-first. Surfaces the ticker(s) responsible
 * for the grid's "Bars through … (Nd behind)" banner — which uses the
 * MIN lastDate across the universe.
 *
 * Usage:
 *   npx tsx scripts/freshness-audit.ts            # all universes
 *   npx tsx scripts/freshness-audit.ts UNIV_ID    # one universe
 */
import { prisma } from "../src/infrastructure/db/client";

function daysBehind(d: Date | null | undefined): number {
  if (!d) return Number.POSITIVE_INFINITY;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

function fmtDate(d: Date | null | undefined): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

async function auditUniverse(universeId: string, name: string) {
  const constituents = await prisma.universeConstituent.findMany({
    where: { universeId, security: { isActive: true } },
    include: {
      security: {
        select: {
          ticker: true,
          delistCandidate: true,
          consecutiveMisses: true,
          firstMissedAt: true,
          lastMissedAt: true,
          priceHistory: {
            select: { tradeDate: true },
            orderBy: { tradeDate: "desc" },
            take: 1,
          },
          _count: { select: { priceHistory: true } },
        },
      },
    },
  });

  const rows = constituents
    .map((c) => {
      const last = c.security.priceHistory[0]?.tradeDate ?? null;
      return {
        ticker: c.security.ticker,
        last,
        lag: daysBehind(last),
        bars: c.security._count.priceHistory,
        candidate: c.security.delistCandidate,
        misses: c.security.consecutiveMisses,
        firstMissed: c.security.firstMissedAt,
        lastMissed: c.security.lastMissedAt,
      };
    })
    .sort((a, b) => b.lag - a.lag);

  console.log("");
  console.log(`=== Universe: ${name} (${universeId}) ===`);
  console.log(
    `${constituents.length} active constituents. ` +
      `Min lastDate (drives "behind" banner): ${fmtDate(
        rows.length ? rows[0]!.last : null
      )} (${rows.length ? rows[0]!.lag : "—"}d behind)`
  );

  const stale = rows.filter((r) => r.lag > 2);
  console.log("");
  console.log(`Stale tickers (> 2 calendar days behind): ${stale.length}`);
  if (stale.length === 0) {
    console.log("  (none — grid should NOT be showing the banner)");
    return;
  }

  console.log("");
  console.log(
    "  ticker    last-bar     lag  bars  delistCand  misses  firstMissed     lastMissed"
  );
  console.log(
    "  --------- ----------  ----  ----  ----------  ------  --------------  --------------"
  );
  for (const r of stale) {
    console.log(
      `  ${r.ticker.padEnd(9)} ${fmtDate(r.last).padEnd(10)}  ${String(
        r.lag
      ).padStart(4)}  ${String(r.bars).padStart(4)}  ${
        r.candidate ? "YES       " : "no        "
      }  ${String(r.misses).padStart(6)}  ${fmtDate(r.firstMissed).padEnd(
        14
      )}  ${fmtDate(r.lastMissed).padEnd(14)}`
    );
  }
}

async function main() {
  const universeId = process.argv[2] || null;
  const universes = universeId
    ? await prisma.universe.findMany({
        where: { id: universeId },
        select: { id: true, name: true },
      })
    : await prisma.universe.findMany({
        select: { id: true, name: true },
        orderBy: { createdAt: "asc" },
      });

  if (universes.length === 0) {
    console.error("No universes found.");
    process.exit(1);
  }

  for (const u of universes) {
    await auditUniverse(u.id, u.name);
  }

  // Also report benchmark freshness — it's a separate code path and worth
  // confirming when the grid is in EXCESS_RETURN mode.
  const benches = await prisma.benchmark.findMany({
    select: {
      code: true,
      priceHistory: {
        select: { tradeDate: true },
        orderBy: { tradeDate: "desc" },
        take: 1,
      },
    },
  });
  console.log("");
  console.log("=== Benchmarks ===");
  for (const b of benches) {
    const last = b.priceHistory[0]?.tradeDate ?? null;
    console.log(
      `  ${b.code.padEnd(8)} last=${fmtDate(last)} (${daysBehind(last)}d behind)`
    );
  }
}

main()
  .catch((e) => {
    console.error("[freshness-audit] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
