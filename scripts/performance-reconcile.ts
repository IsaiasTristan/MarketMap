/**
 * Read-only reconciliation of the actual-history reconstruction against the
 * live mirrored positions. For each managed portfolio it computes the
 * performance series and checks that the reconstructed CURRENT NAV equals the
 * independent "current signed shares × latest close + cash" — the number the
 * brokerage shows. A small residual is expected (options/crypto excluded, cash
 * rounding); a large gap means the ledger or price coverage is incomplete.
 *
 * Usage: npx tsx scripts/performance-reconcile.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { computePerformanceSeries } from "../src/server/services/performance.service";

async function latestClose(securityId: string): Promise<number | null> {
  const row = await prisma.priceHistory.findFirst({
    where: { securityId },
    orderBy: { tradeDate: "desc" },
    select: { close: true, adjClose: true },
  });
  if (!row) return null;
  return row.close != null ? Number(row.close) : Number(row.adjClose);
}

async function main() {
  const links = await prisma.brokerageAccountLink.findMany({
    where: { activityCount: { gt: 0 } },
    select: { portfolioId: true, institutionName: true, accountMask: true, activityCount: true },
  });
  if (links.length === 0) {
    console.log("[reconcile] no managed accounts with activities.");
    return;
  }

  for (const link of links) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`[reconcile] ${link.institutionName ?? "?"} …${link.accountMask ?? "????"} (${link.activityCount} activities)`);

    // Independent "brokerage" NAV: current signed shares × latest close + cash.
    const positions = await prisma.portfolioPosition.findMany({
      where: { portfolioId: link.portfolioId },
      include: { security: true },
    });
    let mirrorNav = 0;
    for (const p of positions) {
      if (p.isCash) {
        mirrorNav += p.cashAmount != null ? Number(p.cashAmount) : 0;
        continue;
      }
      if (!p.security) continue;
      const px = await latestClose(p.security.id);
      if (px == null) {
        console.log(`  [warn] no price for ${p.security.ticker}`);
        continue;
      }
      mirrorNav += (p.isShort ? -1 : 1) * Number(p.shares) * px;
    }

    const series = await computePerformanceSeries(link.portfolioId, "SP500");
    if (!series) {
      console.log("  [reconcile] no series (insufficient history).");
      continue;
    }
    const reconstructed = series.summary?.currentValue ?? null;
    console.log(`  basis:                ${series.basis}`);
    console.log(`  reconstructed NAV:    ${reconstructed != null ? "$" + reconstructed.toFixed(2) : "n/a"}`);
    console.log(`  mirror NAV (indep.):  $${mirrorNav.toFixed(2)}`);
    if (reconstructed != null) {
      const diff = reconstructed - mirrorNav;
      const pct = mirrorNav !== 0 ? (diff / mirrorNav) * 100 : 0;
      console.log(`  difference:           $${diff.toFixed(2)} (${pct.toFixed(3)}%)`);
    }
    console.log(`  total P&L:            $${series.summary?.totalPnlDollars.toFixed(2)}`);
    console.log(`  net contributions:    $${series.summary?.netContributions.toFixed(2)}`);
    console.log(`  benchmark (matched):  $${series.summary?.benchmarkValue.toFixed(2)}`);
    console.log(`  opening value:        $${series.summary?.openingValue.toFixed(2)}`);
    console.log(`  dataQuality:          ${JSON.stringify(series.dataQuality)}`);
    console.log(`  series points:        ${series.dates.length} (${series.dates[0]} → ${series.dates[series.dates.length - 1]})`);
  }
}

main()
  .catch((e) => {
    console.error("[performance-reconcile] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
