/**
 * Exit-lead attribution (FUNDS Part 2) — pure, DB-free.
 *
 * The exit-side mirror of follow attribution: which funds TRIM/EXIT a material
 * position and are then followed by a crowd exit. Reuses the existing exit-cluster
 * detector (≥3 high-conviction holders trimming/exiting in one quarter) as the
 * "crowd" signal — this core only decides lead vs. not.
 *
 *   QUALIFIED TRIM/EXIT — the trimmed position must have been a MATERIAL, qualified-size
 *     holding (reuses the initiation sizing framework): prior weight ≥ min_entry_bps
 *     AND prior sizing_mult ≥ min_sizing_mult (so a sub-median "starter" position exit
 *     never qualifies), and either a full exit OR a share reduction ≥ trim_min_pct.
 *   EXIT-LED — an exit cluster forms in the ticker within (q0, q0+follow_window].
 *   PENDING — window not yet elapsed and no cluster yet → excluded from the rate.
 *   NOT_LED — window elapsed with no following cluster.
 *
 * STASIS-BREAK tag: if the leading trim was itself a stasis-break (the departing fund's
 * tenure_mult ≥ long_hold_mult), the episode is flagged — the highest-signal exit-leads.
 *
 * Same no-lookahead (availableQuarter) + pending/min_n rules as Part 1.
 */
import { INITIATION_CONFIG, type InitiationConfig } from "@/domain/calculations/initiation";
import type { FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";

export type ExitLeadStatus = "exit_led" | "not_led" | "pending";

/**
 * A trim/exit qualifies for provenance only if the trimmed position was a material,
 * qualified-size holding (reuse the sizing framework) AND the reduction is real.
 * `priorPctOfBook` / `fundMedianPctOfBook` are percents (2 = 2%); `reductionPct` is a
 * percent of shares (100 = full exit).
 */
export function isQualifiedTrimForProvenance(
  priorPctOfBook: number,
  fundMedianPctOfBook: number,
  reductionPct: number,
  exited: boolean,
  config: FundsAttributionConfig,
  initConfig: InitiationConfig = INITIATION_CONFIG,
): boolean {
  const entryBps = priorPctOfBook * 100;
  const sizingMult = fundMedianPctOfBook > 0 ? priorPctOfBook / fundMedianPctOfBook : 0;
  const material = entryBps >= initConfig.min_entry_bps && sizingMult >= initConfig.min_sizing_mult;
  if (!material) return false;
  return exited || reductionPct >= config.trim_min_pct;
}

/** A qualified trim/exit event (already gated by isQualifiedTrimForProvenance upstream). */
export interface QualifiedTrim {
  fundId: string;
  ticker: string;
  quarter: number;
  /** The departing fund's tenure_mult ≥ long_hold_mult at the trim → highest-signal. */
  isStasisBreak: boolean;
  availableQuarter?: number;
}

/** A quarter in which an exit cluster formed for a ticker (≥3 high-conviction exits). */
export interface ExitClusterOccurrence {
  ticker: string;
  quarter: number;
}

export interface ExitLeadOutcome {
  fundId: string;
  ticker: string;
  quarter: number;
  status: ExitLeadStatus;
  /** Quarter the following cluster formed; null unless exit-led. */
  clusterQuarter: number | null;
  lead: number | null;
  isStasisBreak: boolean;
  age: number;
}

export interface FundExitLeadStats {
  fundId: string;
  n: number;
  led: number;
  exitLeadRate: number | null;
  /** Stasis-break-tagged exit-leds (a subset of `led`). */
  stasisLed: number;
  rateSufficient: boolean;
}

export interface ExitLeadAttribution {
  outcomes: ExitLeadOutcome[];
  funds: FundExitLeadStats[];
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;
const availOf = (t: { quarter: number; availableQuarter?: number }): number => t.availableQuarter ?? t.quarter;

export function computeExitLeadAttribution(
  trims: QualifiedTrim[],
  clusters: ExitClusterOccurrence[],
  config: FundsAttributionConfig,
  asOf?: number,
): ExitLeadAttribution {
  const maxQuarter =
    asOf ??
    Math.max(
      trims.reduce((m, t) => Math.max(m, t.quarter), 0),
      clusters.reduce((m, c) => Math.max(m, c.quarter), 0),
    );

  // Cluster quarters per ticker (sorted) for the "followed by a cluster" lookup.
  const clusterByTicker = new Map<string, number[]>();
  for (const c of clusters) (clusterByTicker.get(c.ticker) ?? clusterByTicker.set(c.ticker, []).get(c.ticker)!).push(c.quarter);
  for (const qs of clusterByTicker.values()) qs.sort((a, b) => a - b);

  const visible = trims
    .filter((t) => availOf(t) <= maxQuarter)
    .slice()
    .sort((a, b) => a.ticker.localeCompare(b.ticker) || a.quarter - b.quarter || a.fundId.localeCompare(b.fundId));

  const outcomes: ExitLeadOutcome[] = [];
  for (const t of visible) {
    const q0 = t.quarter;
    const windowEnd = Math.min(q0 + config.follow_window, maxQuarter);
    const clusterQs = clusterByTicker.get(t.ticker) ?? [];
    const following = clusterQs.find((q) => q > q0 && q <= windowEnd);
    const age = maxQuarter - q0;

    let status: ExitLeadStatus;
    let clusterQuarter: number | null = null;
    let lead: number | null = null;
    if (following !== undefined) {
      status = "exit_led";
      clusterQuarter = following;
      lead = following - q0;
    } else if (age < config.follow_window) {
      status = "pending";
    } else {
      status = "not_led";
    }
    outcomes.push({ fundId: t.fundId, ticker: t.ticker, quarter: q0, status, clusterQuarter, lead, isStasisBreak: t.isStasisBreak, age });
  }

  const windowStart = maxQuarter - config.stat_window + 1;
  const byFund = new Map<string, ExitLeadOutcome[]>();
  for (const o of outcomes) {
    if (o.quarter < windowStart) continue;
    (byFund.get(o.fundId) ?? byFund.set(o.fundId, []).get(o.fundId)!).push(o);
  }

  const funds: FundExitLeadStats[] = [];
  for (const [fundId, os] of byFund) {
    const resolved = os.filter((o) => o.status === "exit_led" || o.status === "not_led");
    const led = resolved.filter((o) => o.status === "exit_led").length;
    funds.push({
      fundId,
      n: resolved.length,
      led,
      exitLeadRate: resolved.length ? round4(led / resolved.length) : null,
      stasisLed: resolved.filter((o) => o.status === "exit_led" && o.isStasisBreak).length,
      rateSufficient: resolved.length >= config.min_n_for_rate,
    });
  }
  funds.sort((a, b) => a.fundId.localeCompare(b.fundId));

  return { outcomes, funds };
}
