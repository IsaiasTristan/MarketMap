/**
 * Pure tests for the portfolio news ranking helper: dedupe by URL, per-ticker
 * cap, round-robin spread across tickers, recency ordering + global cap,
 * company-name attachment, and dropping unknown tickers.
 */
import { describe, it, expect } from "vitest";
import { rankPortfolioNews, type NewsArticle } from "../../src/lib/news/rank-news";

function article(
  ticker: string,
  publishedDate: string,
  overrides: Partial<NewsArticle> = {},
): NewsArticle {
  return {
    ticker,
    publishedDate,
    title: `${ticker} ${publishedDate}`,
    text: `preview for ${ticker} ${publishedDate}`,
    url: `https://news.example/${ticker}/${publishedDate}`,
    site: "example.com",
    publisher: "Example",
    isPressRelease: false,
    ...overrides,
  };
}

const names = new Map<string, string>([
  ["AAA", "Alpha Corp"],
  ["BBB", "Beta Inc"],
  ["CCC", "Gamma Ltd"],
]);

describe("rankPortfolioNews", () => {
  it("attaches the resolved company name and maps fields to display rows", () => {
    const rows = rankPortfolioNews(
      [article("AAA", "2026-06-29T10:00:00Z")],
      names,
      { limit: 25, perTickerCap: 4 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ticker: "AAA",
      companyName: "Alpha Corp",
      preview: "preview for AAA 2026-06-29T10:00:00Z",
    });
  });

  it("dedupes by URL keeping the newest occurrence", () => {
    const dupUrl = "https://news.example/dup";
    const rows = rankPortfolioNews(
      [
        article("AAA", "2026-06-20T10:00:00Z", { url: dupUrl, title: "old" }),
        article("AAA", "2026-06-29T10:00:00Z", { url: dupUrl, title: "new" }),
      ],
      names,
      { limit: 25, perTickerCap: 4 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("new");
  });

  it("drops articles for tickers not in the holdings map", () => {
    const rows = rankPortfolioNews(
      [article("AAA", "2026-06-29T10:00:00Z"), article("ZZZ", "2026-06-29T11:00:00Z")],
      names,
      { limit: 25, perTickerCap: 4 },
    );
    expect(rows.map((r) => r.ticker)).toEqual(["AAA"]);
  });

  it("caps the number of articles kept per ticker", () => {
    const arts = Array.from({ length: 8 }, (_, i) =>
      article("AAA", `2026-06-${String(10 + i).padStart(2, "0")}T10:00:00Z`),
    );
    const rows = rankPortfolioNews(arts, names, { limit: 25, perTickerCap: 3 });
    expect(rows).toHaveLength(3);
  });

  it("spreads coverage across tickers via round-robin before the global cap", () => {
    // AAA has 5 very recent articles; BBB/CCC each have 1 older article.
    // With a limit of 3, round-robin must include BBB and CCC, not 3x AAA.
    const arts: NewsArticle[] = [
      ...Array.from({ length: 5 }, (_, i) =>
        article("AAA", `2026-06-${String(25 + i).padStart(2, "0")}T10:00:00Z`),
      ),
      article("BBB", "2026-06-01T10:00:00Z"),
      article("CCC", "2026-06-02T10:00:00Z"),
    ];
    const rows = rankPortfolioNews(arts, names, { limit: 3, perTickerCap: 4 });
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.ticker))).toEqual(new Set(["AAA", "BBB", "CCC"]));
  });

  it("orders the surviving rows newest-first and respects the global limit", () => {
    const arts: NewsArticle[] = [
      article("AAA", "2026-06-10T10:00:00Z"),
      article("BBB", "2026-06-29T10:00:00Z"),
      article("CCC", "2026-06-20T10:00:00Z"),
    ];
    const rows = rankPortfolioNews(arts, names, { limit: 2, perTickerCap: 4 });
    expect(rows).toHaveLength(2);
    expect(rows[0].publishedDate >= rows[1].publishedDate).toBe(true);
    expect(rows[0].ticker).toBe("BBB");
  });

  it("prioritizes a press release above a newer non-press-release article", () => {
    const arts: NewsArticle[] = [
      article("AAA", "2026-06-29T10:00:00Z"), // newest, but not a PR
      article("BBB", "2026-06-20T10:00:00Z", { isPressRelease: true }),
    ];
    const rows = rankPortfolioNews(arts, names, { limit: 5, perTickerCap: 4 });
    expect(rows[0].ticker).toBe("BBB");
    expect(rows[0].isPressRelease).toBe(true);
  });
});
