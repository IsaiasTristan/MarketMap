export interface InflectionSet {
  grossMarginInflection: number | null;
  ebitdaMarginInflection: number | null;
  revenueGrowthAccel: number | null;
  fcfInflection: number | null;
  roicTrend: number | null;
  deleveraging: number | null;
}

/** Underlying 8-quarter series each inflection consumes (oldest -> newest), for sparklines. */
export interface InflectionSeriesSet {
  grossMargin: number[];
  ebitdaMargin: number[];
  revenueGrowth: number[];
  fcf: number[];
  roic: number[];
  netDebtToEbitda: number[];
}

import type { Horizon } from "@/domain/entities/horizons";
import type { BoxKey } from "@/lib/fundamental/boxes";
import type { BoxAudit } from "@/lib/fundamental/box-scoring";

export type { BoxKey };
export type { BoxAudit, ComponentAudit } from "@/lib/fundamental/box-scoring";

/** Box key -> box score (mean of the box's available component z-scores). */
export type BoxScoreMap = Partial<Record<BoxKey, number | null>>;

export interface DiscoveryRow {
  ticker: string;
  companyName: string;
  sector: string | null;
  subsector: string | null;
  /** Per-name total returns (D1..Y1) merged from the cached market map. */
  returns?: Record<Horizon, number | null> | null;
  composite: number | null;
  /** Count of boxes that produced a score (>= 8 required for a composite). */
  validBoxCount?: number;
  rank: number | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
  newArrival: boolean;
  trapFlag: boolean;
  /** Trap & data-quality flags (display-only; never alter the composite in V1). */
  flags?: string[];
  /** Per-box score (the multi-box grid columns). */
  boxScores?: BoxScoreMap;
  /** Full per-box / per-component audit (raw + peer z). */
  boxes?: BoxAudit[];
  /**
   * Underlying last-~8-quarter metric series per box component, keyed by the
   * flat component key `${box}.${component}`, for the composition panel's
   * sparklines. Point-in-time components carry no entry.
   */
  componentSeries?: Record<string, number[]>;
  /**
   * Point-in-time box z-score over the last ~8 quarters (oldest -> newest),
   * keyed by box key, for the collapsed grid's per-box sparkline. Reconstructed
   * from the backfilled historicals (restated-basis, display-only). Boxes/dates
   * with no value carry null; Forecast Confidence has no history yet.
   */
  boxScoreHistory?: Partial<Record<BoxKey, Array<number | null>>>;
  compounderScore: number | null;
  compounderLevel: number | null;
  compounderConsistency: number | null;
  cheapness: number | null;
  accrualsDivergence: number | null;
  marginNow: number | null;
  marginPrior: number | null;
  inflection: InflectionSet;
  series?: InflectionSeriesSet;
  z: Record<string, number | null>;
}

/** The audited scoreJson the diligence panel renders (mirrors the scoring service). */
export interface FundamentalScoreJson {
  scoreMethodologyVersion?: string;
  composite: number | null;
  validBoxCount: number;
  boxScores: BoxScoreMap;
  boxes: BoxAudit[];
  flags: string[];
  peerGroup?: { peerGroupType?: string; peerGroupKey?: string };
  inflection?: InflectionSet;
  z?: Record<string, number | null>;
  series?: InflectionSeriesSet;
  compounder?: { score: number | null; level: number | null; consistency: number | null };
  accruals?: { ratio: number | null; divergence: number | null };
  valuation?: { cheapness: number | null; peRatio: number | null; evToEbitda: number | null; priceToSales: number | null };
}

export interface DiscoveryPayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: DiscoveryRow[];
}
