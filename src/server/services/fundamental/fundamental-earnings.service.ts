/**
 * Engine 2 — per-report earnings surprise ingestion. Fetches FMP /stable/earnings
 * (reported EPS/revenue actuals + the consensus immediately before each report)
 * and persists EarningsSurprise rows write-once (existing figures never
 * overwritten), keyed (ticker, reportDate). Feeds the Earnings & Revenue
 * Surprise box and the residual-return-since-last-earnings momentum component.
 *
 * The consensus is FMP's pre-announcement estimate — never an estimate updated
 * after the release — so the surprise is point-in-time correct for the report.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { fetchEarningsHistory } from "@/infrastructure/providers/fmp";

const EARNINGS_LIMIT = 20; // ~5 years of quarterly reports

/** Fetch + persist one ticker's earnings surprises write-once. Returns inserted count. */
export async function persistEarningsSurprises(
  ticker: string,
  snapshotDate: string,
): Promise<number> {
  const t = ticker.toUpperCase();
  const rows = await fetchEarningsHistory(t, EARNINGS_LIMIT);
  // Keep only rows with at least one actual figure (drop pure future placeholders).
  const reported = rows.filter((r) => r.epsActual !== null || r.revenueActual !== null);
  if (reported.length === 0) return 0;

  const existing = await prisma.earningsSurprise.findMany({
    where: { ticker: t },
    select: { reportDate: true },
  });
  const have = new Set(existing.map((e) => e.reportDate.toISOString().slice(0, 10)));
  const snap = new Date(`${snapshotDate}T00:00:00Z`);

  const toCreate: Prisma.EarningsSurpriseCreateManyInput[] = [];
  for (const r of reported) {
    if (have.has(r.reportDate)) continue; // write-once
    toCreate.push({
      ticker: t,
      reportDate: new Date(`${r.reportDate}T00:00:00Z`),
      epsActual: r.epsActual,
      epsEstimated: r.epsEstimated,
      revenueActual: r.revenueActual,
      revenueEstimated: r.revenueEstimated,
      firstSeenSnapshotDate: snap,
    });
  }
  if (toCreate.length === 0) return 0;
  const res = await prisma.earningsSurprise.createMany({ data: toCreate, skipDuplicates: true });
  return res.count;
}
