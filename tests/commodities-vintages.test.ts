import { describe, expect, it } from "vitest";
import {
  VINTAGE_DEFS,
  resolveVintages,
  subtractTradingDays,
} from "@/lib/commodities/vintages";

describe("VINTAGE_DEFS", () => {
  it("maps ids to trading-day lags 0/1/5/21/63/126/251", () => {
    const byId = new Map(VINTAGE_DEFS.map((d) => [d.id, d.lagTradingDays]));
    expect(byId.get("LATEST")).toBe(0);
    expect(byId.get("1D")).toBe(1);
    expect(byId.get("1W")).toBe(5);
    expect(byId.get("1M")).toBe(21);
    expect(byId.get("3M")).toBe(63);
    expect(byId.get("6M")).toBe(126);
    expect(byId.get("1Y")).toBe(251);
  });
});

describe("subtractTradingDays", () => {
  it("Monday minus 1 trading day lands on Friday (weekend skipped)", () => {
    // 2026-07-13 is a Monday.
    expect(subtractTradingDays("2026-07-13", 1)).toBe("2026-07-10");
  });

  it("mid-week minus 1 is the previous calendar day", () => {
    // 2026-07-15 is a Wednesday.
    expect(subtractTradingDays("2026-07-15", 1)).toBe("2026-07-14");
  });

  it("minus 5 from Monday is the previous Monday", () => {
    expect(subtractTradingDays("2026-07-13", 5)).toBe("2026-07-06");
  });

  it("crosses multiple weekends", () => {
    // Back 6 weekdays from Mon 7/13: 10, 9, 8, 7, 6, then skip Sun 7/5 +
    // Sat 7/4 to Fri 7/3.
    expect(subtractTradingDays("2026-07-13", 6)).toBe("2026-07-03");
  });

  it("n = 0 returns the input unchanged", () => {
    expect(subtractTradingDays("2026-07-13", 0)).toBe("2026-07-13");
  });

  it("crosses month and year boundaries", () => {
    // 2026-01-02 is a Friday; 1 trading day back is Thu 2026-01-01
    // (weekday-only convention — holidays are not skipped).
    expect(subtractTradingDays("2026-01-02", 1)).toBe("2026-01-01");
    expect(subtractTradingDays("2026-01-02", 2)).toBe("2025-12-31");
  });
});

describe("resolveVintages", () => {
  const latest = "2026-07-13"; // Monday
  // Unsorted, with a duplicate.
  const available = ["2026-07-02", "2026-07-10", "2026-06-30", "2026-07-10"];

  it("excludes LATEST and returns one row per lagged def", () => {
    const rows = resolveVintages(latest, available);
    expect(rows.map((r) => r.id)).toEqual(["1D", "1W", "1M", "3M", "6M", "1Y"]);
  });

  it("resolves exactly when the target date is available (weekend lag)", () => {
    const rows = resolveVintages(latest, available);
    const d1 = rows.find((r) => r.id === "1D")!;
    expect(d1.targetDate).toBe("2026-07-10"); // Friday
    expect(d1.resolvedDate).toBe("2026-07-10");
  });

  it("falls back to the nearest EARLIER snapshot when the target is missing (holiday gap)", () => {
    const rows = resolveVintages(latest, available);
    const w1 = rows.find((r) => r.id === "1W")!;
    expect(w1.targetDate).toBe("2026-07-06"); // not in available
    expect(w1.resolvedDate).toBe("2026-07-02"); // nearest earlier, never later
  });

  it("returns null when no snapshot exists at or before the target", () => {
    const rows = resolveVintages(latest, available);
    // 1M target is 2026-06-12; earliest available is 2026-06-30.
    const m1 = rows.find((r) => r.id === "1M")!;
    expect(m1.targetDate).toBe("2026-06-12");
    expect(m1.resolvedDate).toBeNull();
    expect(rows.find((r) => r.id === "1Y")!.resolvedDate).toBeNull();
  });

  it("handles an empty available-dates list", () => {
    const rows = resolveVintages(latest, []);
    for (const r of rows) expect(r.resolvedDate).toBeNull();
  });
});
