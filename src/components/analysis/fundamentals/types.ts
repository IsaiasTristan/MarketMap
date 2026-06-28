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

export interface DiscoveryRow {
  ticker: string;
  companyName: string;
  sector: string | null;
  subsector: string | null;
  /** Per-name total returns (D1..Y1) merged from the cached market map. */
  returns?: Record<Horizon, number | null> | null;
  composite: number | null;
  rank: number | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
  newArrival: boolean;
  trapFlag: boolean;
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

export interface DiscoveryPayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: DiscoveryRow[];
}
