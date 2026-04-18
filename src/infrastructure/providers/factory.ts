import { marketDataProviderId } from "@/infrastructure/config/env";
import type { MarketDataProvider } from "@/infrastructure/providers/market-data";
import { YahooFinanceMarketDataProvider } from "@/infrastructure/providers/yahoo-finance-provider";

export function getMarketDataProvider(): MarketDataProvider {
  const id = marketDataProviderId();
  if (id === "yahoo") return YahooFinanceMarketDataProvider.create();
  throw new Error(`Unsupported MARKET_DATA_PROVIDER: ${id}`);
}
