import { describe, expect, it } from "vitest";
import {
  computeFollowAttribution,
  type Initiation,
  type FollowerVote,
} from "@/domain/calculations/follow-attribution";
import { FUNDS_ATTRIBUTION_CONFIG as CFG } from "@/domain/calculations/funds-attribution-config";

// Qualified ORIGINATOR (full initiation bar, gated upstream).
const orig = (fundId: string, ticker: string, quarter: number, extra: Partial<Initiation> = {}): Initiation => ({
  fundId,
  ticker,
  quarter,
  strength: 1,
  sector: null,
  ...extra,
});
// FOLLOW VOTE: any signal NEW position; entryBps default well above the floor.
const vote = (fundId: string, ticker: string, quarter: number, entryBps = 100, extra: Partial<FollowerVote> = {}): FollowerVote => ({
  fundId,
  ticker,
  quarter,
  entryBps,
  ...extra,
});

const outcome = (r: ReturnType<typeof computeFollowAttribution>, fundId: string, ticker: string, quarter: number) =>
  r.outcomes.find((o) => o.fundId === fundId && o.ticker === ticker && o.quarter === quarter)!;
const fund = (r: ReturnType<typeof computeFollowAttribution>, fundId: string) => r.funds.find((f) => f.fundId === fundId);

describe("computeFollowAttribution — episode classification", () => {
  it("follow votes inside the window => followed with correct lead; at window+1 => not followed", () => {
    const inside = computeFollowAttribution(
      [orig("F0", "T", 0)],
      [vote("F1", "T", 1), vote("F2", "T", 2), vote("F3", "T", 3)],
      CFG,
      3,
    );
    const o = outcome(inside, "F0", "T", 0);
    expect(o.status).toBe("followed");
    expect(o.followerFunds).toBe(3);
    expect(o.lead).toBe(1);

    const outside = computeFollowAttribution(
      [orig("F0", "T", 0)],
      [vote("F1", "T", 4), vote("F2", "T", 4), vote("F3", "T", 4)],
      CFG,
      4,
    );
    expect(outcome(outside, "F0", "T", 0).status).toBe("not_followed");
    expect(outcome(outside, "F0", "T", 0).followerFunds).toBe(0);
  });

  it("co-origination: 2 same-quarter originators both credited once; a q0 co-originator is never a follower", () => {
    // F0 & F1 co-originate at q0=0 (also present in the vote pool at q0) → neither counts as the other's follower.
    const r = computeFollowAttribution(
      [orig("F0", "T", 0), orig("F1", "T", 0)],
      [vote("F0", "T", 0), vote("F1", "T", 0), vote("F2", "T", 1), vote("F3", "T", 2), vote("F4", "T", 3)],
      CFG,
      3,
    );
    expect(outcome(r, "F0", "T", 0).status).toBe("followed");
    expect(outcome(r, "F1", "T", 0).status).toBe("followed");
    expect(outcome(r, "F0", "T", 0).followerFunds).toBe(3); // {F2,F3,F4}, not the co-originator
    expect(fund(r, "F0")!.n).toBe(1);
    expect(fund(r, "F1")!.n).toBe(1);
  });

  it("consensus-at-birth keys off ORIGINATOR qualification (4 qualified at q0) => excluded from all rates", () => {
    const r = computeFollowAttribution(
      [orig("F0", "T", 0), orig("F1", "T", 0), orig("F2", "T", 0), orig("F3", "T", 0)],
      [vote("F5", "T", 2)],
      CFG,
      5,
    );
    for (const f of ["F0", "F1", "F2", "F3"]) {
      expect(outcome(r, f, "T", 0).status).toBe("consensus_at_birth");
      expect(fund(r, f)!.n).toBe(0);
      expect(fund(r, f)!.followRate).toBeNull();
    }
  });

  it("pending: an initiation younger than the window is neither followed nor unfollowed", () => {
    const r = computeFollowAttribution([orig("F0", "T", 2)], [], CFG, 3);
    const o = outcome(r, "F0", "T", 2);
    expect(o.status).toBe("pending");
    expect(fund(r, "F0")!.n).toBe(0);
    expect(fund(r, "F0")!.followRate).toBeNull();
  });

  it("no-lookahead: a late-filed follow vote is invisible as-of an earlier quarter, changing the outcome", () => {
    const origs = [orig("F0", "T", 0)];
    const votes = [vote("F1", "T", 1), vote("F2", "T", 2), vote("F3", "T", 3, 100, { availableQuarter: 5 })];
    expect(outcome(computeFollowAttribution(origs, votes, CFG, 3), "F0", "T", 0).status).toBe("not_followed");
    expect(outcome(computeFollowAttribution(origs, votes, CFG, 3), "F0", "T", 0).followerFunds).toBe(2);
    expect(outcome(computeFollowAttribution(origs, votes, CFG, 5), "F0", "T", 0).status).toBe("followed");
    expect(outcome(computeFollowAttribution(origs, votes, CFG, 5), "F0", "T", 0).followerFunds).toBe(3);
  });

  it("is deterministic — repeated runs are equal regardless of input order", () => {
    const o = [orig("F0", "T", 0)];
    const v = [vote("F3", "T", 3), vote("F1", "T", 1), vote("F2", "T", 2)];
    expect(computeFollowAttribution(o, v, CFG, 3)).toEqual(computeFollowAttribution([...o], [...v].reverse(), CFG, 3));
  });
});

describe("computeFollowAttribution — asymmetric follower materiality floor", () => {
  it("a modest starter position (30bps, ~0.3x the follower's own typical size) counts as a follow vote", () => {
    // 30bps clears follow_min_bps (25); the sizing multiple is irrelevant to the vote.
    const r = computeFollowAttribution(
      [orig("F0", "T", 0)],
      [vote("F1", "T", 1, 30), vote("F2", "T", 2, 30), vote("F3", "T", 3, 30)],
      CFG,
      3,
    );
    expect(outcome(r, "F0", "T", 0).status).toBe("followed");
    expect(outcome(r, "F0", "T", 0).followerFunds).toBe(3);
  });

  it("a sub-floor dust NEW position (5bps) does NOT count as a follow vote", () => {
    const r = computeFollowAttribution(
      [orig("F0", "T", 0)],
      [vote("F1", "T", 1, 30), vote("F2", "T", 2, 30), vote("F3", "T", 3, 5)],
      CFG,
      3,
    );
    expect(outcome(r, "F0", "T", 0).followerFunds).toBe(2); // dust dropped
    expect(outcome(r, "F0", "T", 0).status).toBe("not_followed");
  });

  it("a 30bps / 0.4x-sizing entry is a valid follow vote but not a qualified originator", () => {
    // Fx enters at 30bps but only 0.4x its median → the loader would NOT emit it as an
    // originator (fails the sizing bar), yet it is a legitimate follow vote here.
    const r = computeFollowAttribution(
      [orig("F0", "T", 0)],
      [vote("F1", "T", 1, 30), vote("F2", "T", 2, 30), vote("Fx", "T", 3, 30)],
      CFG,
      3,
    );
    expect(outcome(r, "F0", "T", 0).status).toBe("followed");
    expect(outcome(r, "F0", "T", 0).followerFunds).toBe(3);
    // Fx never appears as an originator outcome — it is only a follower.
    expect(r.outcomes.find((o) => o.fundId === "Fx")).toBeUndefined();
  });
});

describe("computeFollowAttribution — per-fund aggregates", () => {
  it("best sector picks the fund's highest resolved follow rate above sector_min_n", () => {
    const origs: Initiation[] = [];
    const votes: FollowerVote[] = [];
    for (let k = 0; k < 5; k++) {
      const t = `H${k}`;
      origs.push(orig("F0", t, 0, { sector: "healthcare" }));
      votes.push(vote(`Ha${k}`, t, 1), vote(`Hb${k}`, t, 2), vote(`Hc${k}`, t, 3));
    }
    for (let k = 0; k < 5; k++) origs.push(orig("F0", `X${k}`, 0, { sector: "tech" }));
    const r = computeFollowAttribution(origs, votes, CFG, 4);
    const f = fund(r, "F0")!;
    expect(f.bestSector).toBe("healthcare");
    expect(f.bestSectorRate).toBe(1);
    expect(f.n).toBe(10);
    expect(f.rateSufficient).toBe(true);
    expect(f.followRate).toBe(0.5);
  });

  it("rate is insufficient (dims) below min_n_for_rate but still reports n", () => {
    const r = computeFollowAttribution(
      [orig("F0", "A", 0)],
      [vote("F1", "A", 1), vote("F2", "A", 2), vote("F3", "A", 3)],
      CFG,
      4,
    );
    const f = fund(r, "F0")!;
    expect(f.n).toBe(1);
    expect(f.rateSufficient).toBe(false);
    expect(f.followRate).toBe(1);
  });

  it("averages forward returns and computes the 2Q hit rate over the fund's entries", () => {
    const r = computeFollowAttribution(
      [orig("F0", "A", 0, { fwd1q: 0.05, fwd2q: 0.1 }), orig("F0", "B", 0, { fwd1q: -0.02, fwd2q: -0.04 })],
      [],
      CFG,
      4,
    );
    const f = fund(r, "F0")!;
    expect(f.fwd2q).toBeCloseTo(0.03, 6);
    expect(f.hitRate2q).toBe(0.5);
  });
});
