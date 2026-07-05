/**
 * Engine 1 — SignalTransition writer + the daily earnings-window scan.
 *
 * Weekly transition types are REWRITTEN per snapshotDate (delete + createMany,
 * InstitutionalEvent pattern) so a re-score refreshes them cleanly.
 * ER_WITHIN_7D rows are keyed to the EARNINGS date itself — the daily scan can
 * run every day but each earnings event fires exactly once (unique on
 * [type, subjectKey, snapshotDate]).
 */
import type { Prisma, RevisionTransitionType } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { detectEarningsTransitions, type TransitionDraft } from "@/lib/revision/transitions";

/** Types recomputed by the weekly scoring pass (everything except the daily ER scan). */
export const WEEKLY_TRANSITION_TYPES: RevisionTransitionType[] = [
  "NEW_LONG",
  "NEW_SHORT",
  "GAP_CLOSED",
  "STREAK_BROKEN",
  "GROUP_INFLECTION",
  "GROUP_ROLLOVER",
  "NEXT_DOMINO",
];

function subjectKeyOf(d: TransitionDraft): string {
  if (d.ticker) return d.ticker;
  return `${d.groupType ?? "GROUP"}:${d.groupKey ?? "?"}`;
}

/** Rewrite the weekly transition set for a snapshot date. Returns rows written. */
export async function writeWeeklyTransitions(
  snapshotDate: Date,
  drafts: TransitionDraft[],
): Promise<number> {
  await prisma.signalTransition.deleteMany({
    where: { snapshotDate, type: { in: WEEKLY_TRANSITION_TYPES } },
  });
  if (drafts.length === 0) return 0;
  const res = await prisma.signalTransition.createMany({
    data: drafts.map((d) => ({
      type: d.type,
      subjectKey: subjectKeyOf(d),
      ticker: d.ticker ?? null,
      groupType: d.groupType ?? null,
      groupKey: d.groupKey ?? null,
      snapshotDate,
      payload: d.payload as Prisma.InputJsonValue,
    })),
    skipDuplicates: true,
  });
  return res.count;
}

export interface DailyTransitionScanSummary {
  scanned: number;
  fired: number;
}

/**
 * Daily ER scan: names reporting within the window with a live composite
 * signal. Reads the latest snapshot's nextEarningsDate + the latest score;
 * keyed to the earnings date so repeats are deduped by the unique constraint.
 */
export async function runDailyTransitionScan(
  opts: { today?: string; log?: (msg: string) => void } = {},
): Promise<DailyTransitionScanSummary> {
  const log = opts.log ?? (() => {});
  const todayIso = opts.today ?? new Date().toISOString().slice(0, 10);
  const todayMs = new Date(`${todayIso}T00:00:00Z`).getTime();

  const latestScoreDate = (
    await prisma.revisionScore.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  if (!latestScoreDate) {
    log("[transitions] no scores present; skipping ER scan");
    return { scanned: 0, fired: 0 };
  }
  const scores = await prisma.revisionScore.findMany({
    where: { snapshotDate: latestScoreDate },
    select: { ticker: true, composite: true },
  });
  const latestSnapDate = (
    await prisma.revisionSnapshot.findFirst({ orderBy: { snapshotDate: "desc" }, select: { snapshotDate: true } })
  )?.snapshotDate;
  const snaps = latestSnapDate
    ? await prisma.revisionSnapshot.findMany({
        where: { snapshotDate: latestSnapDate, nextEarningsDate: { not: null } },
        select: { ticker: true, nextEarningsDate: true },
      })
    : [];
  const erByTicker = new Map(snaps.map((s) => [s.ticker, s.nextEarningsDate!]));

  const rows = scores.map((s) => {
    const er = erByTicker.get(s.ticker);
    const days = er ? Math.round((er.getTime() - todayMs) / 86_400_000) : null;
    return { ticker: s.ticker, compositeZ: s.composite, daysToEarnings: days !== null && days >= 0 ? days : null };
  });
  const drafts = detectEarningsTransitions(rows);

  let fired = 0;
  for (const d of drafts) {
    const erDate = erByTicker.get(d.ticker!)!;
    try {
      await prisma.signalTransition.create({
        data: {
          type: "ER_WITHIN_7D",
          subjectKey: d.ticker!,
          ticker: d.ticker!,
          snapshotDate: erDate, // keyed to the earnings event, not the scan day
          payload: d.payload as Prisma.InputJsonValue,
        },
      });
      fired++;
    } catch {
      // Unique violation = already fired for this earnings event. Expected.
    }
  }
  log(`[transitions] ER scan: ${rows.length} names, ${drafts.length} in window, ${fired} newly fired`);
  return { scanned: rows.length, fired };
}
