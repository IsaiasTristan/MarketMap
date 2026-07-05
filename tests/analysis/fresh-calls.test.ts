import { describe, expect, it } from "vitest";
import { isFreshCall, rankFreshCalls, type FreshCallRankInput } from "@/domain/calculations/fresh-calls";
import { FUNDS_ATTRIBUTION_CONFIG as CFG } from "@/domain/calculations/funds-attribution-config";

const mk = (over: Partial<FreshCallRankInput>): FreshCallRankInput => ({
  fundId: "F",
  ticker: "T",
  sector: null,
  strength: 1,
  status: "pending",
  followerFunds: 0,
  ageQuarters: 1,
  originatorFollowRate: 0.5,
  originatorRateSufficient: true,
  ...over,
});

describe("isFreshCall — expiry gate", () => {
  it("pending with zero followers is fresh", () => {
    expect(isFreshCall({ status: "pending", followerFunds: 0 })).toBe(true);
  });
  it("a pending call that gained a follower has expired (promoted)", () => {
    expect(isFreshCall({ status: "pending", followerFunds: 1 })).toBe(false);
  });
  it("a followed or aged-out (not_followed) call is not fresh", () => {
    expect(isFreshCall({ status: "followed", followerFunds: 3 })).toBe(false);
    expect(isFreshCall({ status: "not_followed", followerFunds: 0 })).toBe(false);
    expect(isFreshCall({ status: "consensus_at_birth", followerFunds: 0 })).toBe(false);
  });
});

describe("rankFreshCalls", () => {
  it("ranks by originator follow_rate × initiation_strength (sizing), desc", () => {
    const ranked = rankFreshCalls(
      [
        mk({ ticker: "A", originatorFollowRate: 0.5, strength: 2 }), // 1.0
        mk({ ticker: "B", originatorFollowRate: 0.6, strength: 1 }), // 0.6
        mk({ ticker: "C", originatorFollowRate: 0.4, strength: 4 }), // 1.6
      ],
      0.2,
      CFG,
    );
    expect(ranked.map((r) => r.ticker)).toEqual(["C", "A", "B"]);
    expect(ranked[0]!.rankScore).toBeCloseTo(1.6, 6);
  });

  it("low-n originators fall back to cohort_median × fresh_lown_discount and carry the flag", () => {
    const ranked = rankFreshCalls(
      [mk({ ticker: "L", originatorRateSufficient: false, originatorFollowRate: null, strength: 3 })],
      0.4, // cohort median
      CFG,
    );
    expect(ranked[0]!.lowN).toBe(true);
    expect(ranked[0]!.effectiveRate).toBeCloseTo(0.4 * CFG.fresh_lown_discount, 6); // 0.2
    expect(ranked[0]!.rankScore).toBeCloseTo(0.2 * 3, 6); // 0.6
  });

  it("drops expired (non-fresh) candidates from the feed", () => {
    const ranked = rankFreshCalls(
      [
        mk({ ticker: "FRESH" }),
        mk({ ticker: "PROMOTED", followerFunds: 2 }),
        mk({ ticker: "AGED", status: "not_followed" }),
      ],
      0.3,
      CFG,
    );
    expect(ranked.map((r) => r.ticker)).toEqual(["FRESH"]);
  });

  it("is deterministic regardless of input order", () => {
    const a = [mk({ ticker: "A", strength: 2 }), mk({ ticker: "B", strength: 1 }), mk({ ticker: "C", strength: 3 })];
    expect(rankFreshCalls(a, 0.2, CFG)).toEqual(rankFreshCalls([...a].reverse(), 0.2, CFG));
  });
});
