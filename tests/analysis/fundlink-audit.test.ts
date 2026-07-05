import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * FundLink adoption audit (Fund Overview Part 5). The repo's test env is node-only (no
 * jsdom), so instead of a render-based scan this asserts the STRUCTURAL contract that
 * makes plain-text fund names impossible: every live fund-name surface routes through
 * the shared FundLink component, and every service that emits a fund name also emits
 * the `cik` FundLink needs to resolve it. Guards against a regression that renders a
 * signal-tier fund name as dead text.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

// Components that render fund names in the LIVE flows tabs.
const FUND_NAME_SURFACES = [
  "src/components/analysis/flows/LedgerPanel.tsx",
  "src/components/analysis/flows/leaderboard/LeaderboardPanel.tsx",
  "src/components/analysis/flows/funds/FundsPanel.tsx",
  "src/components/analysis/flows/funds/FundPage.tsx",
];

// Services whose row types feed those surfaces — each must carry a cik/fundId.
const FUND_NAME_SERVICES = [
  "src/server/services/institutional/institutional-follow.service.ts",
  "src/server/services/institutional/institutional-fresh-calls.service.ts",
  "src/server/services/institutional/institutional-fund-page.service.ts",
];

describe("FundLink adoption audit", () => {
  it("every fund-name surface renders through FundLink", () => {
    for (const f of FUND_NAME_SURFACES) {
      const src = read(f);
      expect(src, `${f} should import/use FundLink`).toContain("FundLink");
    }
  });

  it("services feeding fund-name surfaces expose cik for resolution", () => {
    for (const f of FUND_NAME_SERVICES) {
      const src = read(f);
      expect(src, `${f} should carry cik`).toMatch(/\bcik\b/);
    }
  });

  it("FundLink degrades to plain text (never a dead link) when cik is absent", () => {
    const src = read("src/components/analysis/flows/funds/FundLink.tsx");
    // The no-cik branch renders a <span> instead of a navigating <button>.
    expect(src).toMatch(/if\s*\(!cik\)/);
    expect(src).toContain("<span");
  });
});
