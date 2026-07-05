import { describe, expect, it } from "vitest";
import {
  isLateFilerRefreshDue,
  isNewSettledQuarter,
  quartersBehind,
} from "@/server/services/institutional-runner";
import { latestSettledQuarter } from "@/server/services/institutional/institutional-ingest.service";

const DAY = 24 * 60 * 60_000;

/** Q1-2026 (period-end 2026-03-31) settles at period-end + 46d = 2026-05-16. */
const Q1_SETTLE = new Date("2026-05-16T00:00:00Z");

describe("latestSettledQuarter settle boundary", () => {
  it("flips from Q4-2025 to Q1-2026 exactly 46 days after quarter-end", () => {
    const dayBefore = new Date(Q1_SETTLE.getTime() - DAY); // day 45
    expect(latestSettledQuarter(dayBefore).periodEnd).toBe("2025-12-31");
    expect(latestSettledQuarter(Q1_SETTLE).periodEnd).toBe("2026-03-31"); // day 46
    const dayAfter = new Date(Q1_SETTLE.getTime() + DAY); // day 47
    expect(latestSettledQuarter(dayAfter).periodEnd).toBe("2026-03-31");
  });
});

describe("Gate A - isNewSettledQuarter / quartersBehind", () => {
  const now = new Date("2026-07-05T00:00:00Z"); // latest settled: Q1-2026

  it("fires when the store lags the latest settled quarter", () => {
    expect(isNewSettledQuarter("2025-12-31", now)).toBe(true);
    expect(quartersBehind("2025-12-31", now)).toBe(1);
  });

  it("does not fire when the store is current (or ahead)", () => {
    expect(isNewSettledQuarter("2026-03-31", now)).toBe(false);
    expect(quartersBehind("2026-03-31", now)).toBe(0);
    expect(isNewSettledQuarter("2026-06-30", now)).toBe(false); // ahead - never negative
  });

  it("scales depth to the lag and treats an empty store as fully behind", () => {
    expect(quartersBehind("2025-06-30", now)).toBe(3); // Q3-25, Q4-25, Q1-26
    expect(quartersBehind(null, now)).toBe(12);
    expect(isNewSettledQuarter(null, now)).toBe(true);
  });
});

describe("Gate B - isLateFilerRefreshDue", () => {
  it("is due inside the 60-day window when the last ingest is >= 7 days old", () => {
    const now = new Date(Q1_SETTLE.getTime() + 20 * DAY);
    expect(isLateFilerRefreshDue(now, now.getTime() - 8 * DAY)).toBe(true);
    expect(isLateFilerRefreshDue(now, now.getTime() - 7 * DAY)).toBe(true);
    expect(isLateFilerRefreshDue(now, null)).toBe(true); // no write timestamp yet
  });

  it("is not due when the last ingest is recent", () => {
    const now = new Date(Q1_SETTLE.getTime() + 20 * DAY);
    expect(isLateFilerRefreshDue(now, now.getTime() - 2 * DAY)).toBe(false);
  });

  it("is never due outside the post-settle window", () => {
    const past = new Date(Q1_SETTLE.getTime() + 61 * DAY);
    expect(isLateFilerRefreshDue(past, past.getTime() - 30 * DAY)).toBe(false);
    expect(isLateFilerRefreshDue(past, null)).toBe(false);
  });

  it("covers the window edges (day 0 and day 60 inclusive)", () => {
    expect(isLateFilerRefreshDue(Q1_SETTLE, null)).toBe(true);
    const edge = new Date(Q1_SETTLE.getTime() + 60 * DAY);
    expect(isLateFilerRefreshDue(edge, null)).toBe(true);
  });
});
