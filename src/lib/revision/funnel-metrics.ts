/**
 * Engine 1 — funnel metrics (PURE, no I/O).
 *
 * A research queue is judged on its OUTPUT, not on the middle of the
 * distribution: a universe-wide IC of 0.01 says almost nothing about whether
 * the 25 names the user actually reads are worth reading. These functions
 * measure the top of the list — precision and hit rate against a random
 * basket of the same size, week-to-week overlap (can a human keep up), and
 * the cuts the brief calls out (cap, coverage, earnings window).
 *
 * Every function takes already-aligned weekly maps so the same code serves the
 * signal lab and the Validation canvas.
 */

export interface FunnelWeek {
  date: string;
  /** ticker -> rank score this week (the pickable set). */
  score: Map<string, number>;
  /** ticker -> peer-relative forward return from the t+1 entry. */
  forward: Map<string, number>;
}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

function quantile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]!;
}

/** Deterministic PRNG so a reported baseline is reproducible run to run. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `k` names with the highest score that also have a forward return. */
export function topKOf(week: FunnelWeek, k: number, side: "long" | "short" = "long"): string[] {
  const eligible = [...week.score.entries()].filter(
    ([t, z]) => Number.isFinite(z) && week.forward.has(t),
  );
  eligible.sort((a, b) => (side === "long" ? b[1] - a[1] : a[1] - b[1]));
  return eligible.slice(0, k).map(([t]) => t);
}

export interface TopKPrecision {
  k: number;
  /** Weeks with at least `k` eligible names and a printed forward return. */
  weeks: number;
  /** Mean across weeks of the top-k median peer-relative forward return. */
  medianReturn: number | null;
  /** Same statistic over random-k baskets: its mean and 5th/95th percentiles. */
  randomMedian: number | null;
  randomP5: number | null;
  randomP95: number | null;
  /** Share of random draws the real basket beats — 1.00 = better than all of them. */
  percentileVsRandom: number | null;
  /** Share of top-k picks with a positive peer-relative return. */
  hitRate: number | null;
  randomHitRate: number | null;
  draws: number;
}

/**
 * Top-k precision against a random-k baseline drawn from the SAME eligible set
 * each week, so the comparison is free of universe and period effects.
 */
export function topKPrecision(
  weeks: FunnelWeek[],
  k: number,
  opts: { draws?: number; seed?: number; side?: "long" | "short" } = {},
): TopKPrecision {
  const draws = opts.draws ?? 1000;
  const side = opts.side ?? "long";
  const rng = mulberry32(opts.seed ?? 12345);

  const pools: number[][] = [];
  const weekMedians: number[] = [];
  const weekHitRates: number[] = [];
  for (const w of weeks) {
    const top = topKOf(w, k, side);
    if (top.length < k) continue;
    const pool = [...w.score.keys()]
      .filter((t) => Number.isFinite(w.score.get(t)!) && w.forward.has(t))
      .map((t) => w.forward.get(t)!);
    if (pool.length < k) continue;
    pools.push(pool);
    const rets = top.map((t) => w.forward.get(t)!);
    weekMedians.push(median(rets)!);
    weekHitRates.push(rets.filter((r) => r > 0).length / rets.length);
  }
  if (pools.length === 0) {
    return {
      k,
      weeks: 0,
      medianReturn: null,
      randomMedian: null,
      randomP5: null,
      randomP95: null,
      percentileVsRandom: null,
      hitRate: null,
      randomHitRate: null,
      draws,
    };
  }

  const drawStats: number[] = [];
  const drawHits: number[] = [];
  const scratch = new Array<number>(k);
  for (let d = 0; d < draws; d++) {
    const meds: number[] = [];
    const hits: number[] = [];
    for (const pool of pools) {
      // Partial Fisher-Yates on indices, without mutating the pool.
      const picked = new Set<number>();
      for (let j = 0; j < k; j++) {
        let idx = Math.floor(rng() * pool.length);
        while (picked.has(idx)) idx = (idx + 1) % pool.length;
        picked.add(idx);
        scratch[j] = pool[idx]!;
      }
      meds.push(median(scratch)!);
      hits.push(scratch.filter((r) => r > 0).length / k);
    }
    drawStats.push(mean(meds)!);
    drawHits.push(mean(hits)!);
  }
  drawStats.sort((a, b) => a - b);
  const actual = mean(weekMedians)!;
  const beaten = drawStats.filter((v) => v < actual).length;

  return {
    k,
    weeks: pools.length,
    medianReturn: actual,
    randomMedian: mean(drawStats),
    randomP5: quantile(drawStats, 0.05),
    randomP95: quantile(drawStats, 0.95),
    percentileVsRandom: beaten / drawStats.length,
    hitRate: mean(weekHitRates),
    randomHitRate: mean(drawHits),
    draws,
  };
}

export interface QueueOverlap {
  k: number;
  transitions: number;
  /** Mean Jaccard of consecutive weeks' top-k sets. 1 = the list never moves. */
  meanJaccard: number | null;
  /** Mean count of names that are new this week. */
  meanArrivals: number | null;
}

/** Week-over-week churn of the top-k — how much re-reading the queue demands. */
export function queueOverlap(
  weeks: FunnelWeek[],
  k: number,
  side: "long" | "short" = "long",
): QueueOverlap {
  const sets = weeks.map((w) => new Set(topKOf(w, k, side)));
  const jac: number[] = [];
  const arrivals: number[] = [];
  for (let i = 1; i < sets.length; i++) {
    const a = sets[i - 1]!;
    const b = sets[i]!;
    if (a.size === 0 || b.size === 0) continue;
    let inter = 0;
    for (const t of b) if (a.has(t)) inter++;
    jac.push(inter / (a.size + b.size - inter));
    arrivals.push(b.size - inter);
  }
  return {
    k,
    transitions: jac.length,
    meanJaccard: mean(jac),
    meanArrivals: mean(arrivals),
  };
}

export interface CutStats {
  label: string;
  tickerWeeks: number;
  /** Mean across weeks of the within-cut Spearman IC. */
  meanIC: number | null;
  /** Share of this cut's ticker-weeks that land in the universe top decile. */
  topDecileShare: number | null;
}

/**
 * IC and top-decile share within each slice of the universe (cap tercile,
 * coverage tercile, in/out of the post-earnings window). `bucketOf` returns
 * null for ticker-weeks that belong to no slice.
 */
export function cutStats(
  weeks: FunnelWeek[],
  bucketOf: (date: string, ticker: string) => string | null,
  spearmanFn: (xs: number[], ys: number[]) => number | null,
): CutStats[] {
  const icsByBucket = new Map<string, number[]>();
  const countByBucket = new Map<string, number>();
  const topDecileByBucket = new Map<string, number>();

  for (const w of weeks) {
    const eligible = [...w.score.entries()].filter(
      ([t, z]) => Number.isFinite(z) && w.forward.has(t),
    );
    if (eligible.length < 10) continue;
    const cutoff = [...eligible].sort((a, b) => b[1] - a[1])[
      Math.max(0, Math.floor(eligible.length * 0.1) - 1)
    ]![1];

    const perBucket = new Map<string, { xs: number[]; ys: number[] }>();
    for (const [ticker, z] of eligible) {
      const b = bucketOf(w.date, ticker);
      if (b === null) continue;
      countByBucket.set(b, (countByBucket.get(b) ?? 0) + 1);
      if (z >= cutoff) topDecileByBucket.set(b, (topDecileByBucket.get(b) ?? 0) + 1);
      const acc = perBucket.get(b) ?? { xs: [], ys: [] };
      acc.xs.push(z);
      acc.ys.push(w.forward.get(ticker)!);
      perBucket.set(b, acc);
    }
    for (const [b, { xs, ys }] of perBucket) {
      if (xs.length < 5) continue;
      const ic = spearmanFn(xs, ys);
      if (ic === null) continue;
      const arr = icsByBucket.get(b);
      if (arr) arr.push(ic);
      else icsByBucket.set(b, [ic]);
    }
  }

  return [...countByBucket.keys()].sort().map((label) => ({
    label,
    tickerWeeks: countByBucket.get(label) ?? 0,
    meanIC: mean(icsByBucket.get(label) ?? []),
    topDecileShare:
      (countByBucket.get(label) ?? 0) > 0
        ? (topDecileByBucket.get(label) ?? 0) / countByBucket.get(label)!
        : null,
  }));
}

export interface NextPrintOutcome {
  k: number;
  weeks: number;
  /** Share of top-k whose next reported earnings beat consensus. */
  surpriseBeatRate: number | null;
  /** Share of top-k whose NEXT week's revision is still net-up. */
  followThroughRate: number | null;
  /** Universe base rates for the same two questions. */
  baseSurpriseBeatRate: number | null;
  baseFollowThroughRate: number | null;
}

/**
 * Does the score predict the next FUNDAMENTAL event, not just the next tick?
 * `nextBeat` / `nextNetUp` return null where the answer isn't known yet.
 */
export function nextPrintOutcome(
  weeks: FunnelWeek[],
  k: number,
  nextBeat: (date: string, ticker: string) => boolean | null,
  nextNetUp: (date: string, ticker: string) => boolean | null,
  side: "long" | "short" = "long",
): NextPrintOutcome {
  const rate = (vals: Array<boolean | null>): number | null => {
    const known = vals.filter((v): v is boolean => v !== null);
    return known.length ? known.filter(Boolean).length / known.length : null;
  };
  const topBeat: Array<boolean | null> = [];
  const topFollow: Array<boolean | null> = [];
  const allBeat: Array<boolean | null> = [];
  const allFollow: Array<boolean | null> = [];
  let usedWeeks = 0;

  for (const w of weeks) {
    const top = new Set(topKOf(w, k, side));
    if (top.size === 0) continue;
    usedWeeks++;
    for (const ticker of w.score.keys()) {
      const beat = nextBeat(w.date, ticker);
      const follow = nextNetUp(w.date, ticker);
      allBeat.push(beat);
      allFollow.push(follow);
      if (top.has(ticker)) {
        topBeat.push(beat);
        topFollow.push(follow);
      }
    }
  }
  return {
    k,
    weeks: usedWeeks,
    surpriseBeatRate: rate(topBeat),
    followThroughRate: rate(topFollow),
    baseSurpriseBeatRate: rate(allBeat),
    baseFollowThroughRate: rate(allFollow),
  };
}

export interface SurvivorshipNote {
  /** Universe size the lab reasons about (tickers seen anywhere on the grid). */
  labUniverse: number;
  /** Per grid date: tickers in the lab universe with no row that week. */
  missingByDate: Array<{ date: string; missing: number }>;
  meanMissing: number | null;
  /** Ticker-weeks dropped for want of a tradeable t+1 entry price. */
  droppedNoEntry: number;
}

/**
 * Names absent from each historical grid date. This is a FLAG, not a fix: the
 * revision reference holds today's listed universe, so a company delisted mid
 * sample simply has no rows and its (usually bad) outcome never enters the
 * statistics. Backfilling delisted names is the only real remedy.
 */
export function survivorshipNote(
  weeks: Array<{ date: string; present: Set<string> }>,
  labUniverse: Set<string>,
  droppedNoEntry: number,
): SurvivorshipNote {
  const missingByDate = weeks.map((w) => {
    let missing = 0;
    for (const t of labUniverse) if (!w.present.has(t)) missing++;
    return { date: w.date, missing };
  });
  return {
    labUniverse: labUniverse.size,
    missingByDate,
    meanMissing: mean(missingByDate.map((m) => m.missing)),
    droppedNoEntry,
  };
}
