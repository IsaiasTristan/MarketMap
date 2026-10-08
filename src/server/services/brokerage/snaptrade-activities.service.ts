/**
 * snaptrade-activities.service — sweep one managed account's transaction
 * history from SnapTrade `getAccountActivities` into the write-once
 * `BrokerageActivity` ledger.
 *
 * This ledger is the sole input (with prices) to the actual-holdings
 * performance reconstruction. It is append-only and idempotent: the natural key
 * `(accountLinkId, externalId)` dedupes re-fetches, and an in-app existing-key
 * filter guarantees a re-sweep writes zero even though Postgres NULLs would not
 * collide in the unique index (the same trap documented for the TipRanks sweep).
 *
 * Cadence: called from `syncBrokerageAccount` after the position mirror, so the
 * hourly brokerage runner and the manual "Sync now" both keep it current. On
 * later runs only the tail (from `lastActivitySyncAt - 7d`) is re-fetched.
 */
import { prisma } from "@/infrastructure/db/client";
import { withIngestLock } from "@/server/services/ingest-inflight";
import { writeAuditLog } from "@/server/services/audit.service";
import { getSnapTradeClient } from "@/infrastructure/providers/snaptrade/client";
import { ensureSecuritiesAndOnboard } from "@/server/services/brokerage/onboard-tickers";
import { tradeDateEtFromUnix } from "@/lib/market-map/market-session";
import { normalizeActivityType, type ActivityTypeCode } from "@/lib/portfolio/holdings-replay";
import { Prisma } from "@prisma/client";

const PAGE_LIMIT = 1000;
const TAIL_LOOKBACK_DAYS = 7;

export interface ActivitySyncResult {
  ok: boolean;
  deduped?: boolean;
  fetched: number;
  written: number;
  earliestDate: string | null;
  unknownTypes: string[];
  unvaluedInstruments: string[];
  error?: string;
}

/** Raw SnapTrade activity row (only the fields we read). */
interface RawActivity {
  id?: string;
  type?: string;
  units?: number | null;
  price?: number | null;
  amount?: number | null;
  fee?: number | null;
  trade_date?: string | null;
  settlement_date?: string | null;
  description?: string;
  currency?: { code?: string | null } | null;
  symbol?: { symbol?: string; raw_symbol?: string; type?: { code?: string | null } | null } | null;
  option_symbol?: unknown;
}

/** ET calendar date (yyyy-mm-dd) for an ISO timestamp; null when unparseable. */
function etDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return tradeDateEtFromUnix(ms / 1000);
}

/** Deterministic fallback key when the vendor omits `id`. */
function fallbackExternalId(a: RawActivity): string {
  return [
    a.trade_date ?? "",
    a.type ?? "",
    a.symbol?.symbol ?? a.symbol?.raw_symbol ?? "",
    a.units ?? "",
    a.amount ?? "",
    (a.description ?? "").slice(0, 40),
  ].join("|");
}

interface NormalizedActivity {
  externalId: string;
  activityType: ActivityTypeCode;
  rawType: string;
  ticker: string | null;
  instrumentKind: string | null;
  units: number | null;
  price: number | null;
  amount: number | null;
  fee: number | null;
  currency: string | null;
  tradeDate: string; // yyyy-mm-dd (ET)
  settlementDate: string | null;
  description: string | null;
  isOption: boolean;
  rawJson: RawActivity;
}

function normalize(a: RawActivity): NormalizedActivity | null {
  const tradeDate = etDate(a.trade_date);
  if (!tradeDate) return null; // a row with no date can't be placed on the timeline
  const rawType = (a.type ?? "").trim();
  const isOption = a.option_symbol != null;
  const ticker = a.symbol?.symbol?.toUpperCase() ?? a.symbol?.raw_symbol?.toUpperCase() ?? null;
  return {
    externalId: a.id ?? fallbackExternalId(a),
    activityType: normalizeActivityType(rawType),
    rawType,
    ticker,
    instrumentKind: a.symbol?.type?.code ?? (isOption ? "option" : null),
    units: a.units ?? null,
    price: a.price ?? null,
    amount: a.amount ?? null,
    fee: a.fee ?? null,
    currency: a.currency?.code ?? null,
    tradeDate,
    settlementDate: etDate(a.settlement_date),
    description: a.description ?? null,
    isOption,
    rawJson: a,
  };
}

/** Page-walk the full (or tail) activity history for one SnapTrade account. */
async function fetchAllActivities(
  accountId: string,
  startDate: string | undefined,
): Promise<RawActivity[]> {
  const client = getSnapTradeClient();
  const all: RawActivity[] = [];
  let offset = 0;
  let total = Infinity;
  let pages = 0;
  while (offset < total) {
    const resp = await client.accountInformation.getAccountActivities({
      accountId,
      offset,
      limit: PAGE_LIMIT,
      ...(startDate ? { startDate } : {}),
    });
    const page = (resp.data?.data ?? []) as RawActivity[];
    const pag = resp.data?.pagination as { total?: number } | undefined;
    total = pag?.total ?? page.length;
    all.push(...page);
    pages++;
    if (page.length === 0) break;
    offset += page.length;
    if (pages > 200) break; // hard safety cap
  }
  return all;
}

/**
 * Sync activities for one managed account. Idempotent and safe to call from the
 * mirror or standalone. Never throws for expected failures.
 */
export async function syncAccountActivities(accountLinkId: string): Promise<ActivitySyncResult> {
  const link = await prisma.brokerageAccountLink.findUnique({
    where: { id: accountLinkId },
    select: { id: true, snaptradeAccountId: true, lastActivitySyncAt: true },
  });
  if (!link) {
    return {
      ok: false,
      fetched: 0,
      written: 0,
      earliestDate: null,
      unknownTypes: [],
      unvaluedInstruments: [],
      error: "Account link not found.",
    };
  }

  const outcome = await withIngestLock(`brokerage-activities:${accountLinkId}`, async () => {
    try {
      // Incremental tail on repeat runs; full history on first sweep.
      const startDate =
        link.lastActivitySyncAt != null
          ? new Date(link.lastActivitySyncAt.getTime() - TAIL_LOOKBACK_DAYS * 86_400_000)
              .toISOString()
              .slice(0, 10)
          : undefined;

      const raw = await fetchAllActivities(link.snaptradeAccountId, startDate);
      const normalized = raw.map(normalize).filter((n): n is NormalizedActivity => n != null);

      // Write-once: filter out keys already stored for this account.
      const existing = await prisma.brokerageActivity.findMany({
        where: { accountLinkId },
        select: { externalId: true },
      });
      const have = new Set(existing.map((e) => e.externalId));
      const toWrite = normalized.filter((n) => !have.has(n.externalId));

      if (toWrite.length > 0) {
        await prisma.brokerageActivity.createMany({
          data: toWrite.map((n) => ({
            accountLinkId,
            externalId: n.externalId,
            activityType: n.activityType,
            rawType: n.rawType,
            ticker: n.ticker,
            instrumentKind: n.instrumentKind,
            units: n.units != null ? new Prisma.Decimal(n.units) : null,
            price: n.price != null ? new Prisma.Decimal(n.price) : null,
            amount: n.amount != null ? new Prisma.Decimal(n.amount) : null,
            fee: n.fee != null ? new Prisma.Decimal(n.fee) : null,
            currency: n.currency,
            tradeDate: new Date(`${n.tradeDate}T00:00:00Z`),
            settlementDate: n.settlementDate ? new Date(`${n.settlementDate}T00:00:00Z`) : null,
            description: n.description,
            isOption: n.isOption,
            rawJson: n.rawJson as unknown as Prisma.InputJsonValue,
          })),
          skipDuplicates: true,
        });
      }

      // Onboard every ticker that ever appears (including fully-sold names).
      const ledgerTickers = [...new Set(normalized.map((n) => n.ticker).filter((t): t is string => !!t))];
      await ensureSecuritiesAndOnboard(ledgerTickers);

      // Roll up ledger stats + data-quality issues from the FULL stored set.
      const stored = await prisma.brokerageActivity.findMany({
        where: { accountLinkId },
        select: { tradeDate: true, activityType: true, rawType: true, isOption: true, ticker: true },
      });
      const activityCount = stored.length;
      const earliest = stored.reduce<Date | null>(
        (min, r) => (min == null || r.tradeDate < min ? r.tradeDate : min),
        null,
      );
      const unknownTypes = [
        ...new Set(stored.filter((r) => r.activityType === "OTHER").map((r) => r.rawType)),
      ];
      const unvaluedInstruments = [
        ...new Set(
          stored
            .filter((r) => r.isOption)
            .map((r) => r.ticker ?? r.rawType),
        ),
      ];

      await prisma.brokerageAccountLink.update({
        where: { id: accountLinkId },
        data: {
          activityCount,
          earliestActivityDate: earliest,
          lastActivitySyncAt: new Date(),
          activityIssuesJson: { unknownTypes, unvaluedInstruments } as unknown as Prisma.InputJsonValue,
        },
      });

      await writeAuditLog("brokerage.activities_sync", {
        accountLinkId,
        fetched: normalized.length,
        written: toWrite.length,
        activityCount,
        unknownTypes: unknownTypes.length,
      });

      return {
        ok: true,
        fetched: normalized.length,
        written: toWrite.length,
        earliestDate: earliest ? earliest.toISOString().slice(0, 10) : null,
        unknownTypes,
        unvaluedInstruments,
      } satisfies ActivitySyncResult;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      await writeAuditLog("brokerage.activities_sync_error", { accountLinkId, error: error.slice(0, 500) });
      return {
        ok: false,
        fetched: 0,
        written: 0,
        earliestDate: null,
        unknownTypes: [],
        unvaluedInstruments: [],
        error,
      } satisfies ActivitySyncResult;
    }
  });

  if (!outcome.ran) {
    return {
      ok: false,
      deduped: true,
      fetched: 0,
      written: 0,
      earliestDate: null,
      unknownTypes: [],
      unvaluedInstruments: [],
    };
  }
  return outcome.result;
}
