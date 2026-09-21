/**
 * Pairs Validation — the falsification controls (brief §10, review §C). No I/O.
 *
 * These are the cheap tests that make the headline interpretable. They run
 * through the SAME two-way-demeaned groupStat the headline uses, so a control
 * is a like-for-like re-run of the identical plumbing:
 *
 *   - known-answer (C1): feed a signal built from the forward return itself. It
 *     MUST produce a large t. If it doesn't, the measurement is broken and
 *     nothing else on the page is interpretable.
 *   - placebo (C2): keep the same pairs and the same per-pair event count, but
 *     randomise WHICH weeks fire. A real signal should collapse to ~0.
 *   - sign-flip (C3): run on inverted events (gap NARROWING while price flat). A
 *     real signal should give a roughly symmetric negative; a positive here is
 *     universe drift, not the signal.
 *   - concentration (C4): the headline recomputed with the top-10 contributing
 *     pairs removed, plus how much one pair dominates.
 */
import { mulberry32 } from "@/lib/revision/funnel-metrics";
import { groupStat, PRIMARY_HORIZON, type PairWeekObservation } from "@/lib/pairs/validation";

export interface ControlRow {
  key: string; // "known-answer" | "placebo" | "sign-flip"
  label: string;
  excess: number | null;
  tStat: number | null;
  events: number;
  expectation: string;
  note: string;
}

export interface ConcentrationResult {
  distinctPairs: number;
  maxEventsOnePair: number;
  topPairKey: string | null;
  meanEventsPerPair: number | null;
  top10SharePct: number | null;
  excess: number | null; // headline excess for reference
  excessExTop10: number | null;
  tStatExTop10: number | null;
}

export interface ControlsResult {
  horizon: number;
  rows: ControlRow[];
  concentration: ConcentrationResult;
}

function shuffleInPlace<T>(arr: T[], rng: () => number): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
}

export function buildValidationControls(
  observations: PairWeekObservation[],
  opts: { seed?: number; horizon?: number } = {},
): ControlsResult {
  const H = opts.horizon ?? PRIMARY_HORIZON;
  const seed = opts.seed ?? 0x9e3779b9;
  const events = observations.filter((o) => o.fired);
  const rows: ControlRow[] = [];

  // C1 — known-answer. Events = top-decile forward return; control = the rest.
  {
    const withF = observations.filter((o) => typeof o.forward[H] === "number" && Number.isFinite(o.forward[H]));
    const sorted = [...withF].sort((a, b) => (b.forward[H] as number) - (a.forward[H] as number));
    const k = Math.max(1, Math.floor(sorted.length * 0.1));
    const topEvents = sorted.slice(0, k);
    const restControl = sorted.slice(k);
    const s = groupStat(topEvents, restControl, H);
    rows.push({
      key: "known-answer",
      label: "Known-answer (top-decile forward return)",
      excess: s.excess,
      tStat: s.tStat,
      events: s.events,
      expectation: "must show a large positive t",
      note: "if this is not large, the measurement plumbing is broken",
    });
  }

  // C2 — placebo. Same pairs, same per-pair fired count, randomised weeks.
  {
    const rng = mulberry32(seed);
    const byPair = new Map<string, PairWeekObservation[]>();
    for (const o of observations) (byPair.get(o.pairKey) ?? byPair.set(o.pairKey, []).get(o.pairKey)!).push(o);
    const placeboEvents: PairWeekObservation[] = [];
    const placeboControl: PairWeekObservation[] = [];
    for (const obs of byPair.values()) {
      const firedCount = obs.filter((o) => o.fired).length;
      const idx = obs.map((_, i) => i);
      shuffleInPlace(idx, rng);
      const chosen = new Set(idx.slice(0, firedCount));
      obs.forEach((o, i) => (chosen.has(i) ? placeboEvents : placeboControl).push(o));
    }
    const s = groupStat(placeboEvents, placeboControl, H);
    rows.push({
      key: "placebo",
      label: "Placebo (shuffled firing weeks)",
      excess: s.excess,
      tStat: s.tStat,
      events: s.events,
      expectation: "should collapse to ~0",
      note: "a placebo of similar magnitude means a leak, not a signal",
    });
  }

  // C3 — sign-flip. Inverted events: gap narrowing while price flat.
  {
    const sfEvents = observations.filter((o) => o.signFlipFired);
    const sfControl = observations.filter((o) => !o.signFlipFired);
    const s = groupStat(sfEvents, sfControl, H);
    rows.push({
      key: "sign-flip",
      label: "Sign-flip (gap narrowing, price flat)",
      excess: s.excess,
      tStat: s.tStat,
      events: s.events,
      expectation: "should be roughly symmetric negative",
      note: "a positive here is universe drift / survivorship, not the signal",
    });
  }

  // C4 — per-pair concentration.
  const perPair = new Map<string, number>();
  for (const e of events) perPair.set(e.pairKey, (perPair.get(e.pairKey) ?? 0) + 1);
  const rankedPairs = [...perPair.entries()].sort((a, b) => b[1] - a[1]);
  const distinctPairs = rankedPairs.length;
  const maxEventsOnePair = rankedPairs[0]?.[1] ?? 0;
  const topPairKey = rankedPairs[0]?.[0] ?? null;
  const top10 = new Set(rankedPairs.slice(0, 10).map((r) => r[0]));
  const top10Events = rankedPairs.slice(0, 10).reduce((a, r) => a + r[1], 0);
  const control = observations.filter((o) => !o.fired);
  const exTop10Events = events.filter((e) => !top10.has(e.pairKey));
  const headline = groupStat(events, control, H);
  const exStat = groupStat(exTop10Events, control, H);
  const concentration: ConcentrationResult = {
    distinctPairs,
    maxEventsOnePair,
    topPairKey,
    meanEventsPerPair: distinctPairs ? events.length / distinctPairs : null,
    top10SharePct: events.length ? (top10Events / events.length) * 100 : null,
    excess: headline.excess,
    excessExTop10: exStat.excess,
    tStatExTop10: exStat.tStat,
  };

  return { horizon: H, rows, concentration };
}
