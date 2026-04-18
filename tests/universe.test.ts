import { describe, expect, it } from "vitest";
import { parsePastedUniverse, isValidTickerForStorage } from "@/domain/universe/parse";

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
});

describe("ticker", () => {
  it("accepts US-style symbols", () => {
    expect(isValidTickerForStorage("BRK.B")).toBe(true);
  });
});
