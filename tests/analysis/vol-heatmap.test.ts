import { describe, expect, it } from "vitest";
import { heatVolClassification } from "@/domain/calculations/heatmap";

const NEUTRAL = "#464646";
const EXTREMELY_LOW = "#123812";
const VERY_LOW = "#1e5a1e";
const LOW = "#1a701a";
const MODERATELY_LOW = "#1e961e";
const SLIGHTLY_BELOW = "#2d7a2d";
const LOWER_MIDDLE = "#3d6a3d";
const MIDDLE = "#464646";
const SLIGHTLY_ABOVE = "#6a4545";
const MODERATELY_HIGH = "#8a4040";
const HIGH = "#9a2828";
const VERY_HIGH = "#b41e1e";
const EXTREMELY_HIGH = "#5a1e1e";
const SEVERE = "#451010";
const EXCEPTIONAL = "#2a0808";

describe("heatVolClassification", () => {
  it("maps each of the 14 bucket midpoints", () => {
    expect(heatVolClassification(0.05)).toBe(EXTREMELY_LOW);
    expect(heatVolClassification(0.12)).toBe(VERY_LOW);
    expect(heatVolClassification(0.17)).toBe(LOW);
    expect(heatVolClassification(0.22)).toBe(MODERATELY_LOW);
    expect(heatVolClassification(0.27)).toBe(SLIGHTLY_BELOW);
    expect(heatVolClassification(0.32)).toBe(LOWER_MIDDLE);
    expect(heatVolClassification(0.37)).toBe(MIDDLE);
    expect(heatVolClassification(0.45)).toBe(SLIGHTLY_ABOVE);
    expect(heatVolClassification(0.55)).toBe(MODERATELY_HIGH);
    expect(heatVolClassification(0.67)).toBe(HIGH);
    expect(heatVolClassification(0.82)).toBe(VERY_HIGH);
    expect(heatVolClassification(1.05)).toBe(EXTREMELY_HIGH);
    expect(heatVolClassification(1.5)).toBe(SEVERE);
    expect(heatVolClassification(2.0)).toBe(EXCEPTIONAL);
  });

  it("uses lower-inclusive boundaries", () => {
    expect(heatVolClassification(0.1)).toBe(VERY_LOW);
    expect(heatVolClassification(0.15)).toBe(LOW);
    expect(heatVolClassification(0.2)).toBe(MODERATELY_LOW);
    expect(heatVolClassification(0.25)).toBe(SLIGHTLY_BELOW);
    expect(heatVolClassification(0.3)).toBe(LOWER_MIDDLE);
    expect(heatVolClassification(0.35)).toBe(MIDDLE);
    expect(heatVolClassification(0.4)).toBe(SLIGHTLY_ABOVE);
    expect(heatVolClassification(0.5)).toBe(MODERATELY_HIGH);
    expect(heatVolClassification(0.6)).toBe(HIGH);
    expect(heatVolClassification(0.75)).toBe(VERY_HIGH);
    expect(heatVolClassification(0.9)).toBe(EXTREMELY_HIGH);
    expect(heatVolClassification(1.25)).toBe(SEVERE);
    expect(heatVolClassification(1.75)).toBe(EXCEPTIONAL);
  });

  it("returns neutral for non-finite or negative input", () => {
    expect(heatVolClassification(Number.NaN)).toBe(NEUTRAL);
    expect(heatVolClassification(Number.POSITIVE_INFINITY)).toBe(NEUTRAL);
    expect(heatVolClassification(-0.1)).toBe(NEUTRAL);
  });
});
