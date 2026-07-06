# Research, Fundamentals & Flows — Agent Reference

> Purpose: give an AI agent a dense, navigable map of what these three analysis tabs do, the
> data they consume, and how the underlying pipeline/algorithms work. Every section is concrete
> about route paths, service names, and Prisma models so you can jump straight into the code.

These three tabs are the app's three **"engines"**, all built on a shared curated universe and
shared scoring primitives (`@/lib/revision/scoring`: `winsorize`, `zScores`, `rankAndDecile`):

| Tab | Engine | Question it answers | Source data |
|---|---|---|---|
| **Research** | Engine 1 — Analyst Revision Detector | Where are analysts changing their minds (estimates/ratings/PTs) before price reflects it? | FMP analyst estimates, grades, price targets |
| **Fundamentals** | Engine 2 — Fundamental-Inflection Discovery | Where is the *business* inflecting (margins, growth, ROIC, leverage) before the sell-side reacts? | FMP financial statements, ratios, key metrics |
| **Flows** | Engine 3 — Institutional Capital Flow | Where is institutional smart money accumulating/distributing and rotating? | FMP 13F filings of a curated fund watchlist |

Common patterns across all three:
- **Thin page → client router.** `src/app/(analysis)/<tab>/page.tsx` is a `Suspense` wrapper around a
  `*Client.tsx` that owns a `BloombergTabStrip` and switches sub-panels on a `tab` URL param.
- **Precompute-then-read.** A weekly/quarterly job writes fully-baked payloads to Prisma; GET routes are
  thin read wrappers. A few views recompute live on read (noted below).
- **react-query hooks** (`useRevision` / `useFlows`, and a direct fetch in Fundamentals) with a 404→empty
  convention so panels show "accruing/insufficient data" placeholders instead of errors.
- **Peer-relative scoring**: z-scores within subsector (sector fallback), `MIN_PEERS`/`MIN_VALID_BOXES` gates.
- **Deep-linkable**: `?tab=`, plus `?ticker=`/`?fund=`/`?group=` cross-links between engines.

---

## 1. RESEARCH tab — Engine 1: Analyst Revision Detector

**Entry:** `src/components/analysis/research/ResearchClient.tsx`
**Tagline:** *"where analysts are changing their minds, before price reflects it. Decision queue, not a trader."*

Central idea = the **gap score** = `composite4wZ − px4wZ` (revision momentum minus realized peer-relative
price move). Positive gap = bullish revisions the price hasn't matched → potential long; negative = short.
It surfaces freshly-inflecting names ("new arrivals"), validates the signal is predictive (IC/backtest), and
decomposes moves into group (sector) vs idiosyncratic drivers.

### Sub-tabs / panels
All fetch via `useRevision<T>()` (`useRevision.ts`, 5-min staleTime, 404 NO_DATA → empty).

| Tab (key) | Component | API | Shows |
|---|---|---|---|
| **Summary** (default) | `SummaryPanel.tsx` | `GET /research/summary` | Delta triage — only transitions since last snapshot, grouped NEW IDEAS / EXITS & DEGRADING / CATALYSTS ≤7D / GROUP TRIGGERS + header StatStrip (IC health, breadth, actionable longs/shorts). |
| **Idea Queue** | `IdeaQueuePanel.tsx` + `DivergenceScatter.tsx` | `GET /research/queue` | The "Master Rank". Scatter: x=4w revision-composite z, y=4w peer-relative price z; distance from diagonal = gap; bottom-right = unpriced upgrades → LONG. Table sorted by \|gap\|. |
| **Rating Changes** | `RatingChanges.tsx` | `GET /research/events?limit=500` | Raw daily feed of analyst up/downgrades (`RatingEvent`) + PT revisions (`PriceTargetEvent`), each annotated with whether it's currently in the queue. |
| **Validation** | `ValidationPanel.tsx` | `GET /research/validation` | "Is the signal working?" — forward-return-by-decile bars, rolling IC, per-signal IC attribution, regime, post-flag drift. Labeled FULL vs LEG-B-ONLY window. |
| **Calendar** | `CalendarPanel.tsx` | `GET /research/calendar?days=21` | Names reporting in ~3 weeks that have a live revision signal, grouped by week; "REV Z IN" = proximity-weighted composite into the print. |
| **Decomp** | `DecompPanel.tsx` | `GET /research/decomp?groupType=SECTOR\|SUBSECTOR` | Splits each name's universe-relative composite into group (`groupZ`) + idiosyncratic residual (`idioZ`) that sum exactly; rule-generated implication label. **Recomputed live on read.** |
| **Revision Trajectory** (drill) | `RevisionTrajectory.tsx` | `GET /research/trajectory?ticker=` | Per-stock time series of composite/rank/decile/signals across weeks — climb vs spike vs round-trip. |
| **Rotation Flow** (drill) | `RotationFlow.tsx` | `GET /research/rotation?groupType=&weeks=52` | Sector/subsector composite-mean lines — which groups are inflecting/rolling over. |
| **Breadth Heatmap** (drill) | `BreadthHeatmap.tsx` | `GET /research/heatmap?...` | Groups × dates heatmap of estimate breadth. |

Shared UI in `researchUi.tsx` (chips, StatStrip, GroupIdioBar, heat helpers); tooltips from a metric
registry (`MetricTip.tsx`), never inline copy; deep links via `GotoLink.tsx`.

### Data & pipeline
**Source:** FMP via `@/infrastructure/providers/fmp` (`fetchAnalystEstimates`, `fetchGradesConsensus`,
`fetchPriceTargetConsensus`, `fetchGradeEvents`, `fetchPriceTargetNews`). Universe from the saved MarketMap
universe (default) or an FMP screener.

**Ingest:** `POST /research/ingest` (admin, maxDuration 800) → `runRevisionPipeline()`. Prefer the CLI
`npm run job:revision` (`scripts/revision-weekly.ts`). Steps (each try/caught): build universe
(`RevisionReference`) → next-earnings proximity → **Leg B** consensus + **Leg A** estimates → merge/upsert
one `RevisionSnapshot` per (ticker, date) → optional event backfill (`RatingEvent`/`PriceTargetEvent`) →
weekly price capture (`RevisionPriceSnapshot`) → point-in-time Leg-B weekly (`RevisionLegBWeekly`) →
scoring + transitions → validation cache.

**Two "legs":** *Leg A* = forward estimate consensus (rev/EPS/EBITDA/…); FMP only gives *current*
consensus, so the weekly snapshot store **is** Leg A's history (sparse at launch). *Leg B* = ratings + price
targets; events carry full backfilled history, so `legb-history.ts` reconstructs a point-in-time weekly
series — this gives streaks + validation real depth "from day one".

**Precomputed:** summary, queue, validation, rotation, heatmap, calendar (read baked payloads).
**Live on read:** decomp (re-runs `decomposeComposites` at the requested groupType), plus company display
names overlaid from `Security.name`. All reads via `revision-query.service.ts`.

### Key algorithms (pure math in `src/lib/revision/`, thresholds in `config.ts`)
- **Signals** (`signals.ts`): WoW relative changes of EPS avg, revenue avg, estimate breadth `(up−down)/total`,
  rating net + momentum, PT revision; EPS dispersion. Near-earnings revisions amplified ≤2× by `proximityWeight`.
- **Scoring** (`scoring.ts`): winsorize (2% tails) → peer-relative z (subsector if ≥8 names, else sector) →
  composite (equal-weighted mean of signal z's) → `rankAndDecile` (10 = strongest) → `isNewArrival`
  (entered top decile this week = the change-detector flag). Also a universe-relative "global composite".
- **Gap score**: `composite4wZ − px4wZ` where "4w" = 4 grid steps (irregular snapshot cadence, not 28 days).
- **Transitions/state machine** (`transitions.ts`): sticky side with hysteresis — entry needs extreme
  decile AND \|gap\| ≥ 1.5; exit only when \|gap\| < 0.5. Emits NEW_LONG/NEW_SHORT, GAP_CLOSED, STREAK_BROKEN,
  GROUP_INFLECTION/ROLLOVER, NEXT_DOMINO (group hot but member lagging), ER_WITHIN_7D.
- **Validation/backtest** (`backtest.ts`): Information Coefficient = correlation of (signal, forward
  peer-relative return); decile forward stats, rolling IC, post-flag drift. FULL (5-signal) vs LEG_B
  (2-signal, full history) variants.

### Prisma models
`RevisionReference` (universe/taxonomy) · `RevisionSnapshot` (weekly Leg A+B consensus; unique ticker+date) ·
`RatingEvent` / `PriceTargetEvent` (Leg B event history) · `RevisionSectorAggregate` (rotation/heatmap
inputs) · `RevisionScore` (composite, deciles, rank, gapScore, groupZ/idioZ, streak, side) ·
`ResearchQueueSnapshot` (baked queue payload) · `RevisionPriceSnapshot` · `RevisionLegBWeekly` ·
`SignalTransition` (powers Summary) · `RevisionAnalyticsSnapshot` (validation cache).
Enums: `RevisionGroupType`, `RevisionTransitionType`.

---

## 2. FUNDAMENTALS tab — Engine 2: Fundamental-Inflection Discovery

**Entry:** `src/components/analysis/fundamentals/FundamentalsClient.tsx` — tabs `rank | diligence | financials`,
holds shared `selectedTicker`, eagerly fetches `/fundamentals/discovery?limit=3000` (staleTime 5 min).

Philosophy: **inflection detection** (2nd-derivative / recent-vs-prior-slope reads — fires when a trend
*turns*), **quality filters that kill traps** (accruals/cash-conversion/balance-sheet/dilution), **peer-relative**,
**deterministic & auditable** (same inputs + `SCORE_METHODOLOGY_VERSION` = `discovery_9_box_v1.0` → same scores),
**precomputed**.

### Sub-tabs / panels
| Tab | Component | API | Shows |
|---|---|---|---|
| **Discovery Rank** | `DiscoveryRankTable.tsx` | `GET /fundamentals/discovery` → `getDiscoveryQueue` | Dense ranked grid: rank, ticker (NEW/TRAP badges), return heat cells (1D–1Y, enriched from market-map grid), sector/subsector, **Composite**, **Decile**, one column per box (z-bar + 8q sparkline). Click a box → break out its components. "Exclude metric" recomputes composite/decile/rank **client-side** (`discovery-exclude.ts`). |
| **Diligence** | `DiligencePanel.tsx` | `GET /fundamentals/diligence?ticker=` → `getDiligence` | Metric tiles + TTM margin-trajectory chart + **Box Breakdown** (composite, valid-box count x/9, every box's score + each component's raw value & peer z) + valuation table (each multiple's own-5yr percentile). The full auditable "why" for one name. |
| **Financials** | `FinancialsTable.tsx` | `GET /fundamentals/financials?ticker=&basis=annual\|quarter` → `getFinancials` | Bloomberg-style FA statement: Income/Per-Share/EV-bridge/Valuation/Return blocks, actuals + LTM + forward **Consensus Estimate** columns (from `RevisionSnapshot.estimatesJson`). |
| **Ingest** (admin) | — | `POST /fundamentals/ingest` | Runs `runFundamentalWeekly` then `scoreFundamentalBoxesWeek`. CLI mirror: `npm run job:fundamental`. |

### The "boxes" framework (single source: `src/lib/fundamental/boxes.ts`)
V1 = **9 boxes**, each 1–6 components (all oriented higher = better):
`inflection` · `surprise` · `residualMomentum` · `cashQuality` · `persistence` · `balanceSheet` ·
`valuation` (cross-sectional) · `forecastConfidence` · `dilution` (inverted).

**Scoring** (`box-scoring.ts`, pure): Level 1 — each `${box}.${component}` winsorized + z-scored within
peer bucket; box score = mean of available component z's. Level 2 — **composite = mean of box scores, null
unless ≥ `MIN_VALID_BOXES` (8)**. Emits full `BoxAudit[]` + `componentZ` so any score reconstructs.
Component wiring is `box-inputs.ts` (`buildBoxComponents`, pure).

### Key per-box metrics
- **inflection** (`inflection.ts`): `inflectionScore` = recent-window slope − prior-window slope; `accelerationScore`
  = slope of the growth-rate series (2nd derivative); deleveraging = −trend(netDebt/EBITDA). TTM-smoothed inputs.
- **valuation** — two distinct: cross-sectional box (`valuation-box.ts`, z vs peers) vs intra-ticker own-history
  cheapness (`valuation.ts`, `percentileOf` current multiple in its own ~5yr history).
- **quality** (`quality.ts`): Sloan accruals ratio `(NI−OCF)/avgAssets`, accruals divergence (NI outrunning cash),
  trapFlag, compounder (mean ROIC × consistency).
- **surprise** (`surprise.ts`): `(actual−expected)/max(|expected|,floor)`, latest + trailing-4Q, for EPS & revenue.
- **cashQuality** (`cash-quality.ts`): FCF conversion, accrual quality, working-capital quality.
- **persistence** (`persistence.ts`): fraction of last 3 quarterly transitions across 6 core metrics that improved.
- **balanceSheet** (`balance-sheet.ts`): net-leverage quality, interest coverage (capped), cash runway.
- **dilution** (`dilution.ts`): share growth / 2y CAGR / net issuance / SBC — all inverted.
- **forecastConfidence** (`forecast-confidence.ts`): dispersion (inverted), coverage, consensus stability.
- **residualMomentum** (`residual-momentum.ts`): 6-1m window return minus equal-weight subsector benchmark.
- **flags** (`flags.ts`): 14 display-only trap/data-quality flags — **never alter the composite in V1**.

### Data & pipeline (two-stage weekly job)
**Stage 1 ingest** `runFundamentalWeekly`: universe = Engine 1's `loadActiveUniverseTickers()`; per ticker via
`fmpPool` → FMP statements/ratios/keyMetrics/quote. Derived at storage boundary (EBITDA = opInc + D&A; FCF =
OCF + capex). Writes **write-once** `FundamentalPeriod` (restatements → `AuditLog`), `EarningsSurprise`, and one
`FundamentalSnapshot` per (ticker, date). Backfill ≈ 36 quarters; routine = 12.
**Stage 2 scoring** `scoreFundamentalBoxesWeek`: bulk-loads only (no per-ticker FMP), builds `MetricSeries` →
`BoxInputBundle` → `buildBoxComponents` → `computeBoxScores`; peer groups subsector-first; **point-in-time box-z
history** (re-runs scorer at last 8 quarter-ends for sparklines); writes `FundamentalScore`,
`FundamentalSectorAggregate`, and the master `DiscoveryQueueSnapshot` (the UI's ranked payload).

**Precomputed:** Discovery Rank (single cached snapshot, enriched with market-map returns + live names at read).
**On demand:** Diligence & Financials read per-ticker stored rows. "Exclude metric" is client-side only.

### Prisma models
`FundamentalPeriod` (write-once statement spine) · `FundamentalSnapshot` (TTM + multiples + trailing series) ·
`FundamentalScore` (composite/deciles/rank + full `scoreJson` audit + methodology version) ·
`FundamentalSectorAggregate` · `DiscoveryQueueSnapshot` (master ranked payload) · `EarningsSurprise`.
Cross-engine reads: `RevisionReference`, `RevisionSnapshot.estimatesJson`, `Security` + `PriceHistory`, market-map cache.

---

## 3. FLOWS tab — Engine 3: Institutional Capital Flow (13F)

**Entry:** `src/components/analysis/flows/FlowsClient.tsx` — tabs
`overview | leaderboard | quadrant | trajectories | rotation | funds | watchlist`. Header: period selector,
tracked-funds count, fund search (Cmd/Ctrl+K → `FundSearchPalette`), admin ↻ Refresh 13F. URL params `?tab=`,
`?fund=<cik>` reactive. Data via `useFlows.ts` (15-min staleTime, 404→empty). Clicking a ticker opens inline
`LedgerPanel`; clicking a fund → `?tab=funds&fund=<cik>`.

Framed as a **lagging confirmation signal** (13F lags ~45 days, quarterly) — every view stamped with the
filing as-of date (`AsOfBanner`). Philosophy: raw quantities & positional encodings, no blended scores —
except two deliberate "ranking IS the product" boards (Leaderboard, Rotation).

### Sub-tabs / panels
| Panel | API | Shows |
|---|---|---|
| **OverviewPanel** | `GET /flows/overview` → `getOverview` | Quarter-at-a-glance change-detector tiles (new accumulation/distribution, crowding alerts, small/mid-cap share), broadest rotation in/out, top new-accumulation list with bought-vs-sold split. |
| **leaderboard/LeaderboardPanel** | `GET /flows/leaderboard` → `institutional-leaderboard.service` | Ranked accumulation heatmap (row order = ranking): rank, ticker+streak+flags, 5-quarter heat cells, ACC sparkline, price-since, elite-adder chip, score bar (hover → factor decomposition). Distribution Watch board sorts by churn severity vs own baseline. Chevron expands `LedgerPanel`. |
| **quadrant/QuadrantPanel** | `GET /flows/quadrant?minFunds=2` → `getCrowdingColumn`/`getQuadrant` | SVG scatter: x = breadth (% funds holding), y = conviction (median % of book), log scales. Color = flow direction; marker area = \|Δholders\|. Danger corner (p75×p75, distributing). Trails, box-select `RegionInspector`, `DangerRail`, watchlist rings. Model in `quadrant/quadrantModel.ts`. |
| **TrajectoryPipelinePanel** + `TrajectoryVisuals` | `GET /flows/pipeline?cap=` → `getTrajectoryPipeline` | Lifecycle funnel SPIKE→FORMING→DURABLE→CORE→STREAK-ENDED. Durable builds = evidence cards; Forming = confirmation-runway scatter; Spikes = magnitude lollipop; Transitions = strand/Sankey. Embeds `CoreHoldingsPanel`. Base-rate lines on headers. |
| **CoreHoldingsPanel** | `GET /flows/core-holdings` → `getCoreHoldings` | Long-held, high-conviction, zero-flow names other views gate out. 12-quarter weight-stability strip, stasis-break alerts. |
| **RotationPanel** | `GET /flows/rotation?groupBy=&within=` → `getRotation` | Price-adjusted equal-weighted active rotation by SECTOR/SUBSECTOR/STOCK; cap filter (ALL/EX-MEGA/MEGA); diverging bars = shrunk net-diffusion, 0–100 SCORE, ghost tick, divergence marker. Sector rows expand → top-5 accumulated/distributed. |
| **funds/FundsPanel** (+ FundPage, FundSearchPalette) | `funds-scoreboard`, `fresh-calls`, `fund-page/[cik]`, `fund-search-index` | Signal provenance: Originator Scoreboard (follow rate, median lead, fwd 2Q, exit-lead rate), Fresh Calls (qualified entries with zero followers yet), FundPage (returns, book, style-over-time, outcomes). |
| **WatchlistPanel** | `GET/POST /flows/funds`, `PATCH/DELETE /flows/funds/[id]` | Curated fund watchlist editor (active / most-respected / category, add/remove by CIK). |
| **LedgerPanel** | `GET /flows/ledger?ticker=` → `getLedger` | Single-name roster: every tracked fund holding it, action pill (NEW/ADDED/HELD/TRIMMED/EXITED), position $M, % of book, sizing×. CSV export. |

### Data & pipeline
**Source:** FMP 13F via `providers/fmp/institutional.ts` (`fetchFundHoldings`, `fetchFundBookHistory`,
`fetchMarketCapsBatch`) through `fmpPool` (concurrency 4).
**Universe:** `InstitutionalFund` table (curated, editable). Each fund has a **`tier`** — `signalFundFilter()`
is the **single source of truth for the flow denominator**; context-tier funds ingest & show in the ledger but
don't count toward breadth/flow. `isMostRespected` = elite subset. Diversified quant books (>1000 positions)
excluded from breadth.

**Ingest** `POST /flows/ingest` (admin, maxDuration 300) → `runInstitutionalIngest` + `runInstitutionalAggregate`.
Modes refresh(2q)/full(12q)/aggregate. Per fund×quarter: pull holdings + book, aggregate raw rows to one
long-equity position per (fund,ticker) — sum "SH" common, **exclude options**, merge economic share classes
(GOOG+GOOGL). Writes `FundHoldingSnapshot` + `FundBookSnapshot`. Idempotent. CLI: `npm run job:institutional`.
**Aggregate** `runInstitutionalAggregate`: (1) diff → set NEW/ADDED/HELD/TRIMMED, synthesize EXITED; (2) name
rollup over signal-tier funds → `InstitutionalNameAggregate` (breadth, conviction, Δholders, streak, netflowBps,
trajectory/lifecycle labels, quadrant, deciles); (3) sector rollup → `InstitutionalSectorAggregate`. Then
sub-precomputes leaderboard ingredients, returns, core holdings, style vectors, base rates → caches
`InstitutionalQuarterSnapshot`.
**Precomputed vs live:** aggregates, ingredients, core holdings, returns, base rates, quarter payload are
precomputed; GET routes are thin read wrappers over `institutional-query.service.ts`.

### Key algorithms
- **Active flow** (`institutional-active-flow.service.ts`): `netflowBps` = mean(active − expected weight) in bps.
  Expected = prior shares revalued at implied price, so **price appreciation is removed** — flow means funds
  actually traded, not that the stock rallied.
- **Rotation** (`src/lib/institutional/stock-rotation.ts`): diffusion = funds trading in − out (equal-weighted,
  1 vote/fund); shrunk diffusion `(in−out)/(n+k)`, k=4 (rewards breadth over tiny unanimity); rank score =
  `sd · ln(1+n) · √|net_bps|` rescaled 0–100 board-relative; demeaned vs quarter's participation-weighted mean.
- **Trajectories v3** (`src/domain/calculations/flow-trajectory.ts`): single `cumulativeAccSeries` = running sum
  of per-quarter all-funds netflowBps. **Pattern rank = streak_length × slope_consistency(R²) × breadth_growth**
  — pure function of series shape, never the latest-quarter move (a lone spike is capped by streak 1). Durable =
  streak ≥ 4 & R² ≥ 0.7. Lifecycle stages SPIKE/FORMING/DURABLE/CORE/BROKEN (`lifecycle.ts`).
- **Quadrant** (`quadrant/quadrantModel.ts`): breadth × conviction, log scales; foreground vs gray background;
  danger = breadth > p75 AND conviction > p75 AND Δholders < 0 (crowded unwind).
- **Crowding / exit clusters**: breadth > cross-sectional p75 = crowded; exit cluster = ≥3 high-conviction
  holders trimming/exiting one quarter.
- **Fresh calls** (`fresh-calls.ts`): qualified initiation still PENDING with zero follow votes; base-rate header
  pools top-decile originators' forward-2Q returns.
- **Core holdings** (`institutional-core-holdings.service.ts`): fund-relative endorsement = Σ tenure_mult ×
  weight_bps over long-hold voters; needs ≥5 voters across ≥2 categories; stasis break scored in σ vs own baseline.
- **Fund follow / exit-lead attribution** (`follow-attribution.ts`, `exit-lead-attribution.ts`): the FUND is the
  unit. **Asymmetric** — originator must clear full qualified-initiation bar (min bps AND min sizing); a follow
  vote only needs any NEW ≥ follow_min_bps. Outcomes FOLLOWED/CONSENSUS_AT_BIRTH(excluded)/PENDING/NOT_FOLLOWED.
  **No-lookahead** via filing-date `availableQuarter`. Exit-lead mirrors it for qualified trims + exit clusters.
- **Leaderboard composite** (`flow-leaderboard.ts`): recency-weighted count-flow z + capital-flow z, × streak ×
  conviction × elite, small-N shrinkage, ex-mega gate.
- **Data-quality flags** (`src/lib/institutional/flow-flags.ts`): `verify-weights`, `partial-data`,
  `unresolved-split`, `tenure-verify`, rendered identically everywhere via `FlagBadges`.

### Prisma models (`prisma/schema.prisma` ~1056+)
`InstitutionalFund` (watchlist; `tier` = denominator gate, `isMostRespected`) · `FundAlias` ·
`FundHoldingSnapshot` (fact table, one position per fund×ticker×period + precomputed ingredients) ·
`FundBookSnapshot` (book denominator) · `FundReturnSnapshot`/`FundReturnSummary` (clone-based long-book return) ·
`FundStyleVector` + `PeerSet`/`PeerSetMember` · `InstitutionalNameAggregate` (breadth/conviction/flow/trajectory
per ticker×period) · `InstitutionalSectorAggregate` · `InstitutionalQuarterSnapshot` (cached landing payload) ·
`InstitutionalCoreHolding` · `InstitutionalEvent` (stage_transition / stasis_break feed) · `InstitutionalBaseRate` ·
`InstitutionalMeta` (cache keys) · `CorporateAction` (splits) · `DataQualityEvent`.
Enums: `InstitutionalAction`, `FundTier`; reuses `RevisionGroupType` for sector/subsector.

---

## Quick file map

| Concern | Path |
|---|---|
| Page shells | `src/app/(analysis)/{research,fundamentals,flows}/page.tsx` |
| Client routers | `src/components/analysis/{research,fundamentals,flows}/{Research,Fundamentals,Flows}Client.tsx` |
| API routes | `src/app/api/analysis/{research,fundamentals,flows}/*/route.ts` (thin; delegate to services) |
| Read services | `revision-query.service.ts` · `fundamental-query.service.ts` · `institutional-query.service.ts` |
| Write jobs | `revision-weekly-job` · `fundamental-weekly-job` + `fundamental-box-scoring` · `institutional-ingest` + `institutional-aggregate` |
| Pure math | `src/lib/revision/*` · `src/lib/fundamental/*` · `src/lib/institutional/*` + `src/domain/calculations/flow-*` |
| Schema | `prisma/schema.prisma` (Revision ~563–800, Fundamental ~831–1003, Institutional ~1056–1454) |
| CLI jobs | `npm run job:revision` · `job:fundamental` · `job:institutional` |
