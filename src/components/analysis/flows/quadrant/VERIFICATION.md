# Crowding × Conviction scatter — interaction & takeaway layer: verification handoff

Built with no live DB in the environment. Unit tests + typecheck + `next build`
all pass; the items below need a live quarter of 13F data to accept. Load
**Flows → Crowding × Conviction** and confirm.

## Automated (already green)
- `npx vitest run tests/analysis/` — 625 tests incl. the quadrant suites:
  `quadrant-gutter`, `quadrant-spatial-index`, `quadrant-inspector`,
  `quadrant-zoom`, `quadrant-takeaways`, plus the existing
  `quadrant-label-placement` / `quadrant-streak` (unchanged behavior).
- `npx tsc --noEmit` — clean. `npx next build` — `/flows` compiles.
- `spatialIndex.nearest ≡ brute-force` property test guarantees hover parity.
- `placeLabels` regression: identical output when all `priority === 0`.

## [LIVE] ACCEPTANCE-PENDING — needs a live quarter
1. **Gutter (Part 0):** confirm no marks sit on the axis-floor row; below-0.3%
   names sit in the strip captioned "< 0.3% of book".
2. **Alt-hover (Part 1):** hold Alt → context marks brighten, cursor crosshair,
   minimal tooltip on hover; release → inert.
3. **Box-select (Part 2):** drag empty space → right rail lists the exact set
   (gutter names tagged "below range"); CSV export; click pins a label; Esc clears.
4. **Zoom (Part 3):** Shift+drag animates to the region; breadcrumb + reset;
   double-click empty / Esc resets; Space+drag pans when zoomed; ≤150ms re-render
   at ~400 points.
   - **conviction-before-the-crowd list:** zoom into the emerging-conviction zone
     and report how many static names promote + paste the top 10. This list's
     quality is the feature's justification.
5. **Takeaways (Part 4):** census chip counts reconcile to the foreground per
   zone; regime-vector direction matches eyeballed drift; portfolio rings render;
   flag glyphs (verify/partial) appear and match the Leaderboard tab.
   - **danger-vector overlap:** compare the "elite leaving crowded" / "moving into
     crowding" top-5 against this quarter's BROKEN/CROWDED trajectory transitions.
     Substantial overlap expected; **zero overlap ⇒ stop and report** (one of the
     two computations is wrong).

## Interpretation notes / deviations from the spec
- **Watchlist (4c) = active-portfolio holdings** (per decision). No active
  portfolio → no rings; the census watchlist chip hides.
- **Flags (4d):** only `verifyData` / `partialData` are propagated, sourced from
  the same `getLeaderboard()` rows the Leaderboard tab renders (parity is
  compile-time enforced — the join reads `EnrichedRow.verifyData/partialData`).
  `tenure-verify` does not exist and `unresolved_split` is not on the shared
  leaderboard rows, so both are out of scope.
- **`min_trail_quarters` (4b):** the quadrant payload carries only a single prior
  quarter (`prev`), so the multi-quarter "trail length" floor is applied via
  `|holderStreak| ≥ min_trail_quarters` (sustained-direction proxy). Trails/vectors
  are single-segment (prev→current) in normalized log-space.
- **"Elite" trims (4b):** `getExitClusters` was extended with `eliteExits` /
  `eliteSizing` (most-respected funds only), so the "elite leaving crowded" list is
  precise, not a high-conviction proxy.
- **Perf:** the spatial index rebuilds each frame during the ≤240ms zoom tween but
  hover is disabled and labels hidden mid-tween; grid-bucket build is O(n) on ≤400
  points, comfortably within budget (SVG retained, no canvas).
