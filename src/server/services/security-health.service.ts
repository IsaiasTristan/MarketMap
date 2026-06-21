import type { PrismaClient } from "@prisma/client";
import { fetchYahooSuccessor } from "@/infrastructure/providers/yahoo-quote-http";
import { curatedSuccessor } from "@/infrastructure/providers/rename-map";

export interface DelistCandidateRow {
  id: string;
  ticker: string;
  name: string;
  lastBarDate: string | null;
  firstMissedAt: string | null;
  lastMissedAt: string | null;
  consecutiveMisses: number;
  suggestedReplacement: string | null;
}

export interface DelistedRow {
  id: string;
  ticker: string;
  name: string;
  lastBarDate: string | null;
  delistedAt: string | null;
  suggestedReplacement: string | null;
}

function isoOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

function dateOnlyOrNull(d: Date | null | undefined): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

export async function listDelistCandidates(
  db: PrismaClient
): Promise<DelistCandidateRow[]> {
  const secs = await db.security.findMany({
    where: { delistCandidate: true, isActive: true },
    orderBy: [{ lastMissedAt: "desc" }, { ticker: "asc" }],
    include: {
      priceHistory: {
        select: { tradeDate: true },
        orderBy: { tradeDate: "desc" },
        take: 1,
      },
    },
  });
  return secs.map((s) => ({
    id: s.id,
    ticker: s.ticker,
    name: s.name,
    lastBarDate: dateOnlyOrNull(s.priceHistory[0]?.tradeDate),
    firstMissedAt: isoOrNull(s.firstMissedAt),
    lastMissedAt: isoOrNull(s.lastMissedAt),
    consecutiveMisses: s.consecutiveMisses,
    suggestedReplacement: s.suggestedReplacement ?? null,
  }));
}

export async function listDelistedSecurities(
  db: PrismaClient
): Promise<DelistedRow[]> {
  const secs = await db.security.findMany({
    where: { isActive: false },
    orderBy: [{ delistedAt: "desc" }, { ticker: "asc" }],
    include: {
      priceHistory: {
        select: { tradeDate: true },
        orderBy: { tradeDate: "desc" },
        take: 1,
      },
    },
  });
  return secs.map((s) => ({
    id: s.id,
    ticker: s.ticker,
    name: s.name,
    lastBarDate: dateOnlyOrNull(s.priceHistory[0]?.tradeDate),
    delistedAt: isoOrNull(s.delistedAt),
    suggestedReplacement: s.suggestedReplacement ?? null,
  }));
}

/** User clicks "Confirm delist" — flip isActive=false. */
export async function confirmDelist(
  db: PrismaClient,
  securityId: string
): Promise<void> {
  await db.security.update({
    where: { id: securityId },
    data: {
      isActive: false,
      delistedAt: new Date(),
      delistCandidate: false,
    },
  });
  await db.auditLog.create({
    data: {
      action: "security.delist.confirm",
      payloadJson: { securityId },
    },
  });
}

/** User clicks "Mark live" — clear the candidate flag and reset counters,
 *  effectively saying "this is fine, stop bugging me about it." */
export async function markLive(
  db: PrismaClient,
  securityId: string
): Promise<void> {
  await db.security.update({
    where: { id: securityId },
    data: {
      delistCandidate: false,
      firstMissedAt: null,
      lastMissedAt: null,
      consecutiveMisses: 0,
    },
  });
  await db.auditLog.create({
    data: {
      action: "security.delist.mark_live",
      payloadJson: { securityId },
    },
  });
}

/** User clicks "Reactivate" — undo a previous delist. */
export async function reactivateSecurity(
  db: PrismaClient,
  securityId: string
): Promise<void> {
  await db.security.update({
    where: { id: securityId },
    data: {
      isActive: true,
      delistedAt: null,
      delistCandidate: false,
      firstMissedAt: null,
      lastMissedAt: null,
      consecutiveMisses: 0,
    },
  });
  await db.auditLog.create({
    data: {
      action: "security.delist.reactivate",
      payloadJson: { securityId },
    },
  });
}

/**
 * Auto-deactivate active tickers in `universeId` whose last bar is more than
 * `staleDays` calendar days behind the universe's freshest bar.
 *
 * Why this exists: a single dead ticker (delisted, acquired, merged) used to
 * pin the entire grid's `asOf = MIN(lastDate)` banner to weeks behind today,
 * even when 1200+ other tickers were current. Three real cases we've seen:
 *   - BITF: explicit Yahoo delist signal (HTTP 404 / "delisted" error).
 *   - CTRA: merged into Devon Energy; Yahoo still answers OK but stops
 *           emitting new bars, so the existing miss-counter never trips.
 *   - TPH:  acquired and taken private; same shape as CTRA.
 *
 * Keying the threshold off the universe's *freshest bar* (not wall-clock)
 * means weekends, holidays, and timezone drift can never trigger this. A
 * default 21-day threshold is far above any transient Yahoo throttle, so a
 * temporary rate-limit can't cause a removal. Fully reversible via the
 * existing Data tab Reactivate action; every change is written to auditLog.
 */
export async function autoDeactivateStaleTickers(
  db: PrismaClient,
  universeId: string,
  options: { staleDays?: number } = {}
): Promise<{ deactivated: string[] }> {
  const staleDays = options.staleDays ?? 21;
  const constituents = await db.universeConstituent.findMany({
    where: { universeId, security: { isActive: true } },
    include: {
      security: {
        select: {
          id: true,
          ticker: true,
          priceHistory: {
            select: { tradeDate: true },
            orderBy: { tradeDate: "desc" },
            take: 1,
          },
        },
      },
    },
  });
  if (constituents.length === 0) return { deactivated: [] };

  let newestMs = -Infinity;
  for (const c of constituents) {
    const t = c.security.priceHistory[0]?.tradeDate?.getTime();
    if (t != null && t > newestMs) newestMs = t;
  }
  if (!Number.isFinite(newestMs)) return { deactivated: [] };

  const thresholdMs = newestMs - staleDays * 86_400_000;
  const targets = constituents.filter((c) => {
    const last = c.security.priceHistory[0]?.tradeDate;
    if (!last) return true;
    return last.getTime() < thresholdMs;
  });
  if (targets.length === 0) return { deactivated: [] };

  const deactivated: string[] = [];
  for (const c of targets) {
    const sec = c.security;
    const lastBar = sec.priceHistory[0]?.tradeDate ?? null;
    const lagDays = lastBar
      ? Math.floor((newestMs - lastBar.getTime()) / 86_400_000)
      : null;
    let suggestion: string | null = curatedSuccessor(sec.ticker);
    if (!suggestion) {
      try {
        const dyn = await fetchYahooSuccessor(sec.ticker);
        suggestion = dyn?.symbol ?? null;
      } catch {
        suggestion = null;
      }
    }
    await db.security.update({
      where: { id: sec.id },
      data: {
        isActive: false,
        delistedAt: new Date(),
        delistCandidate: false,
        ...(suggestion ? { suggestedReplacement: suggestion } : {}),
      },
    });
    await db.auditLog.create({
      data: {
        action: "security.delist.auto",
        payloadJson: {
          securityId: sec.id,
          ticker: sec.ticker,
          universeId,
          lastBarDate: lastBar ? lastBar.toISOString().slice(0, 10) : null,
          lagDays,
          staleThresholdDays: staleDays,
          suggestedReplacement: suggestion,
        },
      },
    });
    deactivated.push(sec.ticker);
  }
  return { deactivated };
}

/**
 * Populate `suggestedReplacement` for every candidate that doesn't have one
 * yet. Tries the curated map first, then falls back to a live Yahoo lookup.
 * Best-effort and non-blocking; failures just leave the field null.
 */
export async function refreshSuccessorSuggestions(
  db: PrismaClient
): Promise<{ filled: number }> {
  const candidates = await db.security.findMany({
    where: {
      OR: [{ delistCandidate: true }, { isActive: false }],
      suggestedReplacement: null,
    },
    select: { id: true, ticker: true },
  });
  let filled = 0;
  for (const c of candidates) {
    const curated = curatedSuccessor(c.ticker);
    let suggestion: string | null = curated;
    if (!suggestion) {
      try {
        const dyn = await fetchYahooSuccessor(c.ticker);
        suggestion = dyn?.symbol ?? null;
      } catch {
        suggestion = null;
      }
    }
    if (suggestion) {
      await db.security.update({
        where: { id: c.id },
        data: { suggestedReplacement: suggestion },
      });
      filled += 1;
    }
  }
  return { filled };
}
