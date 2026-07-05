/**
 * Share-class economic merge — DB normalization pass (Engine 3).
 *
 * Folds stored non-canonical class rows (GOOG, FOX) into their canonical sibling
 * (GOOGL, FOXA) on `FundHoldingSnapshot`, per (fund, quarter), so every downstream
 * computation reads ONE economic position per issuer. Runs at the very start of
 * `runInstitutionalAggregate` — BEFORE the diff pass — so prevShares / action /
 * tenure / initiations / flow are all derived from merged positions.
 *
 * Idempotent: once folded, no non-canonical rows remain, so re-runs are no-ops
 * (until a fresh ingest re-adds them — `aggregateHoldings` also canonicalizes, so
 * fresh writes land merged and this pass only ever mops up historical rows or a
 * fund holding both classes in the same filing).
 *
 * `pctOfBook` is additive (both classes were divided by the same fund-period book),
 * so the merge sums shares + value + pctOfBook exactly — no book-value lookup. Raw
 * per-class 13F rows are concatenated into the surviving row's `rawJson` for
 * reconciliation. Emits one `DataQualityEvent{kind:"share_class_merge"}` per pair.
 */
import { prisma } from "@/infrastructure/db/client";
import { SHARE_CLASS_CANONICAL } from "@/lib/institutional/share-class-merge";

const iso = (d: Date): string => d.toISOString().slice(0, 10);
const minDate = (a: Date | null, b: Date | null): Date | null =>
  a && b ? (a <= b ? a : b) : (a ?? b);

function asRawArray(j: unknown): unknown[] {
  return Array.isArray(j) ? j : j == null ? [] : [j];
}

export async function normalizeShareClasses(
  log: (m: string) => void = () => {},
): Promise<{ merged: number; renamed: number; pairsAffected: Record<string, number> }> {
  const nonCanonical = Object.keys(SHARE_CLASS_CANONICAL);
  const rows = await prisma.fundHoldingSnapshot.findMany({
    where: { ticker: { in: nonCanonical } },
    select: {
      id: true, fundId: true, filingPeriod: true, ticker: true, cusip: true, nameOfIssuer: true,
      shares: true, value: true, pctOfBook: true, filingDate: true, acceptedDate: true, rawJson: true,
    },
  });
  if (rows.length === 0) {
    log("[institutional-agg] share-class merge: no non-canonical rows (already merged)");
    return { merged: 0, renamed: 0, pairsAffected: {} };
  }

  let merged = 0;
  let renamed = 0;
  const pairsAffected: Record<string, number> = {};

  for (const r of rows) {
    const canonTicker = SHARE_CLASS_CANONICAL[r.ticker]!;
    const pairKey = `${r.ticker}->${canonTicker}`;
    const sibling = await prisma.fundHoldingSnapshot.findUnique({
      where: { fundId_ticker_filingPeriod: { fundId: r.fundId, ticker: canonTicker, filingPeriod: r.filingPeriod } },
      select: {
        id: true, shares: true, value: true, pctOfBook: true, filingDate: true, acceptedDate: true, rawJson: true,
      },
    });

    if (!sibling) {
      // Fund holds only the non-canonical class this quarter → rename in place.
      // shares/value/pctOfBook are unchanged; only the economic identity changes.
      await prisma.fundHoldingSnapshot.update({ where: { id: r.id }, data: { ticker: canonTicker } });
      renamed += 1;
    } else {
      const newShares = Number(sibling.shares) + Number(r.shares);
      const newValue = Number(sibling.value) + Number(r.value);
      const newPct =
        sibling.pctOfBook == null && r.pctOfBook == null
          ? null
          : (sibling.pctOfBook ?? 0) + (r.pctOfBook ?? 0);
      const mergedRaw = [...asRawArray(sibling.rawJson), ...asRawArray(r.rawJson)];
      await prisma.$transaction([
        prisma.fundHoldingSnapshot.update({
          where: { id: sibling.id },
          data: {
            shares: newShares.toFixed(2),
            value: newValue.toFixed(2),
            pctOfBook: newPct,
            filingDate: minDate(sibling.filingDate, r.filingDate),
            acceptedDate: minDate(sibling.acceptedDate, r.acceptedDate),
            rawJson: mergedRaw as unknown as import("@prisma/client").Prisma.InputJsonValue,
          },
        }),
        prisma.fundHoldingSnapshot.delete({ where: { id: r.id } }),
      ]);
      merged += 1;
    }
    pairsAffected[pairKey] = (pairsAffected[pairKey] ?? 0) + 1;
  }

  // One audit event per canonical pair (not per fund-period row).
  for (const [pair, count] of Object.entries(pairsAffected)) {
    const [from, to] = pair.split("->");
    await prisma.dataQualityEvent.create({
      data: {
        kind: "share_class_merge",
        ticker: to,
        payload: { from, to, fundPeriodsFolded: count } as unknown as import("@prisma/client").Prisma.InputJsonValue,
      },
    });
  }

  log(
    `[institutional-agg] share-class merge: ${merged} folded + ${renamed} renamed across ${rows.length} rows ` +
      `(${Object.entries(pairsAffected).map(([p, n]) => `${p}:${n}`).join(", ")})`,
  );
  return { merged, renamed, pairsAffected };
}
