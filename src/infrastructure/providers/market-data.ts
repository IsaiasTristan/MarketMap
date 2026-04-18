/**
 * Provider ports — implementations live in separate modules (e.g. stooq, yahoo, tiingo).
 * Domain and services must depend on these types, not on vendor SDKs.
 */

export type ISODateString = string;

export interface SecurityMetadata {
  ticker: string;
  name: string;
  /** Exchange or MIC if available */
  exchange?: string;
  /** ISO 4217 */
  currency?: string;
}

export interface Bar {
  date: ISODateString;
  /** Split/dividend-adjusted close, if available; otherwise raw close. */
  adjClose: number;
  close?: number;
  volume?: bigint;
}

export type BenchmarkId = "SP500" | "NASDAQ" | "DOW";

export interface MarketDataProvider {
  readonly id: string;

  fetchSecurityMetadata(ticker: string): Promise<SecurityMetadata | null>;

  fetchHistoricalPrices(
    ticker: string,
    start: ISODateString,
    end: ISODateString
  ): Promise<Bar[]>;

  /** Benchmark series; same date conventions as `fetchHistoricalPrices` */
  fetchBenchmarkSeries(
    benchmark: BenchmarkId,
    start: ISODateString,
    end: ISODateString
  ): Promise<Bar[]>;

  /**
   * Stage-1: optional placeholder payload for factor proxies; Stage-2: richer row.
   * Callers may treat null as "not available".
   */
  fetchFactorInputs(
    ticker: string
  ): Promise<Record<string, number> | null>;
}
