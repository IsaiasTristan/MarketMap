import { describe, it, expect } from "vitest";
import { isBrokerageSyncDue } from "@/lib/brokerage/sync-gate";

/** Helper: a UTC instant. ET is UTC-5 (EST) / UTC-4 (EDT). */
function utc(iso: string): Date {
  return new Date(iso);
}

describe("isBrokerageSyncDue", () => {
  it("is false before 16:30 ET even with no prior sync", () => {
    // 2026-01-15 20:00Z = 15:00 ET (EST) — before the gate.
    expect(isBrokerageSyncDue(null, utc("2026-01-15T20:00:00Z"))).toBe(false);
  });

  it("is true at/after 16:30 ET with no prior sync", () => {
    // 2026-01-15 21:35Z = 16:35 ET (EST) — after the gate.
    expect(isBrokerageSyncDue(null, utc("2026-01-15T21:35:00Z"))).toBe(true);
  });

  it("is false when already synced on the same ET day", () => {
    const last = utc("2026-01-15T21:40:00Z"); // 16:40 ET
    const now = utc("2026-01-15T22:10:00Z"); // 17:10 ET, same ET day
    expect(isBrokerageSyncDue(last, now)).toBe(false);
  });

  it("is true again on the next ET day after the gate", () => {
    const last = utc("2026-01-15T21:40:00Z"); // Jan 15 16:40 ET
    const now = utc("2026-01-16T21:40:00Z"); // Jan 16 16:40 ET
    expect(isBrokerageSyncDue(last, now)).toBe(true);
  });

  it("handles the EDT (summer) offset: 16:35 ET = 20:35Z", () => {
    // In July ET is UTC-4, so 20:35Z = 16:35 ET — after the gate.
    expect(isBrokerageSyncDue(null, utc("2026-07-15T20:35:00Z"))).toBe(true);
    // 20:00Z = 16:00 ET — before the gate.
    expect(isBrokerageSyncDue(null, utc("2026-07-15T20:00:00Z"))).toBe(false);
  });

  it("treats a late-evening UTC instant that is still the same ET day as not due", () => {
    // 2026-01-16 02:00Z = 2026-01-15 21:00 ET. Last sync 2026-01-15 21:40Z
    // (16:40 ET same ET day) → not due.
    const last = utc("2026-01-15T21:40:00Z");
    const now = utc("2026-01-16T02:00:00Z");
    expect(isBrokerageSyncDue(last, now)).toBe(false);
  });
});
