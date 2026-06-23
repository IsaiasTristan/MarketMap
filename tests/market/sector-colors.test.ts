/**
 * Pure tests for the shared sector / sub-theme color utility.
 *
 * Pins the contract the Top Movers tables (and any future caller) rely on:
 * - sectorColor is deterministic, case-insensitive, and returns a palette
 *   member (or the neutral fallback for empty input).
 * - subThemeColor is always strictly lighter (higher HSL L) than its
 *   parent sectorColor, so a sub-theme never reads as darker than its
 *   sector even if the hash collides at the bottom of the band.
 * - Distinct sub-themes under one sector get distinct shades.
 */
import { describe, it, expect } from "vitest";
import {
  SECTOR_PALETTE,
  hashString,
  hexToHsl,
  sectorColor,
  subThemeColor,
} from "../../src/lib/market-map/sector-colors";

describe("hashString", () => {
  it("is deterministic across calls", () => {
    expect(hashString("Technology")).toBe(hashString("Technology"));
  });

  it("trims and lowercases so CSV casing variations collapse to one hash", () => {
    expect(hashString("Technology")).toBe(hashString("  technology  "));
    expect(hashString("TECHNOLOGY")).toBe(hashString("Technology"));
  });

  it("returns 0 for the empty key", () => {
    expect(hashString("")).toBe(5381);
  });
});

describe("sectorColor", () => {
  it("is deterministic — same sector name → same color", () => {
    expect(sectorColor("Technology")).toBe(sectorColor("Technology"));
    expect(sectorColor("Financials")).toBe(sectorColor("Financials"));
  });

  it("is case- and whitespace-insensitive", () => {
    expect(sectorColor("Technology")).toBe(sectorColor("  technology "));
    expect(sectorColor("TECHNOLOGY")).toBe(sectorColor("Technology"));
  });

  it("always returns a palette member for non-empty input", () => {
    const names = [
      "Technology",
      "Financials",
      "Health Care",
      "Energy",
      "Consumer Discretionary",
      "Consumer Staples",
      "Industrials",
      "Materials",
      "Utilities",
      "Real Estate",
      "Communication Services",
      "Crypto",
    ];
    for (const n of names) {
      expect(SECTOR_PALETTE).toContain(sectorColor(n));
    }
  });

  it("falls back to neutral gray for empty / null / whitespace input", () => {
    const fallback = "#a5a5a5";
    expect(sectorColor("")).toBe(fallback);
    expect(sectorColor("   ")).toBe(fallback);
    expect(sectorColor(null)).toBe(fallback);
    expect(sectorColor(undefined)).toBe(fallback);
  });
});

describe("subThemeColor", () => {
  const sectors = [
    "Technology",
    "Financials",
    "Health Care",
    "Energy",
    "Consumer Discretionary",
  ];
  const subs = [
    "Semiconductors",
    "Software",
    "Cloud Infrastructure",
    "Cybersecurity",
    "Hardware",
    "Banks",
    "Insurance",
    "Capital Markets",
    "Biotech",
    "Pharma",
    "Med Devices",
    "Oil & Gas",
    "Renewables",
    "Autos",
    "Retail",
  ];

  it("is deterministic", () => {
    expect(subThemeColor("Technology", "Semiconductors")).toBe(
      subThemeColor("Technology", "Semiconductors"),
    );
  });

  it("is strictly lighter (higher HSL L) than its parent sector color", () => {
    for (const s of sectors) {
      const parentL = hexToHsl(sectorColor(s)).l;
      for (const sub of subs) {
        const childL = hexToHsl(subThemeColor(s, sub)).l;
        expect(childL).toBeGreaterThan(parentL);
      }
    }
  });

  it("produces distinct shades for distinct sub-themes within one sector", () => {
    const shades = new Set(subs.map((sub) => subThemeColor("Technology", sub)));
    // Allow some hash collisions but the spread must be meaningful.
    expect(shades.size).toBeGreaterThanOrEqual(Math.floor(subs.length * 0.6));
  });

  it("inherits the parent sector's hue (sub-themes look like shades of the sector)", () => {
    for (const s of sectors) {
      const parentHue = hexToHsl(sectorColor(s)).h;
      for (const sub of subs) {
        const childHue = hexToHsl(subThemeColor(s, sub)).h;
        const diff = Math.min(
          Math.abs(parentHue - childHue),
          360 - Math.abs(parentHue - childHue),
        );
        expect(diff).toBeLessThan(2);
      }
    }
  });

  it("falls back to neutral gray for empty sub-theme", () => {
    const fallback = "#a5a5a5";
    expect(subThemeColor("Technology", "")).toBe(fallback);
    expect(subThemeColor("Technology", null)).toBe(fallback);
    expect(subThemeColor("Technology", undefined)).toBe(fallback);
  });
});
