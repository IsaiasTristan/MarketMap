/**
 * Pairs tab — pooled Validation event study (brief §10).
 *
 * Reads every stored EQUAL-weighted PairSnapshot (all tiers, all weeks), builds
 * each pair's forward relative-return path, splits UNPRICED-fired events from
 * their own control weeks, and hands the whole population to the pure
 * poolEventStudy. Caches the result in PairValidationSnapshot (kind
 * "pooled-event-study"); getPairValidation reads it and recomputes on a cold
 * miss, mirroring the funnel-validation service.
 *
 * FORWARD RETURNS: each week's snapshot stores its trailing price-ratio series.
 * The single within-snapshot step ln(ratio_t / ratio_{t-1}) is on one
 * consistent basis, so per-week relative log returns are summed across the
 * pair's own ordered weeks to get forward returns — no cross-snapshot rebasing
 * assumption. Any missing step drops that forward horizon (drop-and-count).
 *
 * We validate EQUAL weighting only: EQUAL and CAP are the same economic pair,
 * so pooling both would double-count events and inflate the distinct-pair gate.
 */
import { prisma } from "@/infrastructure/db/client";
import type { Prisma } from "@prisma/client";
import { PAIR_THRESHOLDS, VALIDATION_HELD_OUT_FROM, VALIDATION_FORWARD_RESERVE_FROM } from "@/lib/pairs/config";
import { isThinGap } from "@/lib/pairs/flags";
import {
  poolEventStudy,
  VALIDATION_HORIZONS,
  type PairWeekObservation,
  type ValidationResult,
} from "@/lib/pairs/validation";

const KIND = "pooled-event-study";

/** Stored flags that are pooled event kinds. UNPRICED is the sole gated
 *  headline; the rest are secondary and gated individually in poolEventStudy. */
const EVENT_KINDS = ["UNPRICED", "CONTRARY", "E2_UNPRICED", "TRIANGULATED"] as const;

function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Smaller leg's name count, or null when neither is known / positive. */
function minLegNames(nLong: number | null, nShort: number | null): number | null {
  const vals = [nLong, nShort].filter((v): v is number => v !== null && Number.isFinite(v) && v > 0);
  return vals.length ? Math.min(...vals) : null;
}

/** ln(last / secondLast) of a trailing ratio series — one within-snapshot step. */
function ratioStep(series: number[]): number | null {
  if (series.length < 2) return null;
  const a = series[series.length - 2]!;
  const b = series[series.length - 1]!;
  if (!(a > 0) || !(b > 0) || !Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.log(b / a);
}

interface SnapshotRow {
  tier: string;
  longKey: string;
  shortKey: string;
  snapshotDate: Date;
  flags: string[];
  unpricedGap: number | null;
  unpricedGapDriver: string | null;
  hedgeEff: number | null;
  residualSharePct: number | null;
  crossSector: boolean;
  crowdingLong: number | null;
  crowdBreadthLong: number | null;
  valRatioPctile: number | null;
  priceRatioSeries: number[];
  killScreensApplied: boolean;
  e1Gap: number | null;
  e1Gap4wChange: number | null;
  relReturn1m: number | null;
  longNameCount: number | null;
  shortNameCount: number | null;
}

export interface PairValidationBuildResult extends ValidationResult {}

export async function computePairValidation(): Promise<ValidationResult> {
  const rows = (await prisma.pairSnapshot.findMany({
    where: { weighting: "EQUAL" },
    orderBy: [{ longKey: "asc" }, { shortKey: "asc" }, { snapshotDate: "asc" }],
    select: {
      tier: true,
      longKey: true,
      shortKey: true,
      snapshotDate: true,
      flags: true,
      unpricedGap: true,
      unpricedGapDriver: true,
      hedgeEff: true,
      residualSharePct: true,
      crossSector: true,
      crowdingLong: true,
      crowdBreadthLong: true,
      valRatioPctile: true,
      priceRatioSeries: true,
      killScreensApplied: true,
      e1Gap: true,
      e1Gap4wChange: true,
      relReturn1m: true,
      longNameCount: true,
      shortNameCount: true,
    },
  })) as unknown as SnapshotRow[];

  // Group by pair identity, preserving the week order from the query.
  const byPair = new Map<string, SnapshotRow[]>();
  for (const r of rows) {
    const key = `${r.tier}|${r.longKey}|${r.shortKey}`;
    (byPair.get(key) ?? byPair.set(key, []).get(key)!).push(r);
  }

  const observations: PairWeekObservation[] = [];
  for (const [pairKey, series] of byPair) {
    // Per-week within-snapshot relative log-return step.
    const steps = series.map((s) => ratioStep(s.priceRatioSeries));
    for (let i = 0; i < series.length; i++) {
      const s = series[i]!;
      const forward: Partial<Record<number, number | null>> = {};
      for (const h of VALIDATION_HORIZONS) {
        // Sum steps i+1 .. i+h; require all present and contiguous.
        if (i + h >= series.length) {
          forward[h] = null;
          continue;
        }
        let sum = 0;
        let ok = true;
        for (let k = i + 1; k <= i + h; k++) {
          const st = steps[k];
          if (st === null || st === undefined) {
            ok = false;
            break;
          }
          sum += st;
        }
        forward[h] = ok ? sum : null;
      }
      observations.push({
        pairKey,
        tier: s.tier,
        weekIso: isoOf(s.snapshotDate),
        fired: s.flags.includes("UNPRICED"),
        firedKinds: EVENT_KINDS.filter((k) => s.flags.includes(k)),
        killScreensApplied: s.killScreensApplied,
        signal: s.unpricedGap,
        forward,
        hedgeEff: s.hedgeEff,
        residualSharePct: s.residualSharePct,
        crossSector: s.crossSector,
        crowdingLong: s.crowdingLong,
        crowdBreadthLong: s.crowdBreadthLong,
        valRatioPctile: s.valRatioPctile,
        driver: s.unpricedGapDriver,
        minLegNames: minLegNames(s.longNameCount, s.shortNameCount),
        thinGap: isThinGap(s.e1Gap, s.longNameCount, s.shortNameCount),
        signFlipFired:
          s.e1Gap4wChange !== null &&
          Number.isFinite(s.e1Gap4wChange) &&
          s.e1Gap4wChange < -PAIR_THRESHOLDS.unpricedGapPp &&
          s.relReturn1m !== null &&
          Number.isFinite(s.relReturn1m) &&
          Math.abs(s.relReturn1m) <= PAIR_THRESHOLDS.unpricedRelBand,
      });
    }
  }

  return poolEventStudy(observations, {
    heldOutFrom: VALIDATION_HELD_OUT_FROM,
    forwardReserveFrom: VALIDATION_FORWARD_RESERVE_FROM,
  });
}

export async function computeAndCachePairValidation(
  opts: { log?: (m: string) => void } = {},
): Promise<{ events: number; effectiveWeeks: number | null; headlineReady: boolean }> {
  const log = opts.log ?? (() => {});
  const payload = await computePairValidation();
  await prisma.pairValidationSnapshot.upsert({
    where: { kind: KIND },
    create: {
      kind: KIND,
      heldOutFrom: new Date(`${VALIDATION_HELD_OUT_FROM}T00:00:00Z`),
      payload: payload as unknown as Prisma.InputJsonValue,
    },
    update: {
      heldOutFrom: new Date(`${VALIDATION_HELD_OUT_FROM}T00:00:00Z`),
      payload: payload as unknown as Prisma.InputJsonValue,
      computedAt: new Date(),
    },
  });
  log(
    `[pairs-validation] cached ${KIND}: ${payload.totals.events} events, effWeeks=${payload.headline.effectiveWeeks}, ready=${payload.headline.ready}`,
  );
  return { events: payload.totals.events, effectiveWeeks: payload.headline.effectiveWeeks, headlineReady: payload.headline.ready };
}

/** Cached payload; computes + caches on a cold miss. */
export async function getPairValidation(): Promise<ValidationResult | null> {
  const cached = await prisma.pairValidationSnapshot.findUnique({ where: { kind: KIND } });
  if (cached) return cached.payload as unknown as ValidationResult;
  const latest = await prisma.pairSnapshot.findFirst({ select: { snapshotDate: true } });
  if (!latest) return null;
  await computeAndCachePairValidation();
  const fresh = await prisma.pairValidationSnapshot.findUnique({ where: { kind: KIND } });
  return fresh ? (fresh.payload as unknown as ValidationResult) : null;
}
