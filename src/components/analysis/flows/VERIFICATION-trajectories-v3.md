# Trajectories v3 — verification (LIVE)

Branch `feature/trajectories-v3` off `feature/funds-tab`. Verified against the local
populated DB (143 funds, 40 quarters 2016-Q2→2026-Q1) after a full
`npm run job:institutional -- --aggregate-only` rebuild. Gate: `npx tsc --noEmit`
+ `npx vitest run` (1148 tests). NOT `next build` (pre-existing lint debt).

Re-run the aggregate after pulling this branch so the DB reflects the new lifecycle
staging (WATCH + participation floor), corrected transitions, stage-exclusive core /
stasis, event-based base rates, and the expanded share-class merge.

## Part 0 — stasis-break (BLOCKING)
Root cause: the detector fired per-(fund,ticker) on ANY ≥10% trim/exit by a
tenure_mult≥1.5 holder, then OR-collapsed onto the name with "first change in Nq"
copy — permanently on for any widely-held name. All 3 raw-filing spot checks were
REAL ≥10% reductions (Soros −17.5% AMZN, Soros −10.2% GOOGL, Lone Pine exit MSFT
35q). Fix = name-level departure INTENSITY anomalous vs the name's own trailing-8q
baseline (z-score), gates severity≥2 / intensity≥15% / base≥3.
- **14,702 → 161 total events** (~4/qtr); core board **16/25 → 3/25** breaks.
- Residual core fires (MSFT/TSM/CPNG) confirmed real distribution in raw filings.

## Part 1 — cross-cutting
- 1a share-class: **1,306 folded + 432 renamed**; one Alphabet (GOOGL) + one
  Berkshire (BRK-B) row; value-coherent shares (Markel BRK-A+B → 3.2M B-equiv @ $479,
  matching the $1.53B position; naive sum understated ~2×). 11 new curated pairs.
- 1b price-since: was a ~3-yr window return mislabeled "since Q-end"; now period-end→
  latest close, adjClose. Max |since-Q-end| across durable cards 82% (real 3-mo move).
- 1c flags: shared flow-flags registry on durable cards / forming / spikes / core
  rows (20/25 core rows carry ≥1 flag).

## Part 2 — classifier (census before → after, latest quarter)
| stage | before | after |
|---|---|---|
| DURABLE | 16 (7 single-fund) | **9** (ex-mega chip; 11 raw − 2 mega) |
| WATCH | — | **10** (below-floor: AEVA/VAC/AURA/…) |
| FORMING | 131 (chip) vs 60 (section) | **132 chip == 132 section** |
- 2b exclusivity: **0** active-accumulation names also on core board or with stasis
  (AMZN=DURABLE only, NVDA=FORMING only, META=SPIKE only) — the d3 triple is gone.
- 2c ex-mega default (toggle to include, dimmed info). 2e BROKEN needs prior build
  ≥ broken_min_streak (tested).

## Part 3 — transitions
**9,452 → 1,985** total events; latest quarter 54 real changes, **junk = 0**
(no null-origin, same-state, →BROKEN-from-null, or CROWDED-as-transition).

## Part 4 — base rates (EVENT-based, 2Q, vs SP500)
| pattern | n (episodes) | fwd 2Q excess | hit |
|---|---|---|---|
| DURABLE | 169 | **+3.2%** | 47% |
| FORMING | 1962 | +2.8% | 48% |
| SPIKE | 1650 | +2.3% | 48% |
| BROKEN | 833 | +2.1% | 46% |
| stasis_break | 114 | **−5.6%** | 43% |
| CORE | 9 | insufficient | — |

**The d8 inversion is resolved**: DURABLE (+3.2%) now BEATS FORMING (+2.8%) — was
durable +0.9% < forming +2.6% under state-based cohorts. stasis_break is a clean
negative signal (−5.6%). Reported honestly per the spec.

## Part 5 — spikes
Bar = cohort bps (all-funds mean); label = per-adder bps (intensity) — never
conflated. DLTR cohort 38.6bps / per-adder 2394bps on 2 funds now reads honestly.
Magnitude-sorted lollipop, top spike_top_n=7, mega dimmed, tail collapsed
(+54 more · median +4.6 bps).

## Part 6 — visual sections (screenshots captured vs mockup target)
Funnel (proportional, QoQ deltas, STREAK-ENDED −9 green ✓, click-to-filter),
forming confirmation-runway scatter (streak age × slope, funds size, elite ring,
promotion zone, below-floor faint dots), spikes lollipop, adaptive transitions
(54 > strand_max 30 → clickable Sankey, no dead-end bands; strand form at ≤30),
core board with name-level stasis chips ("MDGL 2/3 cut · 4.1σ", "MSFT 13/22 cut ·
2.0σ"). One "N funds" vocabulary throughout.

## Config additions (aligned with existing objects)
- `LIFECYCLE_CONFIG.min_participants_stage = 3`
- `CORE_HOLDINGS_CONFIG`: `stasis_baseline_window 8`, `stasis_min_baseline_n 4`,
  `stasis_severity_min 2.0`, `stasis_min_departure_frac 0.15`, `stasis_min_base 3`,
  `stasis_unknown_skip true`, `stasis_unknown_max_frac 0.5`
- `SPIKE_TOP_N 7` (query svc), `STRAND_MAX 30` (TrajectoryVisuals)
- `default_cap_filter`: ex-mega default via the `cap` pipeline query param
