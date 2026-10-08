import { describe, expect, it } from "vitest";
import {
  dedupeAcrossSources,
  meshPtSources,
  normalizeFirmName,
  toUnifiedEvents,
  type SourcedPtEvent,
} from "@/lib/revision/pt-sources";

const tr = (dateIso: string, pt: number, firm: string, expertUID: string): SourcedPtEvent => ({
  dateIso,
  priceTarget: pt,
  source: "TIPRANKS",
  expertUID,
  firm,
});
const fmp = (dateIso: string, pt: number, firm: string | null): SourcedPtEvent => ({
  dateIso,
  priceTarget: pt,
  source: "FMP",
  expertUID: null,
  firm,
});

describe("normalizeFirmName", () => {
  it("strips punctuation + corporate suffixes and applies aliases", () => {
    expect(normalizeFirmName("Morgan Stanley & Co.")).toBe("morgan stanley");
    expect(normalizeFirmName("Citigroup")).toBe("citi");
    expect(normalizeFirmName("Citi")).toBe("citi");
    expect(normalizeFirmName("Stifel Nicolaus")).toBe("stifel");
    expect(normalizeFirmName("H.C. Wainwright")).toBe("hc wainwright");
    expect(normalizeFirmName("B. Riley Securities")).toBe("b riley");
    expect(normalizeFirmName("B.Riley Financial")).toBe("b riley");
    expect(normalizeFirmName("Craig-Hallum")).toBe("craig-hallum");
    expect(normalizeFirmName("JP Morgan")).toBe("jpmorgan");
    expect(normalizeFirmName("J.P. Morgan")).toBe("jpmorgan");
    expect(normalizeFirmName("Goldman Sachs Group Inc")).toBe("goldman");
    expect(normalizeFirmName("Raymond James Financial")).toBe("raymond james");
  });
  it("returns null for blank input and keeps unknown names intact (lower-cased)", () => {
    expect(normalizeFirmName(null)).toBeNull();
    expect(normalizeFirmName("   ")).toBeNull();
    expect(normalizeFirmName("Zephyr Analytics")).toBe("zephyr analytics");
  });
});

describe("dedupeAcrossSources", () => {
  it("drops FMP rows matching a TipRanks row on firm + target within the window, keeps TipRanks", () => {
    const t = [tr("2026-03-10", 150, "Morgan Stanley", "u1")];
    const f = [
      fmp("2026-03-12", 150, "Morgan Stanley & Co."), // same firm, same PT, +2d -> dup
      fmp("2026-03-12", 155, "Morgan Stanley"), // different PT -> kept
      fmp("2026-03-20", 150, "Morgan Stanley"), // +10d -> outside window -> kept
      fmp("2026-03-10", 150, "Barclays"), // other firm -> kept
    ];
    const { kept, droppedFmp } = dedupeAcrossSources(t, f);
    expect(droppedFmp).toBe(1);
    expect(kept).toHaveLength(4);
    expect(kept.filter((e) => e.source === "TIPRANKS")).toHaveLength(1);
  });
  it("is a no-op with no TipRanks rows (pure FMP era) and with no FMP rows", () => {
    expect(dedupeAcrossSources([], [fmp("2026-03-10", 1, "X")]).kept).toHaveLength(1);
    expect(dedupeAcrossSources([tr("2026-03-10", 1, "X", "u")], []).kept).toHaveLength(1);
  });
  it("never dedupes null-firm FMP rows", () => {
    const { kept } = dedupeAcrossSources([tr("2026-03-10", 150, "X", "u")], [fmp("2026-03-10", 150, null)]);
    expect(kept).toHaveLength(2);
  });
});

describe("toUnifiedEvents (supersession key bridge)", () => {
  it("keys TipRanks rows on expertUID and bridges FMP rows to the firm's single known analyst", () => {
    const out = toUnifiedEvents([tr("2026-03-10", 150, "Morgan Stanley", "u1"), fmp("2026-06-01", 170, "Morgan Stanley & Co")]);
    expect(out[0]!.analyst).toBe("u1");
    expect(out[1]!.analyst).toBe("u1"); // post-cancellation FMP update supersedes the TipRanks target
  });
  it("falls back to the normalized firm when the firm has multiple TipRanks analysts or none", () => {
    const out = toUnifiedEvents([
      tr("2026-03-10", 150, "Morgan Stanley", "u1"),
      tr("2026-03-11", 160, "Morgan Stanley", "u2"),
      fmp("2026-06-01", 170, "Morgan Stanley"),
      fmp("2026-06-01", 50, "Barclays"),
    ]);
    expect(out[2]!.analyst).toBe("morgan stanley");
    expect(out[3]!.analyst).toBe("barclays");
  });
  it("leaves anonymous FMP rows null-keyed", () => {
    expect(toUnifiedEvents([fmp("2026-06-01", 50, null)])[0]!.analyst).toBeNull();
  });
});

describe("meshPtSources", () => {
  it("dedupes then keys, tagging source for the panel mix diagnostic", () => {
    const { events, droppedFmp } = meshPtSources(
      [tr("2026-03-10", 150, "Citi", "u1")],
      [fmp("2026-03-11", 150, "Citigroup"), fmp("2026-04-01", 160, "Citigroup")],
    );
    expect(droppedFmp).toBe(1);
    expect(events.map((e) => [e.analyst, e.source, e.priceTarget])).toEqual([
      ["u1", "TIPRANKS", 150],
      ["u1", "FMP", 160],
    ]);
  });
});
