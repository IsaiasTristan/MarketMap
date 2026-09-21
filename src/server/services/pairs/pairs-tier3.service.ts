/**
 * Pairs tab — Tier 3 curated-link read-through (brief §4.4, §6.3).
 *
 * For every active PairCuratedLink, walks the weekly grid in order and applies
 * the pure evaluateReadThrough rule, carrying each link's lead-streak state
 * forward, and rewrites its PairLinkReadThrough history. Full recompute per
 * link (delete + recreate) so it is idempotent.
 *
 * FIRING SIGNAL: Engine 1's per-name z (RevisionScreenRow.ptRevOrthZ) is the
 * continuous, universe-calibrated signal the firedZ / quietZ thresholds are
 * tuned for, so read-throughs currently fire on E1 (firedEngine = "E1").
 * Engine 2's reconstruction is quarterly and its magnitude is a vote fraction
 * in [-1, 1], not a z, so it is not used to fire until it has its own per-week
 * z; the SUPPLIER_CUSTOMER / INPUT_COST directionality lives in the pure lib.
 *
 * Ships with zero links by design (§15.3): with no active links this writes
 * nothing and returns { links: 0, readThroughs: 0 }.
 */
import { prisma } from "@/infrastructure/db/client";
import { evaluateReadThrough, type FiredSide, type PairLinkRelation, type PairLinkStatus } from "@/lib/pairs/tier3";

export interface Tier3BuildResult {
  links: number;
  readThroughs: number;
  confirmed: number;
  watching: number;
}

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export async function computeAndWriteTier3ReadThroughs(opts: { log?: (m: string) => void } = {}): Promise<Tier3BuildResult> {
  const log = opts.log ?? (() => {});

  const links = await prisma.pairCuratedLink.findMany({ where: { active: true } });
  if (links.length === 0) {
    log("[pairs-t3] no active curated links — nothing to build");
    return { links: 0, readThroughs: 0, confirmed: 0, watching: 0 };
  }

  // Weekly grid + per-ticker Engine-1 z for exactly the linked tickers.
  const tickers = [...new Set(links.flatMap((l) => [l.tickerA, l.tickerB]))];
  const rows = await prisma.revisionScreenRow.findMany({
    where: { ticker: { in: tickers } },
    orderBy: [{ snapshotDate: "asc" }],
    select: { ticker: true, snapshotDate: true, ptRevOrthZ: true },
  });
  const grid = [...new Set(rows.map((r) => isoOf(r.snapshotDate)))].sort();
  const zByTickerWeek = new Map<string, Map<string, number | null>>();
  for (const r of rows) {
    const wk = zByTickerWeek.get(r.ticker) ?? zByTickerWeek.set(r.ticker, new Map()).get(r.ticker)!;
    wk.set(isoOf(r.snapshotDate), r.ptRevOrthZ);
  }

  let readThroughs = 0;
  let confirmed = 0;
  let watching = 0;

  for (const link of links) {
    await prisma.pairLinkReadThrough.deleteMany({ where: { linkId: link.id } });

    let priorStatus: PairLinkStatus = "NEW";
    let priorFiredSide: FiredSide | null = null;
    let priorWeeksElapsed = 0;
    const batch: Array<Record<string, unknown>> = [];

    for (const week of grid) {
      const scoreA = zByTickerWeek.get(link.tickerA)?.get(week) ?? null;
      const scoreB = zByTickerWeek.get(link.tickerB)?.get(week) ?? null;
      // A week with no signal on either side is not part of the read-through path.
      if (scoreA === null && scoreB === null) {
        priorStatus = "NEW";
        priorFiredSide = null;
        priorWeeksElapsed = 0;
        continue;
      }
      const res = evaluateReadThrough({
        relation: link.relationType as PairLinkRelation,
        scoreA,
        scoreB,
        priorStatus,
        priorFiredSide,
        priorWeeksElapsed,
      });
      priorStatus = res.status;
      priorFiredSide = res.firedSide;
      priorWeeksElapsed = res.weeksElapsed;

      // Only persist weeks that carry a live read-through (WATCH/CONFIRMED) — a
      // NEW week is the absence of a signal, not a row worth storing.
      if (res.status === "NEW") continue;
      if (res.status === "CONFIRMED") confirmed++;
      if (res.status === "WATCH") watching++;
      batch.push({
        linkId: link.id,
        snapshotDate: new Date(`${week}T00:00:00Z`),
        firedSide: res.firedSide,
        firedEngine: "E1",
        firedScore: res.firedScore,
        otherScore: res.otherScore,
        weeksElapsed: res.weeksElapsed,
        status: res.status,
      });
    }
    if (batch.length > 0) {
      await prisma.pairLinkReadThrough.createMany({ data: batch as never });
      readThroughs += batch.length;
    }
  }

  log(`[pairs-t3] ${links.length} links -> ${readThroughs} read-through weeks (${confirmed} confirmed, ${watching} watching)`);
  return { links: links.length, readThroughs, confirmed, watching };
}
