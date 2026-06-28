import { describe, expect, it } from "vitest";
import {
  marketMapConstituentToReference,
  type MarketMapConstituentInput,
} from "@/server/services/revision/reference-ingest.service";

describe("marketMapConstituentToReference", () => {
  it("maps constituent fields, uppercasing/trimming the ticker and sub-theme -> subsector", () => {
    const input: MarketMapConstituentInput = {
      ticker: " aapl ",
      companyName: "Apple Inc.",
      sector: "Technology",
      subTheme: "Consumer Electronics",
      country: "US",
      currency: "USD",
      marketCap: 3_000_000_000_000,
    };
    expect(marketMapConstituentToReference(input)).toEqual({
      ticker: "AAPL",
      companyName: "Apple Inc.",
      cik: null,
      sector: "Technology",
      subsector: "Consumer Electronics",
      exchange: null,
      country: "US",
      currency: "USD",
      marketCap: 3_000_000_000_000,
      identifiers: {},
    });
  });

  it("normalizes blank/whitespace sector and subTheme to null", () => {
    const ref = marketMapConstituentToReference({
      ticker: "XYZ",
      companyName: "XYZ Corp",
      sector: "  ",
      subTheme: "",
      country: null,
      currency: null,
      marketCap: null,
    });
    expect(ref.sector).toBeNull();
    expect(ref.subsector).toBeNull();
    expect(ref.marketCap).toBeNull();
    expect(ref.country).toBeNull();
  });

  it("preserves a null market cap without coercing to 0", () => {
    const ref = marketMapConstituentToReference({
      ticker: "NOCAP",
      companyName: "No Cap Ltd",
      sector: "Industrials",
      subTheme: "Machinery",
      country: "US",
      currency: "USD",
      marketCap: null,
    });
    expect(ref.marketCap).toBeNull();
  });
});
