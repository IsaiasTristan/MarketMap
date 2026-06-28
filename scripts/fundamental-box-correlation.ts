/**
 * Engine 2 — cross-box correlation / duplication review (report-only).
 *
 * Loads the latest FundamentalScore cross-section, computes pairwise Pearson
 * correlation between the nine box scores, prints the matrix, and flags pairs
 * with |rho| >= 0.80 (plan section 21). V1 does NOT eliminate correlated boxes —
 * the equal-weight composite is unchanged — this just surfaces duplication for
 * later review.
 *
 * Usage:
 *   npx tsx scripts/fundamental-box-correlation.ts
 *   npx tsx scripts/fundamental-box-correlation.ts --threshold=0.7
 */
import { prisma } from "../src/infrastructure/db/client";
import {
  boxCorrelationReport,
  DEFAULT_CORRELATION_FLAG,
  type BoxScoreRecord,
} from "../src/lib/fundamental/box-correlation";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

async function main() {
  const threshold = Number(opt("threshold") ?? DEFAULT_CORRELATION_FLAG);
  const latest = await prisma.fundamentalScore.findFirst({
    orderBy: { snapshotDate: "desc" },
    select: { snapshotDate: true },
  });
  if (!latest) {
    console.log("[box-corr] no FundamentalScore rows — run the fundamentals scoring job first.");
    return;
  }
  const scores = await prisma.fundamentalScore.findMany({
    where: { snapshotDate: latest.snapshotDate },
    select: { scoreJson: true },
  });
  const rows: BoxScoreRecord[] = scores.map((s) => {
    const sj = s.scoreJson as { boxScores?: BoxScoreRecord["boxScores"] } | null;
    return { boxScores: sj?.boxScores };
  });

  const report = boxCorrelationReport(rows, threshold);
  const iso = latest.snapshotDate.toISOString().slice(0, 10);
  console.log(`[box-corr] ${iso} · ${rows.length} names · threshold |rho| >= ${threshold}\n`);

  // Matrix
  const header = ["          ", ...report.keys.map((k) => k.slice(0, 6).padStart(7))].join("");
  console.log(header);
  report.matrix.forEach((row, i) => {
    const label = report.keys[i]!.slice(0, 10).padEnd(10);
    const cells = row
      .map((v) => (v === null ? "     —" : v.toFixed(2).padStart(6)))
      .map((c) => ` ${c}`)
      .join("");
    console.log(label + cells);
  });

  console.log("\n[box-corr] flagged pairs (|rho| >= threshold):");
  if (report.flagged.length === 0) {
    console.log("  none — no box pair is highly correlated at this threshold.");
  } else {
    for (const p of report.flagged) {
      console.log(`  ${p.a} ~ ${p.b}: rho=${p.rho.toFixed(3)} (n=${p.n})`);
    }
    console.log(
      "\n  NOTE (V1): report-only. Correlated boxes are NOT removed; the composite stays equal-weight.",
    );
  }
}

main()
  .catch((e) => {
    console.error("[box-corr] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
