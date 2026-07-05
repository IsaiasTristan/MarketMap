import { describe, expect, it } from "vitest";
import { searchFunds, type FundIndexEntry } from "@/lib/institutional/fund-search";

const F = (over: Partial<FundIndexEntry> & { cik: string; name: string }): FundIndexEntry => ({
  category: "Growth/Quality",
  tier: "signal",
  isElite: false,
  aum13fUsd: 1e9,
  saved: false,
  aliases: [],
  ...over,
});

const INDEX: FundIndexEntry[] = [
  F({ cik: "0000807249", name: "GAMCO Investors", aliases: ["gabelli"], aum13fUsd: 15e9 }),
  F({ cik: "0000050503", name: "Harris Associates", aliases: ["oakmark"], aum13fUsd: 40e9 }),
  F({ cik: "0001067983", name: "Berkshire Hathaway", aliases: ["buffett", "warren buffett"], isElite: true, aum13fUsd: 300e9 }),
  F({ cik: "0001336528", name: "Pershing Square", aliases: ["ackman", "bill ackman"], aum13fUsd: 12e9 }),
  F({ cik: "0000934639", name: "Maverick Capital", aliases: [], aum13fUsd: 8e9 }),
  F({ cik: "0000012345", name: "Context Quant Fund", tier: "context", aum13fUsd: 500e9 }),
];

describe("searchFunds", () => {
  it("resolves an alias to the canonical fund", () => {
    expect(searchFunds("GAMCO", INDEX)[0]!.name).toBe("GAMCO Investors");
    expect(searchFunds("gabelli", INDEX)[0]!.name).toBe("GAMCO Investors");
    expect(searchFunds("Harris", INDEX)[0]!.name).toBe("Harris Associates");
    expect(searchFunds("oakmark", INDEX)[0]!.name).toBe("Harris Associates");
    const buffett = searchFunds("Buffett", INDEX)[0]!;
    expect(buffett.name).toBe("Berkshire Hathaway");
    expect(buffett.matchedOn).toBe("buffett");
  });

  it("matches a manager surname and CIK prefix", () => {
    expect(searchFunds("ackman", INDEX)[0]!.name).toBe("Pershing Square");
    const byCik = searchFunds("934639", INDEX)[0]!;
    expect(byCik.name).toBe("Maverick Capital");
    expect(byCik.matchKind).toBe("cik");
    expect(searchFunds("0000934639", INDEX)[0]!.name).toBe("Maverick Capital");
  });

  it("ranks a saved fund above a non-saved one on equal match quality", () => {
    // two prefix matches on "ma"; the saved one wins.
    const idx: FundIndexEntry[] = [
      F({ cik: "1", name: "Mara Capital", saved: false, aum13fUsd: 50e9 }),
      F({ cik: "2", name: "Maple Capital", saved: true, aum13fUsd: 1e9 }),
    ];
    const r = searchFunds("ma", idx);
    expect(r[0]!.name).toBe("Maple Capital"); // saved outranks larger-AUM non-saved
  });

  it("ranks signal over context on equal match quality despite larger context AUM", () => {
    const idx: FundIndexEntry[] = [
      F({ cik: "1", name: "Zed Context", tier: "context", aum13fUsd: 500e9 }),
      F({ cik: "2", name: "Zed Signal", tier: "signal", aum13fUsd: 1e9 }),
    ];
    // both prefix-match "zed", both unsaved → signal wins the tier tie-break.
    expect(searchFunds("zed", idx)[0]!.tier).toBe("signal");
  });

  it("prefix beats substring beats fuzzy", () => {
    const idx: FundIndexEntry[] = [
      F({ cik: "1", name: "Sculptor Capital" }), // 'cap' substring
      F({ cik: "2", name: "Capital Group" }), // 'cap' prefix
    ];
    const r = searchFunds("cap", idx);
    expect(r[0]!.name).toBe("Capital Group");
    expect(r[0]!.matchKind).toBe("prefix");
  });

  it("empty query returns nothing; respects maxResults", () => {
    expect(searchFunds("", INDEX)).toEqual([]);
    expect(searchFunds("   ", INDEX)).toEqual([]);
    expect(searchFunds("a", INDEX, { maxResults: 2 }).length).toBeLessThanOrEqual(2);
  });

  it("carries the context badge signal through results", () => {
    const r = searchFunds("Context", INDEX);
    expect(r[0]!.tier).toBe("context");
  });
});
