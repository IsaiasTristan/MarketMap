import { describe, expect, it } from "vitest";
import { formatGapPp, pairCode, subsectorCode, subsectorCodes } from "@/lib/pairs/labels";

describe("subsectorCode", () => {
  it("takes the first token, uppercased, first 3 letters", () => {
    expect(subsectorCode("Analog/Power")).toBe("ANA");
    expect(subsectorCode("Networking/Optical")).toBe("NET");
    expect(subsectorCode("Enterprise SaaS")).toBe("ENT");
  });

  it("keeps short first tokens short", () => {
    expect(subsectorCode("AI/Compute")).toBe("AI");
  });

  it("splits on whitespace, slash, hyphen and ampersand", () => {
    expect(subsectorCode("Oil & Gas")).toBe("OIL");
    expect(subsectorCode("Semi-Cap Equipment")).toBe("SEM");
  });

  it("falls back to the raw key when there are no word tokens", () => {
    expect(subsectorCode("///")).toBe("///");
  });
});

describe("subsectorCodes", () => {
  it("gives every key a distinct code, widening on a collision", () => {
    const m = subsectorCodes(["Analog/Power", "Analytics/Data"]);
    expect(m.get("Analog/Power")).not.toBe(m.get("Analytics/Data"));
    // ANA is taken by the sorted-first key; the second widens to ANAL.
    expect(m.get("Analog/Power")).toBe("ANA");
    expect(m.get("Analytics/Data")).toBe("ANAL");
  });

  it("appends the second token initial when the 4-letter widen also clashes", () => {
    const m = subsectorCodes(["Data/Analytics", "Data/Warehouse", "Data/Center"]);
    const codes = new Set(m.values());
    expect(codes.size).toBe(3);
  });

  it("is deterministic regardless of input order", () => {
    const a = subsectorCodes(["Analytics/Data", "Analog/Power"]);
    const b = subsectorCodes(["Analog/Power", "Analytics/Data"]);
    expect(a.get("Analog/Power")).toBe(b.get("Analog/Power"));
    expect(a.get("Analytics/Data")).toBe(b.get("Analytics/Data"));
  });

  it("dedupes repeated keys", () => {
    const m = subsectorCodes(["Analog/Power", "Analog/Power"]);
    expect(m.size).toBe(1);
    expect(m.get("Analog/Power")).toBe("ANA");
  });
});

describe("pairCode", () => {
  it("joins the two subsector codes with a slash", () => {
    expect(pairCode("Analog/Power", "Networking/Optical")).toBe("ANA/NET");
  });
});

describe("formatGapPp", () => {
  it("signs positive gaps and renders one decimal by default", () => {
    expect(formatGapPp(4.25)).toBe("+4.3");
    expect(formatGapPp(-4.25)).toBe("-4.3");
  });

  it("honors an explicit decimal count so matrix and table round identically", () => {
    expect(formatGapPp(4.5, 0)).toBe("+5");
    expect(formatGapPp(-0.4, 0)).toBe("-0");
  });

  it("returns an em dash for null / non-finite", () => {
    expect(formatGapPp(null)).toBe("—");
    expect(formatGapPp(undefined)).toBe("—");
    expect(formatGapPp(Number.NaN)).toBe("—");
  });
});
