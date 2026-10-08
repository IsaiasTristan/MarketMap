/**
 * snaptrade-sync.service — mirror one connected brokerage account into its
 * managed portfolio.
 *
 * Auto-mirror semantics: on every sync the portfolio is overwritten from the
 * brokerage (positions replaced, cash reset) so the app and the brokerage can
 * never silently disagree. Manual editing of a managed portfolio is blocked at
 * the API layer (see `requireUnmanagedPortfolio`).
 *
 * Onboarding: `replacePositions` creates bare Security rows for tickers new to
 * the DB, so after the write we backfill sector/country/currency and ingest
 * 10y of price history for any ticker with none — otherwise PnL, allocation,
 * and factor panels have nothing to read.
 *
 * The whole run is wrapped in the shared in-flight lock so the runner and a
 * manual "Sync now" can't stampede the same account.
 */
import { prisma } from "@/infrastructure/db/client";
import {
  replacePositions,
  addCashPosition,
} from "@/server/services/position.service";
import { withIngestLock } from "@/server/services/ingest-inflight";
import { writeAuditLog } from "@/server/services/audit.service";
import { getSnapTradeClient } from "@/infrastructure/providers/snaptrade/client";
import { onboardNewTickers } from "@/server/services/brokerage/onboard-tickers";
import { syncAccountActivities } from "@/server/services/brokerage/snaptrade-activities.service";
import {
  mapSnapTradePositions,
  type SkippedPosition,
} from "@/lib/brokerage/snaptrade-positions";
import type {
  SnapTradeBalance,
  SnapTradePosition,
} from "@/infrastructure/providers/snaptrade/types";

export interface BrokerageSyncResult {
  ok: boolean;
  deduped?: boolean;
  positionCount: number;
  cash: number | null;
  skipped: SkippedPosition[];
  error?: string;
}

function normalizePositions(results: unknown[]): SnapTradePosition[] {
  return results.map((raw) => {
    const r = raw as {
      instrument?: { kind?: string | null; symbol?: string | null } | null;
      units?: string | number | null;
      cash_equivalent?: boolean | null;
      currency?: string | null;
    };
    return {
      kind: r.instrument?.kind ?? null,
      symbol: r.instrument?.symbol ?? null,
      units: r.units ?? null,
      cashEquivalent: r.cash_equivalent === true,
      currency: r.currency ?? null,
    };
  });
}

function normalizeBalances(balances: unknown[]): SnapTradeBalance[] {
  return balances.map((raw) => {
    const b = raw as { currency?: { code?: string | null } | null; cash?: number | null };
    return { currency: b.currency?.code ?? null, cash: b.cash ?? null };
  });
}

function errMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const anyE = e as { response?: { data?: unknown }; message?: string };
    const data = anyE.response?.data;
    if (data) return typeof data === "string" ? data : JSON.stringify(data);
    if (anyE.message) return anyE.message;
  }
  return String(e);
}

/**
 * Sync a single managed account. Idempotent and safe to call from both the
 * runner and the manual route. Records the outcome on the BrokerageAccountLink
 * and never throws for expected failures (returns `ok:false` with an error).
 */
export async function syncBrokerageAccount(
  accountLinkId: string,
): Promise<BrokerageSyncResult> {
  const link = await prisma.brokerageAccountLink.findUnique({
    where: { id: accountLinkId },
    include: { brokerageLink: true },
  });
  if (!link) {
    return { ok: false, positionCount: 0, cash: null, skipped: [], error: "Account link not found." };
  }

  const outcome = await withIngestLock(`brokerage:${accountLinkId}`, async () => {
    try {
      const client = getSnapTradeClient();

      const [posResp, balResp] = await Promise.all([
        client.accountInformation.getAllAccountPositions({
          accountId: link.snaptradeAccountId,
        }),
        client.accountInformation.getUserAccountBalance({
          accountId: link.snaptradeAccountId,
        }),
      ]);

      const positions = normalizePositions(posResp.data?.results ?? []);
      const balances = normalizeBalances(balResp.data ?? []);
      const mapped = mapSnapTradePositions(positions, balances);

      // Overwrite the portfolio from the brokerage. Order matters:
      // replacePositions wipes the whole portfolio, so cash is written after.
      await replacePositions(link.portfolioId, mapped.equities);
      if (mapped.cash != null && mapped.cash > 0) {
        await addCashPosition(link.portfolioId, mapped.cash);
      }

      await onboardNewTickers(mapped.equities.map((e) => e.ticker));

      // Transaction history — the ledger that powers the actual-holdings
      // performance reconstruction. Non-fatal: a mirror is still useful without
      // it, and the next sync retries.
      try {
        await syncAccountActivities(accountLinkId);
      } catch (e) {
        console.error(`[brokerage-sync] activity sweep failed for ${accountLinkId}:`, e);
      }

      await prisma.brokerageAccountLink.update({
        where: { id: accountLinkId },
        data: {
          lastSyncAt: new Date(),
          lastSyncStatus: "OK",
          lastSyncError: null,
          positionCount: mapped.equities.length,
          skippedJson: mapped.skipped as unknown as object,
        },
      });
      await writeAuditLog("brokerage.sync", {
        accountLinkId,
        portfolioId: link.portfolioId,
        positionCount: mapped.equities.length,
        cash: mapped.cash,
        skipped: mapped.skipped.length,
      });

      return {
        ok: true,
        positionCount: mapped.equities.length,
        cash: mapped.cash,
        skipped: mapped.skipped,
      } satisfies BrokerageSyncResult;
    } catch (e) {
      const error = errMessage(e);
      await prisma.brokerageAccountLink.update({
        where: { id: accountLinkId },
        data: { lastSyncAt: new Date(), lastSyncStatus: "ERROR", lastSyncError: error.slice(0, 500) },
      });
      await writeAuditLog("brokerage.sync_error", { accountLinkId, error: error.slice(0, 500) });
      return { ok: false, positionCount: 0, cash: null, skipped: [], error } satisfies BrokerageSyncResult;
    }
  });

  if (!outcome.ran) {
    return { ok: false, deduped: true, positionCount: 0, cash: null, skipped: [] };
  }
  return outcome.result;
}
