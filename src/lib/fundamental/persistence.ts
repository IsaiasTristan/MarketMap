/**
 * Box 5 — Inflection Persistence. Pure math, no I/O. Answers: across the core
 * fundamentals, how consistently has improvement continued over the last few
 * quarterly transitions? Breadth = improving observations / valid observations
 * over N metrics x the last K transitions. Single component, oriented HIGHER =
 * BETTER. The breadth is z-scored cross-sectionally in the scoring layer.
 */

export interface PersistenceMetric {
  /** Chronological (oldest -> newest) series for one core metric. */
  series: Array<number | null>;
  /** True when a DECLINE is an improvement (e.g. net debt / leverage). */
  lowerIsBetter?: boolean;
}

/** Minimum valid metric-quarter observations required to score the box. */
export const MIN_PERSISTENCE_OBSERVATIONS = 6;

function finite(series: Array<number | null>): number[] {
  return series.filter((v): v is number => v !== null && Number.isFinite(v));
}

/**
 * Persistence breadth in [0,1]: fraction of valid metric-quarter transitions
 * that were improvements, over the last `transitions` deltas of each metric.
 * Null when fewer than MIN_PERSISTENCE_OBSERVATIONS valid observations exist.
 */
export function persistenceBreadth(
  metrics: PersistenceMetric[],
  transitions = 3,
): number | null {
  let improving = 0;
  let valid = 0;
  for (const m of metrics) {
    const f = finite(m.series);
    if (f.length < 2) continue;
    // Last `transitions` consecutive deltas among the finite points.
    const start = Math.max(1, f.length - transitions);
    for (let i = start; i < f.length; i++) {
      const delta = f[i]! - f[i - 1]!;
      if (delta === 0) {
        valid++; // flat is a valid, non-improving observation
        continue;
      }
      const improved = m.lowerIsBetter ? delta < 0 : delta > 0;
      valid++;
      if (improved) improving++;
    }
  }
  if (valid < MIN_PERSISTENCE_OBSERVATIONS) return null;
  return improving / valid;
}

export const PERSISTENCE_COMPONENT_KEYS = ["persistenceBreadth"] as const;

export type PersistenceComponents = Record<
  (typeof PERSISTENCE_COMPONENT_KEYS)[number],
  number | null
>;

export interface PersistenceInputs {
  revenueGrowthYoy: Array<number | null>;
  grossMargin: Array<number | null>;
  ebitdaMargin: Array<number | null>;
  fcfMargin: Array<number | null>;
  roic: Array<number | null>;
  netDebtToEbitda: Array<number | null>;
}

/** Assemble the persistence component over the six core fundamentals. */
export function persistenceComponents(inputs: PersistenceInputs): PersistenceComponents {
  return {
    persistenceBreadth: persistenceBreadth([
      { series: inputs.revenueGrowthYoy },
      { series: inputs.grossMargin },
      { series: inputs.ebitdaMargin },
      { series: inputs.fcfMargin },
      { series: inputs.roic },
      { series: inputs.netDebtToEbitda, lowerIsBetter: true },
    ]),
  };
}
