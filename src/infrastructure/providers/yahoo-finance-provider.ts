import type {
  Bar,
  BenchmarkId,
  MarketDataProvider,
  SecurityMetadata,
} from "@/infrastructure/providers/market-data";
import { fetchYahooChartDaily } from "@/infrastructure/providers/yahoo-chart-http";
import { fetchYahooDisplayName } from "@/infrastructure/providers/yahoo-quote-http";

const BENCHMARK_TICKERS: Record<BenchmarkId, string> = {
  SP500: "^GSPC",
  NASDAQ: "^IXIC",
  DOW: "^DJI",
};

/**
 * Yahoo via public HTTP endpoints (chart + quote). Avoids bundling
 * yahoo-finance2, which pulls Deno-only test dependencies into Next.js.
 */
export class YahooFinanceMarketDataProvider implements MarketDataProvider {
  readonly id = "yahoo";

  static create(): YahooFinanceMarketDataProvider {
    return new YahooFinanceMarketDataProvider();
  }

  async fetchSecurityMetadata(ticker: string): Promise<SecurityMetadata | null> {
    const upper = ticker.trim().toUpperCase();
    const name = await fetchYahooDisplayName(upper);
    return { ticker: upper, name: String(name) };
  }

  async fetchHistoricalPrices(
    ticker: string,
    start: string,
    end: string
  ): Promise<Bar[]> {
    return fetchYahooChartDaily(ticker.trim(), start, end);
  }

  async fetchBenchmarkSeries(
    benchmark: BenchmarkId,
    start: string,
    end: string
  ): Promise<Bar[]> {
    const sym = BENCHMARK_TICKERS[benchmark];
    return fetchYahooChartDaily(sym, start, end);
  }

  async fetchFactorInputs(
    ticker: string
  ): Promise<Record<string, number> | null> {
    void ticker;
    return null;
  }
}
