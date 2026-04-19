import { describe, expect, it } from "vitest";
import {
  parsePastedUniverse,
  parseUniverseCsv,
  isValidTickerForStorage,
} from "@/domain/universe/parse";

const SAMPLE = `NVDA   NVIDIA      Semiconductors    AI Chips
AMD    AMD         Semiconductors    AI Chips
TSLA   Tesla       EVs               EV Manufacturers
`;

describe("parsePastedUniverse", () => {
  it("parses sample TSV", () => {
    const p = parsePastedUniverse(SAMPLE);
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("assert");
    expect(p.rows[0]!.ticker).toBe("NVDA");
    expect(p.rows[0]!.companyName).toBe("NVIDIA");
    expect(p.rows[0]!.subTheme).toBe("AI Chips");
    expect(p.rows[2]!.ticker).toBe("TSLA");
  });

  it("rejects short rows", () => {
    const p = parsePastedUniverse("A B");
    expect(p.ok).toBe(false);
  });

  it("parses Consumer Cyclical TSV block (sectors with spaces, slashes in sub-themes)", () => {
    const TSV =
      "AZO\tAutoZone Inc.\tConsumer Cyclical\tAuto Parts\n" +
      "BKNG\tBooking Holdings Inc.\tConsumer Cyclical\tTravel/Leisure\n" +
      "CCL\tCarnival Corporation\tConsumer Cyclical\tTravel/Leisure\n" +
      "CMG\tChipotle Mexican Grill Inc.\tConsumer Cyclical\tRestaurants\n" +
      "DAL\tDelta Air Lines Inc.\tConsumer Cyclical\tAirlines\n" +
      "DG\tDollar General Corporation\tConsumer Cyclical\tRetail/General\n" +
      "DHI\tD.R. Horton Inc.\tConsumer Cyclical\tHousing/Home\n" +
      "DKNG\tDraftKings Inc.\tConsumer Cyclical\tGaming/Lottery\n";
    const p = parsePastedUniverse(TSV);
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("assert");
    expect(p.rows).toHaveLength(8);
    expect(p.rows[0]!.ticker).toBe("AZO");
    expect(p.rows[0]!.companyName).toBe("AutoZone Inc.");
    expect(p.rows[0]!.sector).toBe("Consumer Cyclical");
    expect(p.rows[0]!.subTheme).toBe("Auto Parts");
    expect(p.rows[1]!.subTheme).toBe("Travel/Leisure");
    expect(p.rows[6]!.ticker).toBe("DHI");
  });
});

describe("ticker", () => {
  it("accepts US-style symbols", () => {
    expect(isValidTickerForStorage("BRK.B")).toBe(true);
  });
});

describe("parseUniverseCsv", () => {
  it("parses 4-column CSV (ticker, name, sector, sub-theme)", () => {
    const p = parseUniverseCsv(
      "NVDA,NVIDIA Corp,Semis & AI,AI/Compute\nAMD,AMD Inc,Semis & AI,AI/Compute"
    );
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("assert");
    expect(p.rows).toHaveLength(2);
    expect(p.rows[0]!.ticker).toBe("NVDA");
    expect(p.rows[0]!.companyName).toBe("NVIDIA Corp");
    expect(p.rows[0]!.sector).toBe("Semis & AI");
    expect(p.rows[0]!.subTheme).toBe("AI/Compute");
    expect(p.rows[1]!.ticker).toBe("AMD");
  });

  it("skips a header row when the first field is 'ticker'", () => {
    const p = parseUniverseCsv(
      "ticker,name,sector,subtheme\nAAPL,Apple Inc.,Tech,Hardware"
    );
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("assert");
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.ticker).toBe("AAPL");
    expect(p.rows[0]!.companyName).toBe("Apple Inc.");
  });

  it("handles quoted fields with embedded commas", () => {
    const p = parseUniverseCsv(
      'BRK.B,"Berkshire Hathaway, Inc.",Financials,Holding'
    );
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("assert");
    expect(p.rows[0]!.companyName).toBe("Berkshire Hathaway, Inc.");
  });

  it("rejects 3-column rows (name now required)", () => {
    const p = parseUniverseCsv("AAPL,Tech,Hardware");
    expect(p.ok).toBe(false);
    if (p.ok) throw new Error("assert");
    expect(p.errors[0]!.message).toMatch(/Expected 4 columns/);
  });

  it("rejects 2-column rows", () => {
    const p = parseUniverseCsv("AAPL,Tech");
    expect(p.ok).toBe(false);
  });

  it("accepts tab-separated paste in the CSV parser (TSV from a spreadsheet)", () => {
    const TSV =
      "AZO\tAutoZone Inc.\tConsumer Cyclical\tAuto Parts\n" +
      "BKNG\tBooking Holdings Inc.\tConsumer Cyclical\tTravel/Leisure\n" +
      "CMG\tChipotle Mexican Grill Inc.\tConsumer Cyclical\tRestaurants";
    const p = parseUniverseCsv(TSV);
    expect(p.ok).toBe(true);
    if (!p.ok) throw new Error("assert");
    expect(p.rows).toHaveLength(3);
    expect(p.rows[0]!.ticker).toBe("AZO");
    expect(p.rows[0]!.sector).toBe("Consumer Cyclical");
    expect(p.rows[1]!.subTheme).toBe("Travel/Leisure");
  });
});
