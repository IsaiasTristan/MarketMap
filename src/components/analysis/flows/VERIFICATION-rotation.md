# Rotation module v3 (calibration & completion) — verification & spec ledger

Environment world: local dev, Postgres `localhost:5432/marketmap` (40 signal-tier
quarters, 2016-06 → 2026-03), FMP ultimate key. Unit tests + typecheck green; the
[LIVE] items were run against this DB where noted.

## Automated (green)
- `npx vitest run` — full suite passes (incl. `institutional-active-flow`,
  `stock-rotation`, `security-class`, `flow-flags`, `flow-leaderboard` snapshot
  **unchanged** → the flags-store extraction is behavior-preserving).
- `npx tsc --noEmit` — clean.

## Part 0 — diffusion asymmetry diagnostic (BLOCKING) — DONE
`npx tsx scripts/rotation-diffusion-diagnostic.ts` (read-only; loops the existing
scoring core). Full-depth branch (≥12q). **Structural asymmetry CONFIRMED** — 11/12
quarters majority-red under the legacy flat floor; cross-sector vote sum strongly
negative while per-fund active weight is ~zero-sum. Part 1 executed. Re-run after
Part 1 (`--legacy` flag reproduces the before): **majority-red 11/12 → 6/12**,
cross-sector participation-weighted demeaned mean ≈ 0.0 every quarter. The board now
breathes (risk-on quarters go majority-green). Acceptance met.

## Part 1 — asymmetry fix — DONE (config-gated, ENABLED)
`demeaned_diffusion` + `fund_relative_floor` in `FLOW_LEADERBOARD_CONFIG` (both
`true`; flip either to A/B). 1a demeaning is a read-time transform (query service +
`attachSectorHistory`, so ghost ticks/percentiles compare like-with-like); 1b
fund-relative floor is in `computeActiveFlowPair` and takes effect after the
aggregate re-run.

## Part 2 — Unclassified-as-meter + label hygiene — CODE DONE; remap ACCEPTANCE-PENDING
- Unclassified is excluded from ranking, the demeaned mean, and percentile history,
  and renders last, dimmed, "unmapped securities — data gap". (query service +
  `RotationPanel`.)
- Label hygiene: `SUBSECTOR_ALIASES` folds the spec's named synonym `Minerals →
  Miners`; `canonicalSubsector` applied in `classifySecurity`. Single-parent
  invariant unit-tested.
- **[LIVE] data-quality findings (handoff — these are edits to the USER's curated
  market-map taxonomy, not applied unilaterally per the don't-repartition decision):**
  - **Unclassified = 11.6% of total |flow|** (625 names, ~$27.6B) at 2026-03-31 —
    above `unclassified_max_pct` (3%). The names are real companies OUTSIDE the
    curated universe (so `RevisionReference.sector` is null → Unclassified). Getting
    below 3% requires adding them to the market-map universe (or a Yahoo/FMP
    `Security.sector` fallback for null-sector names — a product decision). Top-25 by
    |flow| with suggested sectors: FI→Financials/Payments, BN→Financials/Asset Mgmt,
    ICLR→Healthcare/Life Sciences, MMC→Financials/Insurance, CYBR→Software/Cyber,
    AER→Industrials, CFLT/WIX/CDAY→Software, CNHI/ATS/HEI-A→Industrials,
    GIL→Consumer Cyclical/Apparel, CHYM→Financials/Fintech, EXAS + the biotech
    cluster (APLS/ASND/CNTA/GPCR/ACLX/DMRA/CDTX)→Healthcare/Biotech, TRMD→Energy/
    shipping, FBHS→Consumer Cyclical/Housing.
  - **Single-parent violation:** subsector **"Platforms"** appears under BOTH
    "Mega Cap" and "Software". Resolve upstream (rename one, or namespace by parent)
    — the board relies on one subsector = one parent sector.

## Part 3 — visible SCORE column — DONE
0–100 board-rescaled composite score on stock + subsector rows (`score`), decomposed
in the tooltip; sort indicator ("SCORE ▾") header. Sector view sorts by the DISPLAYED
(demeaned) diffusion, unrounded, tiebreak |net $| — fixes the −27/−26 apparent
inversion. Tests: rendered order ≡ visible score column; no view sorts by a hidden key.

## Part 4 — small-n discipline — DONE
Subsector participation floor (`min_participants_subsector` 5) with the same
shrunk-diffusion treatment; below-floor subsectors collapse into one dimmed,
expandable row. Drill-down names with n<3 render dimmed with vote counts
("1 add, 0 trims"), never a diffusion %, and never set the sort. Concentration flag
("N% of subsector $ is one name") fires above `drilldown_concentration_flag` (60%).
Tests: `dominantConcentration`, below-floor split, score ordering.

## Part 5 — shared flags store + defaults + polish — DONE
- **Canonical registry** `src/lib/institutional/flow-flags.ts`; both leaderboard and
  rotation render via the shared `FlagBadges` (flowsUi). Build-time assertion test
  guards that neither view re-inlines badges. Flags propagate to rotation stock +
  drill-down rows from shared sources: `verify-weights` / `partial-data` from the
  leaderboard core (`flagsByTicker`, whole universe incl. gated-out names) and
  `unresolved-split` from the split-detect `DataQualityEvent` holds. `tenure-verify`
  is defined in the registry but not yet sourced at name level (documented, like the
  quadrant view) — it's per-fund-holding, no name-level rollup exists.
- Default cap filter = `ex-mega` (config), user's choice persisted to localStorage.
- Divergence marker extracted to `diffusionDollarsDiverge` with a regression test
  (above floors ⇒ marker; below ⇒ none).

### [LIVE] — run against the local DB (current aggregates)
Verified end-to-end via a read-path harness (getRotation + getLeaderboard):
- **Sector board breathes** (2026-03-31): 7/15 real sectors positive after demeaning
  (Semis & AI +19% … Industrials −15%), NOT all-red; Unclassified renders last as a
  dimmed meter (excluded from the mean). ✓ (screenshot still wanted for the UI.)
- **Subsector**: 31 rows + a collapse row hiding 4 below-floor subsectors; SCORE
  column populated. ✓
- **Stock**: SCORE column populated (SUNB=100, AKAM=41, …). ✓
- **Cross-tab overlap**: stock top-15 ∩ leaderboard top-20 = **5** (SUNB, AVTR, ICLR,
  GIL, SPOT) — substantial, not near-zero. ✓
- **Flag propagation**: 18 names carry flags from the shared source (incl. THC =
  `unresolved-split`); they render wherever the name appears (search list here, since
  no flagged name is in the current top-30 board). ✓ Mechanism proven.
- **SUNB note:** the spec's "previously-quarantined SUNB, rank 1, unbadged" is a
  point-in-time condition — in the CURRENT data SUNB is a *legitimate* leaderboard
  top-20 accumulation name (it's in the cross-tab overlap), so there is nothing to
  quarantine/badge. A genuinely split-held or verify-flagged name that reaches the
  board WILL badge (mechanism confirmed via the 18 flagged names). Re-check the SUNB
  badge only if a future quarter re-quarantines it.

### Still wants a human at the screen
- UI screenshots of the sector board (breathing + dimmed Unclassified), stock view
  (SCORE column + previously-"misordered" examples now score-ordered), subsector
  collapse-row expand, and a flagged name's glyph + tooltip matching the leaderboard.

### NOTE — Part 1b stored refresh
Demeaning (1a) makes the board breathe at READ time (works now). The fund-relative
floor (1b) changes STORED `fundsIn/Out`, so its effect on the live board lands only
after `npm run job:institutional -- --aggregate-only` (a full 40-quarter rebuild;
the attempt during this build was killed by the environment before completing —
re-run it when convenient). 1b's effect is already proven by the Part 0 harness
(which recomputes from raw holdings): majority-red 11/12 → 6/12.

## OPEN (deferred, tracked so it survives)
- **FundLink adoption + audit (rotation Part 5)** — DEFERRED to its owning spec
  (`fund_overview_module_spec` Part 5). `FundLink` now exists
  (`flows/funds/FundLink.tsx`), but rotation drill-downs name STOCKS, not funds
  (they route ticker→ledger), so there is no fund-name surface on this view to route
  through FundLink today. Re-audit when/if rotation surfaces fund names.
- **Unclassified remap to < 3%** — see Part 2 handoff above (user-taxonomy edit).
