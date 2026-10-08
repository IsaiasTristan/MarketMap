/**
 * onboard-tickers — shared backfill for brokerage-sourced tickers the DB has
 * not seen before. Used by both the position mirror and the activity ledger
 * sweep: any ticker that ever appears (including names fully sold out of the
 * current book) needs a Security row + price history, or the reconstructed NAV
 * series has holes.
 *
 * Best-effort: profile and price failures are swallowed so one bad symbol never
 * aborts a sync; the daily price-tail runner retries missing history.
 */
import { prisma } from "@/infrastructure/db/client";
import { ingestSecurityHistory } from "@/server/services/price-ingest.service";
import { fetchYahooFundamentals } from "@/infrastructure/providers/yahoo-fundamentals";

/** Backfill profile + price history for tickers with none. */
export async function onboardNewTickers(tickers: string[]): Promise<void> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return;
  const secs = await prisma.security.findMany({
    where: { ticker: { in: unique } },
    select: {
      id: true,
      ticker: true,
      sector: true,
      _count: { select: { priceHistory: true } },
    },
  });
  for (const sec of secs) {
    if (!sec.sector) {
      try {
        const fund = await fetchYahooFundamentals(sec.ticker);
        if (fund.sector || fund.country || fund.currency) {
          await prisma.security.updateMany({
            where: { id: sec.id },
            data: {
              sector: fund.sector ?? undefined,
              country: fund.country ?? undefined,
              currency: fund.currency ?? undefined,
            },
          });
        }
      } catch {
        // profile backfill is best-effort
      }
    }
    if (sec._count.priceHistory === 0) {
      try {
        await ingestSecurityHistory(prisma, sec.ticker, 10);
      } catch {
        // price ingest is best-effort; the daily tail runner will retry
      }
    }
  }
}

/**
 * Ensure a bare Security row exists for each ticker (so the ledger can reference
 * tickers that were sold out and never mirrored as a position), then onboard
 * profile + history. `createMany skipDuplicates` keeps this idempotent.
 */
export async function ensureSecuritiesAndOnboard(tickers: string[]): Promise<void> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return;
  const existing = await prisma.security.findMany({
    where: { ticker: { in: unique } },
    select: { ticker: true },
  });
  const have = new Set(existing.map((s) => s.ticker));
  const missing = unique.filter((t) => !have.has(t));
  if (missing.length > 0) {
    await prisma.security.createMany({
      data: missing.map((ticker) => ({ ticker, name: ticker })),
      skipDuplicates: true,
    });
  }
  await onboardNewTickers(unique);
}
