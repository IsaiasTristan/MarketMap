import { describe, expect, it } from "vitest";
import {
  breadthTint,
  enginesAgree,
  engineTagSign,
  fmtCap,
  fmtPctOrNm,
} from "@/lib/revision/screen-format";

describe("breadthTint", () => {
  it("is the neutral surface at zero and for missing values", () => {
    expect(breadthTint(0)).toBe("rgb(31,31,35)");
    expect(breadthTint(null)).toBe("rgb(31,31,35)");
    expect(breadthTint(Number.NaN)).toBe("rgb(31,31,35)");
  });

  it("reaches full green at +1 and full red at -1", () => {
    expect(breadthTint(1)).toBe("rgb(47,143,69)");
    expect(breadthTint(-1)).toBe("rgb(168,58,63)");
  });

  it("clamps beyond +-1 so one outlier industry cannot wash out the grid", () => {
    expect(breadthTint(4.2)).toBe(breadthTint(1));
    expect(breadthTint(-9)).toBe(breadthTint(-1));
  });

  it("interpolates monotonically toward green", () => {
    const g = (s: string) => Number(s.slice(4, -1).split(",")[1]);
    expect(g(breadthTint(0.25))).toBeLessThan(g(breadthTint(0.75)));
    expect(g(breadthTint(0.75))).toBeLessThan(g(breadthTint(1)));
  });
});

describe("fmtCap", () => {
  it("scales to T/B/M", () => {
    expect(fmtCap(2.34e12)).toBe("$2.3T");
    expect(fmtCap(1.44e9)).toBe("$1.4B");
    expect(fmtCap(8.2e8)).toBe("$820M");
    expect(fmtCap(4_200)).toBe("$4200");
  });

  it("is null-tolerant", () => {
    expect(fmtCap(null)).toBe("—");
    expect(fmtCap(undefined)).toBe("—");
  });
});

describe("fmtPctOrNm", () => {
  it("signs the value and renders a null base as n/m", () => {
    expect(fmtPctOrNm(0.0412)).toBe("+4.1%");
    expect(fmtPctOrNm(-0.0412)).toBe("-4.1%");
    expect(fmtPctOrNm(null)).toBe("n/m");
    expect(fmtPctOrNm(Number.POSITIVE_INFINITY)).toBe("n/m");
  });
});

describe("engineTagSign / enginesAgree", () => {
  it("maps each engine tag to its directional claim", () => {
    expect(engineTagSign("INFLECT")).toBe(1);
    expect(engineTagSign("ACCUM")).toBe(1);
    expect(engineTagSign("MOM+")).toBe(1);
    expect(engineTagSign("TRAP")).toBe(-1);
    expect(engineTagSign("CROWDED")).toBe(-1);
    expect(engineTagSign(null)).toBeNull();
    expect(engineTagSign("SOMETHING_ELSE")).toBeNull();
  });

  it("requires two directional tags pointing the same way", () => {
    expect(enginesAgree(["INFLECT", "ACCUM", null])).toBe(true);
    expect(enginesAgree(["TRAP", "DISTRIB", "VAL"])).toBe(false);
    expect(enginesAgree(["INFLECT", null, null])).toBe(false);
    expect(enginesAgree([null, null, null])).toBe(false);
  });
});
