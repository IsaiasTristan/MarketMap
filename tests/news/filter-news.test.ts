/**
 * Pure tests for the portfolio news quality filter: company-token derivation,
 * relevance (incl. the live NFG cross-listing mis-tag), the reputable-publisher
 * allowlist with press-release bypass, clickbait-title denylist, and the
 * empty-preview gate.
 */
import { describe, it, expect } from "vitest";
import {
  deriveCompanyTokens,
  filterNewsArticles,
} from "../../src/lib/news/filter-news";
import type { NewsArticle } from "../../src/lib/news/rank-news";

function article(overrides: Partial<NewsArticle> = {}): NewsArticle {
  return {
    ticker: "AAA",
    publishedDate: "2026-06-29T10:00:00Z",
    title: "Alpha Corp reports record quarterly revenue and raises guidance",
    text: "Alpha Corp said on Monday that revenue rose 20% in the quarter, beating expectations and prompting a raised full-year outlook.",
    url: "https://news.example/aaa/1",
    site: "reuters.com",
    publisher: "Reuters",
    isPressRelease: false,
    ...overrides,
  };
}

const names = new Map<string, string>([
  ["AAA", "Alpha Corp"],
  ["NFG", "National Fuel Gas Company"],
  ["MOH", "Molina Healthcare, Inc."],
]);

describe("deriveCompanyTokens", () => {
  it("returns the first meaningful word, stripping suffixes", () => {
    expect(deriveCompanyTokens("Molina Healthcare, Inc.")).toBe("molina");
    expect(deriveCompanyTokens("DuPont de Nemours, Inc.")).toBe("dupont");
    expect(deriveCompanyTokens("BioCryst Pharmaceuticals, Inc.")).toBe("biocryst");
    expect(deriveCompanyTokens("The Cigna Group")).toBe("cigna");
    expect(deriveCompanyTokens("Take-Two Interactive Software, Inc.")).toBe("take-two");
  });

  it("uses two words when the leading word is generic", () => {
    expect(deriveCompanyTokens("National Fuel Gas Company")).toBe("national fuel");
  });
});

describe("filterNewsArticles", () => {
  it("keeps a relevant, allowlisted article with a real preview", () => {
    const out = filterNewsArticles([article()], names);
    expect(out).toHaveLength(1);
  });

  it("drops an article for a ticker not in the holdings map", () => {
    const out = filterNewsArticles([article({ ticker: "ZZZ" })], names);
    expect(out).toHaveLength(0);
  });

  it("drops articles with empty or too-short previews", () => {
    expect(filterNewsArticles([article({ text: null })], names)).toHaveLength(0);
    expect(filterNewsArticles([article({ text: "tiny" })], names)).toHaveLength(0);
  });

  it("drops the NFG cross-listing mis-tag but keeps the real National Fuel article", () => {
    const misTag = article({
      ticker: "NFG",
      title: "New Found Gold Receives Conditional Approval to Graduate to the TSX",
      text: "New Found Gold Corp. (TSXV: NFG) announced it received conditional approval to list on the Toronto Stock Exchange.",
      site: "globenewswire.com",
      publisher: "GlobeNewsWire",
    });
    const real = article({
      ticker: "NFG",
      title: "Seneca Resources and National Fuel Gas Company expand Appalachia operations",
      text: "National Fuel Gas Company (NYSE: NFG) said its Seneca Resources unit signed a strategic agreement to expand operations.",
      site: "reuters.com",
      publisher: "Reuters",
    });
    const out = filterNewsArticles([misTag, real], names);
    expect(out.map((a) => a.title)).toEqual([real.title]);
  });

  it("drops non-allowlisted aggregators but keeps reputable + PR wires", () => {
    const junk = article({ site: "gurufocus.com", publisher: "GuruFocus" });
    const reputable = article({ site: "cnbc.com", publisher: "CNBC" });
    const wire = article({ site: "prnewswire.com", publisher: "PRNewsWire" });
    const out = filterNewsArticles([junk, reputable, wire], names);
    expect(out).toHaveLength(2);
  });

  it("lets a press release bypass the publisher allowlist", () => {
    const pr = article({
      site: "somewire.io",
      publisher: "Some Wire",
      isPressRelease: true,
    });
    const out = filterNewsArticles([pr], names);
    expect(out).toHaveLength(1);
  });

  it("drops clickbait titles even from allowlisted sources", () => {
    const soars = article({
      ticker: "MOH",
      title: "Molina (MOH) Soars 6.3%: Is Further Upside Left in the Stock?",
      text: "Molina shares jumped in the latest session on above-average volume as investors weighed the move.",
      site: "seekingalpha.com",
      publisher: "Seeking Alpha",
    });
    const topList = article({
      title: "Top 5 Stocks to Buy Now for Long-Term Returns",
      text: "Alpha Corp and several peers feature in this roundup of names to consider for the long haul this year.",
      site: "fool.com",
      publisher: "Motley Fool",
    });
    const out = filterNewsArticles([soars, topList], names);
    expect(out).toHaveLength(0);
  });
});
