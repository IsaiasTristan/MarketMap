import { describe, expect, it } from "vitest";
import { isDailyDue, isWeeklyStale } from "@/server/services/revision-runner";
import {
  mergeRatingChanges,
  type PriceTargetEventInput,
  type RatingEventInput,
} from "@/server/services/revision/revision-query.service";

const DAY = 24 * 60 * 60_000;

describe("revision runner gates", () => {
  it("isDailyDue is true only when not yet run for today's ET date", () => {
    expect(isDailyDue(null, "2026-06-29")).toBe(true);
    expect(isDailyDue("2026-06-28", "2026-06-29")).toBe(true);
    expect(isDailyDue("2026-06-29", "2026-06-29")).toBe(false);
  });

  it("isWeeklyStale flags a missing snapshot or one at/over the threshold", () => {
    const now = Date.UTC(2026, 5, 29);
    expect(isWeeklyStale(null, now)).toBe(true);
    // 2 days old -> fresh
    expect(isWeeklyStale(now - 2 * DAY, now)).toBe(false);
    // exactly 7 days old -> stale (>=)
    expect(isWeeklyStale(now - 7 * DAY, now)).toBe(true);
    // 8 days old -> stale
    expect(isWeeklyStale(now - 8 * DAY, now)).toBe(true);
    // custom threshold
    expect(isWeeklyStale(now - 3 * DAY, now, 3)).toBe(true);
    expect(isWeeklyStale(now - 2 * DAY, now, 3)).toBe(false);
  });
});

describe("mergeRatingChanges", () => {
  const ratings: RatingEventInput[] = [
    {
      ticker: "AAPL",
      eventDate: new Date("2026-06-25T00:00:00Z"),
      gradingCompany: "Morgan Stanley",
      previousGrade: "Hold",
      newGrade: "Buy",
      action: "upgrade",
    },
  ];
  const targets: PriceTargetEventInput[] = [
    {
      ticker: "MSFT",
      publishedDate: new Date("2026-06-26T13:00:00Z"),
      analystCompany: "Goldman Sachs",
      analystName: "Jane Doe",
      priceTarget: 520,
      priceWhenPosted: 500,
      newsPublisher: "Benzinga",
    },
  ];

  it("merges both kinds into one feed sorted by date descending", () => {
    const rows = mergeRatingChanges(ratings, targets, 50);
    expect(rows).toHaveLength(2);
    expect(rows[0].ticker).toBe("MSFT"); // 06-26 newer than 06-25
    expect(rows[0].kind).toBe("PRICE_TARGET");
    expect(rows[1].ticker).toBe("AAPL");
    expect(rows[1].kind).toBe("RATING");
  });

  it("preserves discriminated shape (rating fields null on PT rows and vice versa)", () => {
    const [pt, rating] = mergeRatingChanges(ratings, targets, 50);
    expect(pt.priceTarget).toBe(520);
    expect(pt.previousGrade).toBeNull();
    expect(pt.action).toBeNull();
    expect(rating.newGrade).toBe("Buy");
    expect(rating.action).toBe("upgrade");
    expect(rating.priceTarget).toBeNull();
  });

  it("truncates to limit after sorting", () => {
    const rows = mergeRatingChanges(ratings, targets, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0].ticker).toBe("MSFT");
  });

  it("defaults companyName to the ticker and sector to null (overlay applied by caller)", () => {
    const rows = mergeRatingChanges(ratings, targets, 50);
    expect(rows.every((r) => r.companyName === r.ticker)).toBe(true);
    expect(rows.every((r) => r.sector === null)).toBe(true);
  });
});
