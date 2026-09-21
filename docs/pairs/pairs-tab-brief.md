# Pairs Tab — Build Brief

A new tab for the existing equity market-map platform. This document explains **what to build and why**, not how to structure the code. Architecture, schema design, job orchestration and framework choices are yours.

Everything here describes behaviour, definitions, formulas, display rules and edge cases. Where a threshold is given, treat it as a starting default to be tuned against live output, not as a constant.

---

## 1. Context: where this fits

The platform already has:

- A universe of ~2,500–3,000 US names with sector/subsector classification.
- **Engine 1 — Estimate-Revision Discovery.** Where analysts are changing their minds. Leg A = estimate-revision breadth from EPS/revenue consensus (forward-accruing only). Leg B = ratings and price-target changes (backtestable from point-in-time history). Weekly.
- **Engine 2 — Fundamental-Inflection Discovery.** Where the business itself is changing — margins, growth, returns, deleveraging — computed from statement history. Carries quality filters (accruals, trap detection) and valuation-vs-own-history. Weekly, partly backtestable from ~30yr history.
- **Engine 3 — Institutional Capital-Flow Discovery.** 13F holdings for a hand-curated watchlist of ~50–150 respected funds. Accumulation, distribution, crowding. Quarterly, ~45-day filing lag.
- **Engine 4 — 14-factor regression model** with per-name factor loadings, plus portfolio risk analytics.
- A Confluence tab that shows where engines independently agree.

Engines 1 and 2 lead. Engines 3 and 4 confirm. All data comes from Financial Modeling Prep (Ultimate tier).

**The Pairs tab is a new lens on these existing outputs.** It computes almost no new signals. It differences the signals you already have between two groups of stocks, so that market and sector exposure you have no view on cancels out.

### Why pairs are worth building

A relative claim is often easier to be right about than an absolute one. "Semis estimates are rising while software's are stalling" is a more tractable thesis than "semis will go up." Pairs also let a user express a view without taking market direction, which matters because the platform's edge is bottoms-up research on specific businesses, not macro calls.

### Boundary — unchanged from the rest of the platform

Discovery and diligence that narrow toward human research. The screen surfaces candidates; the human confirms the thesis. **Not a trade-recommendation system, not an auto-trader, no position sizing, no execution.** Quality and crowding screens exist to kill bad ideas as much as to surface good ones.

---

## 2. The core idea

> **When analysts or fundamentals start favouring group A over group B, and the share-price ratio between them has not moved yet, the price ratio tends to follow.**

That sentence is the entire product. The tab finds those situations, ranks them by how recently and sharply the divergence opened, and checks whether each one is a real pair or an accident.

It is an empirical claim, not a law. Screen 3 (Validation) exists to test it honestly and to state plainly when the data cannot support a conclusion.

### Signals choose the pair; price qualifies it

This is the most important design decision in the tab, and it is easy to get backwards.

**Signals decide which pairs matter and which way round they go.** The long leg is always the one Engine 1 or Engine 2 favours.

**Price never chooses a pair.** Ranking pairs on past relative price performance gives you one of two wrong products:

- Rank on recent *winners* → a momentum screen. Engine 4 already measures momentum, and the result would be the pairs everyone can already see on a chart. This directly fails the success criterion of surfacing unfamiliar names.
- Rank on *stretched* spreads → a mean-reversion / statistical-arbitrage screen. That bet assumes the relationship between the two groups holds and the gap will close. Engines 1 and 2 hunt for where a relationship is **breaking** because one group genuinely changed. Those are opposite premises; combining them would mean shorting the leg your fundamentals like.

**Price history is used for exactly four jobs, and no others:**

1. **Qualification** — do these two groups move together enough to be a pair at all (hedge efficiency, §5.7)?
2. **The "already noticed?" check** — has the price ratio reacted to the divergence yet (§5.4, §5.5)?
3. **Risk measurement** — spread volatility, drawdown, worst month, rolling leg correlation, factor decomposition.
4. **Calibration and validation** — is today's gap unusual for this pair, and does the premise hold historically?

Explicitly **not** used for: ranking pairs by past spread return or Sharpe, cointegration tests, or mean-reversion entry signals.

---

## 3. Vocabulary

Use these terms consistently in code, UI copy and tooltips.

**Pair.** Two groups of stocks held against each other. Group A is the **long leg**, group B the **short leg**. A group may be a basket of stocks, a single stock, or (Hedge Finder only) an ETF.

**Spread.** The return series of long leg minus short leg. All risk measurement happens on the spread, not on either leg alone.

**Breadth.** *How many* names in a group are moving, not how much any one moved:

```
breadth = 100 × (count improving − count deteriorating) / N
```

Unit is **percentage points (pp)**. Engine 1 revision breadth counts names with net analyst target raises vs net cuts. Engine 2 inflection breadth counts names flagged inflecting-up vs deteriorating.

**Why breadth and not the existing z-scores.** The platform z-scores signals *within subsector*. Those scores are mean-zero by construction, so every subsector averages 0 and every differential between subsectors is 0. They cannot be compared across groups. Breadth is un-normalised and therefore comparable: "71% of semis raised vs 38% of software" is a real statement about one group being treated better than another.

**Known tradeoff:** breadth is magnitude-blind. A 1% target nudge counts the same as a 40% raise. This is correct for a discovery screen — it cannot be hijacked by one enormous revision — but a group with two huge upgrades and eighteen flat names will look weak. If magnitude turns out to matter, add a **separate** average-revision-size column beside breadth. Do not blend the two into one number.

**Breadth gap (or differential).** Long-leg breadth minus short-leg breadth, in pp. The headline Engine 1 and Engine 2 number for a pair.

**Hedge efficiency.** How much of the two legs' price risk cancels when held against each other:

```
hedgeEff = 1 − Var(r_long − r_short) / (Var(r_long) + Var(r_short))
```

From 2 years of weekly total returns. Algebraically this reduces to `2·Cov(A,B) / (Var(A) + Var(B))` — a correlation-like quantity that **also penalises a volatility mismatch between the legs**, which plain correlation does not. Two groups can be 0.9 correlated while one is three times as volatile; dollar-neutral, the spread would then be mostly just the volatile leg. The denominator also makes the number comparable across pairs of very different volatility.

Scale: ≥0.7 tight pair · 0.4–0.7 workable · **<0.30 not a pair** (excluded from default ranking) · negative means the "hedge" doubles risk.

**Unpriced gap.** How far the signal gap has moved beyond what the price ratio has already moved, in standard deviations of that pair's own history. The tab's headline discovery metric (§5.5).

**Residual share.** Fraction of spread variance *not* explained by the 14 factors. High = the pair isolates something company- or industry-specific. Low = it is a factor bet in disguise.

Note that hedge efficiency and residual share sound similar and are not. Hedge efficiency asks *did much cancel?* Residual share asks *is what's left idiosyncratic or a disguised factor bet?* A pair can score well on one and badly on the other.

**Crowding.** Percent of the curated 13F fund watchlist holding names in a leg. Tracked per leg, never netted.

---

## 4. Pair universe

### 4.1 Do not build all pairs

~2,800 names gives ~4M unordered pairs. Rank those by anything and the top of the list is almost pure multiple-testing noise — with millions of candidates, extreme values occur by chance alone. The universe is **structurally constrained**, not statistically mined.

A pair is only meaningful if the two legs share a driver that cancels. Regional banks vs biotech is two unrelated bets, not a pair. Three tiers, each built by a different rule.

### 4.2 Tier 1 — subsector baskets

Every ordered pair of subsectors within the same sector, plus every ordered pair of sectors. Roughly 1,000–1,500 pairs. This is the "semis vs software" case.

- **Equal-weighted** baskets by default, with a liquidity floor. One name, one vote — matches the small/mid-cap focus.
- Also compute the **cap-weighted** version and store both. Their difference is a displayed column: a large gap means a few mega-caps drive the cap-weighted picture while the typical stock says something different.
- **Basket membership must be point-in-time.** Snapshot the constituent list each week so historical spreads are never computed with today's membership. This is the single most common source of fake backtest performance.
- A subsector with fewer than ~8 names falls back to its parent sector, matching the existing z-score convention.
- Cross-sector pairs are allowed but behind a scope toggle. They usually fail hedge efficiency; keep them visible as an instructive case rather than suppressing them silently.
- Baskets wash out single-name noise — an M&A bid on one short-leg name cannot wreck the pair.

### 4.3 Tier 2 — stocks within one subsector

For each subsector, top-k vs bottom-k names on Engine 1, and separately on Engine 2, with k ≈ 5 (configurable). Nearly free, since the peer-relative z-scores already exist.

- Shared factor and industry exposure cancels naturally, so these have the highest residual share of the three tiers.
- **Kill screens apply to both legs** (§6). The pair is whatever survives.
- Driven by the dispersion map (§8.4): worth generating for high-dispersion subsectors, near-useless for low-dispersion ones.

### 4.4 Tier 3 — curated links

A hand-maintained table of economically linked companies, in the same spirit as the 13F fund watchlist. FMP has no supply-chain data, so this is human-curated. Expect ~100–300 links initially; needs admin CRUD.

Three relation types:

- `SUPPLIER_CUSTOMER` — directional, e.g. semicap equipment → semis → hardware.
- `SUBSTITUTE` — direct competitors for the same demand.
- `INPUT_COST` — one company's input is the other's output, so the expected signal correlation is **negative**.

**Read-through logic** (the most forward-looking piece in the tab): flag a link when Engine 1 or Engine 2 fires on one side (|z| above threshold) and the other side has not moved (|z| below a smaller threshold) after N weeks. Status progresses `NEW` → `WATCH` → `CONFIRMED` as the second side moves. For `INPUT_COST` links, confirmation means a move in the **opposite** direction.

### 4.5 Orientation

Store each pair once, oriented so the long leg is the one the ranking signal favours. If the sign flips week to week, that is itself information — log the flip and surface it as a change rather than silently re-orienting.

---

## 5. Metrics

One row of the pair table = one weekly snapshot. Every field below should be stored rather than computed at render time, so the week-over-week diff is cheap.

### 5.1 Engine 1 — analyst revisions

- `e1BreadthLong`, `e1BreadthShort`, `e1Gap = long − short` (pp).
- `e1Gap4wChange` — gap now minus gap four snapshots ago. **This is the default sort of the entire table.** The tab is a change detector; the level is context. A pair sitting at +48pp for six months describes a difference the market has had ample time to price. A pair that went from +12pp to +48pp in four weeks is telling you something just happened.
- `e1GapSeries` — 13 weekly values for the sparkline. Distinguishes a durable trend from a one-week spike.

Leg A has no versioned vendor history, so its series accrues forward from go-live. **Leg B should drive the initial build**, since it backfills from point-in-time history.

### 5.2 Engine 2 — fundamental inflection

Same shape: `e2BreadthLong/Short`, `e2Gap`, `e2Gap4wChange`, `e2GapSeries`. Backfillable on day one from statement history, so Engine 2 carries the early validation work.

### 5.3 Engine 3 — 13F flows

- `e3NetBuyersLong/Short` — count of watchlist funds that added minus those that cut, per leg.
- `e3NetBuyerGap` — the difference. A **count**, never a score. "18 funds bought, 2 sold" means exactly what it says.
- `crowdingLong`, `crowdingShort` — percent of watchlist funds holding each leg, kept separate.
- `e3AsOfQuarter` plus a visible lag note. Quarterly, ~45-day lag. It confirms; it never leads.

### 5.4 Price ratio

The long leg's index divided by the short leg's, both indexed to 100 at a common start and built from total returns. A ratio rather than a difference because it matches the compounding shape of a dollar-neutral position and is scale-free.

- `relReturn1m`, `relReturn3m` — long-leg return minus short-leg return. Easier to read for a fixed window.
- `priceRatioSeries` — 13 weekly ratio values. **Must be drawn immediately beside the signal sparkline**; the adjacency is the point.
- `priceRatioZ` — today's ratio vs its own 5-year mean, in standard deviations. Context only. A stretched ratio *with* signal support means you are late, which is different from being wrong. Stretched *without* signal support is the fade-or-find-out case.

### 5.5 Unpriced gap

The headline discovery metric. Standardise both the signal-gap move and the price move on the **pair's own history**, then subtract:

```
unpricedGap = z_own(Δ signalGap, 4w) − z_own(relReturn1m)
```

Large positive = signals diverged, price has not followed. Store which engine drove it (`E1` | `E2` | `BOTH`) so the user is never guessing which signal is talking.

**Calibration requires history.** Usable on day one for Engine 2, Leg B and Engine 3; accrues forward for Leg A. Until a pair has ≥52 weekly observations, show the raw pp and % and mark the cell uncalibrated. **Do not fabricate a z-score from a short window.**

### 5.6 Valuation and weighting

- `valRatioPctile` — long-leg median forward multiple ÷ short-leg's, as a percentile of that ratio's own 5-year history. Self-referential and intra-pair, consistent with the existing valuation-vs-own-history convention. Render as a position marker on a track, not a bare number.
- `ewMinusCw1m` — the pair's 1-month return equal-weighted minus the same cap-weighted.

### 5.7 Engine 4 — factor decomposition

Regress the weekly spread on the 14 factors over 2 years:

- `residualSharePct` — 1 − R², as a percent. Below ~35–40% the pair is mostly a factor bet.
- `netFactorLoadings` — the full 14-vector, for the detail view.
- `topFactor`, `topFactorLoading` — largest absolute net exposure, shown in the table. "MOM +0.62" tells the user that being long this pair is substantially a momentum bet. Semis vs software looks like a sector view but may be mostly a cyclicality or beta bet in disguise — fine if you know it, dangerous if you don't.
- `hedgeEff` — §3. Pairs below 0.30 are excluded from the default ranking but remain visible dimmed when the filter is relaxed, because seeing *why* something is not a pair is instructive.

Also provide a beta-neutral sizing figure alongside the dollar-neutral one.

---

## 6. Flags and kill screens

Flags are rule-based labels stored on the snapshot, each threshold in config. Every flag is hoverable and its tooltip states the rule in plain English.

### 6.1 Pair flags

| Flag | Rule | Meaning |
|---|---|---|
| `NEW` | entered the top decile by unpriced gap this week | new arrival |
| `UNPRICED` | signal gap widened >8pp in 4w **and** relReturn1m within ±3% | the research setup |
| `PRICED` | relReturn3m > +15% **or** priceRatioZ > +1.5 | probably late |
| `FACTOR_BET` | residualSharePct < 40 | you are trading `topFactor`, not the thesis |
| `CROWDED_LONG` | crowdingLong > 60% | late trade |
| `NARROWING` | gap still positive but 4w change negative | thesis decaying |
| `ENGINES_DISAGREE` | sign(e1Gap) ≠ sign(e2Gap), both non-trivial | resolve before acting |
| `SHORT_LEG_OWNED` | crowdingShort > 40% | funds still own what you would short |
| `LOW_HEDGE_EFF` | hedgeEff < 0.30 | not a pair |

`ENGINES_DISAGREE` is worth more than it looks. Analysts saying one thing and the statements saying another is exactly the variant-perception setup the platform exists to find. Do not suppress those rows.

### 6.2 Kill screens — long side

Reuse Engine 2's existing quality filters. A name carrying a trap or accrual flag is **removed** from a Tier 2 long leg, not merely annotated.

### 6.3 Kill screens — short side

The engines were built to find longs, so the short leg needs its own gates. The short side leans on trap, accrual, distribution and negative-revision signals.

- **Short interest** — exclude above ~15% of float (squeeze risk).
- **Borrow proxy** — derive from market cap, ADV and short interest. Label `EASY` / `HARD`.
- **Liquidity** — ADV floor, default $5M/day.
- **M&A** — exclude names with reported deal interest. A bid spikes the short.
- **Engine 3** — exclude names watchlist funds are actively accumulating.

**In small/mid-caps, single-name shorts are often impractical.** Where the short side fails gates, the honest answer is a basket or ETF short, and the UI should offer that rather than a name the user cannot borrow.

### 6.4 Displaying kills

Killed names stay visible, struck through, with the reason. A screen that silently drops names teaches the user nothing and makes the survivor count inexplicable.

---

## 7. Hedge Finder

On-demand, not a weekly batch. Input: one long, usually arriving from the research queue by ticker. Output: ranked hedges. This is the form that fits the workflow — "here's my thesis, what isolates it?"

### 7.1 Two modes, one map

- **Neutralize** — remove everything the user has no view on. Maximum risk removed. Usually an ETF or basket.
- **Express** — short the loser of the thesis. The hedge becomes a second alpha leg, so its own signal weakness matters more than pure risk removal.

These pull in opposite directions, so do not choose one. Plot both on a single 2D map — risk removed on x, the hedge's own signal weakness on y — and draw the Pareto frontier. Position is the decision.

### 7.2 Inputs from Engine 4

Per name: the 14-factor loading vector β, residual volatility σ, and the factor covariance matrix Σ.

**Shrink small-cap betas toward the subsector mean** (λ ≈ 0.3). Raw small-cap betas are noisy and produce unstable hedge ratios. This is the difference between a tool that gives the same answer next week and one that does not.

### 7.3 Candidate pool

Same sector, plus Tier 3 linked names, plus sector/industry ETFs. Gate on ADV, price floor, borrow proxy, short interest and pending M&A.

For ETFs, **check and display whether the ETF holds the target**. Hedging a long with an ETF that contains it partially cancels the position against itself; show the weight.

### 7.4 Signals gate, they never blend

For single names: keep only candidates in the bottom tercile on Engine 1 **or** Engine 2, with no Engine 3 accumulation. After that gate, **the optimisation is purely risk** — no signal enters the objective function.

This keeps the no-hidden-composite principle intact and makes the output explicable: "these are sensible shorts; among them, this one removes the most risk."

Gated-out names stay on the map as hollow markers and in the table dimmed. Learning that the best risk-canceller is a company you should not short is useful.

### 7.5 Single-name hedge ratio

```
w = (β_L′ Σ β_c) / (β_c′ Σ β_c + σ²_c)
```

Keeping σ²_c in the denominator penalises noisy hedges. Report **both**:

- `factorRiskRemovedPct` — share of the long's factor variance cancelled.
- `totalVarRemovedPct` — share of **total** variance removed after adding the hedge's own idiosyncratic noise.

These diverge sharply for single-name hedges, and **the second is the honest number**. A name can cancel factor exposure almost perfectly while barely reducing total risk, or even increasing it. Show negative values; do not clamp to zero.

### 7.6 Basket hedge

Minimise `(β_L − Bw)′ Σ (β_L − Bw) + w′Dw` subject to `w ≥ 0` and a per-name cap.

With L the Cholesky factor of Σ this is non-negative least squares: stack `A = [L′B ; D^½]`, `b = [L′β_L ; 0]`, solve NNLS, then apply the cap. Select 5–8 names by greedy forward selection. No QP solver required.

The same solver generalises to neutralising the whole research-queue book against the 14 factors.

### 7.7 What each hedge must display

- Hedge ratio in dollars short per $1 long.
- Volatility before and after.
- **The 14 factor bars before and after.** This is the key readout: what remains is what the user is actually betting on. Accompany it with **one sentence in words** naming what survives — the most valuable element on the screen.
- The hedge's own Engine 1 / 2 / 3 columns, as gates.
- Short interest, borrow flag, ADV.
- **Both legs' earnings dates.** A hedge reporting next week is a scheduled shock, not a hedge.

### 7.8 Empirical cross-check

Beside every model number, show the same quantity measured from raw returns: realized β and R² over 2 years of weekly data, and the hedge ratio estimated separately on each half of the window. Flag when the halves differ by more than ~0.2, and plot the rolling 52-week ratio against the model-implied constant.

When model and history disagree, the user should trust neither. Making that visible is the difference between a hedge tool and a black box.

---

## 8. Screen 1 — Pair Map

Layout top to bottom: two status strips, a three-panel row, the rank table, a three-panel row. Sub-tabs top right: **Pair Map**, **Hedge Finder**, **Validation**.

### 8.1 Status strips

Row 1: as-of dates per engine (13F carries its lag note), pair-universe counts, count passing hedge efficiency, data-vintage tag.

Row 2: the controls that define what a pair is — tier toggle, scope (within-sector / all), basket weighting (equal / cap). These change the universe, so they sit above everything.

### 8.2 Pair matrix

Subsector × subsector heatmap for one sector at a time, plus a sector-vs-sector view. Rows are the long leg, columns the short leg; cell = row breadth − column breadth in pp. Diagonal shows each subsector's own breadth, styled distinctly.

- Engine toggle above the grid.
- Diverging green/red fill on a **fixed** scale so colour is comparable week to week. **Do not auto-scale to the week's extremes** — that destroys the change signal.
- Arrow glyph when the gap moved ≥8pp in 4 weeks; outline when new to the top decile.
- Hover any cell: full leg names, the arithmetic, the 4-week change.
- Click a cell to open that pair.

### 8.3 Divergence 2×2

x = 4-week change in signal gap (pp). y = long-leg return − short-leg return, 1 month (%).

Quadrants labelled in the plot. **Bottom-right shaded** as the research zone: widening signals, price flat. Top-right is already priced. Top-left is price moving without signals — fade it or find out why. Bottom-left is narrowing.

Dot colour carries flag state; ring = new this week; hover for numbers. This mirrors the existing "Have prices caught up" panel on the Research tab, so users already know how to read it.

### 8.4 Dispersion map

One dot per subsector. x = how split revisions are *inside* the subsector, as a percentile of its own 5-year history. y = the subsector's breadth.

**Critical implementation note: measure dispersion on raw winsorized revision values, never on the within-subsector z-scores.** Those have unit variance by construction, so every subsector would land at the same x position and the chart would collapse to a vertical line. Interquartile range works, or "% raised and % cut both high."

Interpretation, stated on the panel: **left** = analysts treat the group alike, so trade the basket (Tier 1); **right** = analysts are separating winners from losers, so pair stocks inside it (Tier 2). Up/down = whether the group as a whole is being raised or cut.

Clicking a dot loads that subsector into the Tier 2 panel below.

This panel also answers a question beyond pairs — where bottoms-up research time pays off — so it deserves prominence.

### 8.5 Pair rank table

The centrepiece. Two-line rows (long leg above, short leg below, with `n=` counts). Grouped column headers spanning sub-columns, one group per concern, **never merged into a composite**:

1. The pair — names, sector, hedge efficiency.
2. Engine 1 — gap, 4-week change.
3. Engine 2 — gap, 4-week change.
4. Engine 3 — net buyer gap.
5. Last 13 weeks — signal sparkline **beside** price-ratio sparkline.
6. Share-price performance — 1m, 3m, unpriced gap.
7. Valuation — ratio percentile on a track, price-ratio z.
8. Engine 4 — residual share, largest net factor.
9. Crowding — long / short as two numbers.
10. Flags.

Sorted by Engine 1 4-week change by default; every column sortable. Unpriced gap is the other natural default and worth trying once real data exists.

Filters: all / new this week / unpriced only, minimum hedge efficiency, hide factor bets. Rows failing hedge efficiency render dimmed rather than hidden.

Diverging heat fills on the two change columns and the unpriced gap; z-bars with a centre tick for gap columns; a position marker for valuation percentile. **Reading a row should tell the user why it ranks without opening anything.**

### 8.6 Bottom row

- **Arrivals/departures** — which pairs joined and left the top decile this week, as compact chips. Same pattern as the Research tab.
- **Tier 2 panel** — for the selected subsector: top-k vs bottom-k, killed names struck through with reasons. Summary strip gives the surviving spread's hedge efficiency, residual share, relative return, unpriced gap.
- **Tier 3 panel** — read-through table: link, relation, fired side's score, other side's score, weeks elapsed, status.

### 8.7 Change detection

The week-over-week diff is a first-class output, not a UI nicety. Track when a pair entered the top decile and how many weeks it has stayed, so "new this week" survives reloads and can be queried historically.

---

## 9. Screen 2 — Hedge Finder

### 9.1 Input strip

One row: the stock being hedged, idea source, long size, mode toggle, candidate pool toggles, gates (min ADV, max short interest, signal gate), basket settings, and a count of how many candidates pass. **Every gate visible and editable** — the user should never wonder why a name is missing.

### 9.2 What drives the target

The long's 14 factor loadings as z-bars, with β and % of variance per row, plus a split bar showing factor vs stock-specific share of risk. Only the factor-driven part can be hedged away.

Each factor needs a one-line plain-English definition in its tooltip, pulled from the Factors tab.

### 9.3 Hedge map

x = share of the long's **total** variance removed. y = the hedge's own Engine 1 score vs peers (toggle to Engine 2).

- Marker shape = type: circle single name, square basket, diamond ETF.
- Fill = the hedge's Engine 2 decile; hollow = failed a gate, shown for context.
- Dashed Pareto frontier across eligible candidates.
- Horizontal line marking the signal gate, labelled.
- Quadrant labels: bottom-right "removes risk and a weak name", top-right "strong name, do not short", left "little risk removed".

ETFs cluster on the zero line by construction — they remove risk but carry no view. That is a correct and useful visual fact.

### 9.4 Before / after

For the selected hedge, paired bars per factor: grey = the long alone, orange = long minus hedge. Plus a summary strip (volatility before/after, factor risk removed, total risk removed, residual share before/after, hedge ratio) and the one-sentence statement of what exposure survives.

### 9.5 Candidates table

Column groups in this order:

1. The hedge — ticker, name, type, which mode it suits, hedge ratio.
2. How much risk it removes — factor risk removed, total risk removed, volatility after, residual correlation.
3. Is it a sensible short — Engine 1 z, Engine 2 decile, Engine 3 flow. **Gate only.**
4. Can you short it — short interest, borrow, ADV, days to earnings.
5. Does return history agree — realized β, R², first-half/second-half hedge ratio, rolling ratio sparkline.
6. Flags.

Sorted by total risk removed. Gated-out rows dimmed, not hidden.

**Colour convention on the hedge's own signals is inverted** relative to the rest of the platform — red (weak company) is *good* for a short. Say so in the panel subtitle or users will misread it.

### 9.6 Bottom row

- **Basket composition** — constituents, weights, dollars per $1 long, which factors each offsets most, its own signals, short interest, ADV, earnings date. Summary: gross short, weighted signals, weighted short interest, how many report within 30 days.
- **Hedge ratio stability** — rolling 52-week empirical ratio vs the model-implied constant, with a verdict.
- **Hedged vs unhedged** — indexed 2-year series of the long alone against the hedged position, with spread volatility, max drawdown, worst month, rolling leg correlation range.

The drawdown number matters: it tells the user how much pain to expect even when the thesis is right.

---

## 10. Screen 3 — Validation

Tests whether the premise in §2 actually holds. This screen must be honest to the point of being unflattering; a tool that admits what it cannot see is more trustworthy than one that does not.

### 10.1 The test

**Pool every pair-week where the `UNPRICED` flag fired**, then measure the forward relative return (long leg minus short leg) over subsequent windows, against a control group of all non-flagged pair-weeks.

**Why pooling matters.** Testing one hypothesis once is legitimate. Ranking thousands of pairs by past performance and keeping the winners is not — with that many candidates, a spectacular top list arises from noise alone. Pooling largely removes the multiple-testing problem.

**Standard errors must be clustered by week.** Events overlap in time and share market conditions; treating them as independent would inflate t-statistics by roughly 40%.

**Hold out a recent period** that no threshold was tuned on. Everything in-sample will look better than reality. If thresholds are later retuned, the held-out period is burned and everything becomes in-sample again.

### 10.2 Panels

**Is the premise true?** States the claim and the exact event rule, then: events tested, mean forward return, the same for control weeks, the difference (the real result), t-stat, hit rate, IC, median, and the held-out figure.

**Decay curve.** Cumulative mean forward relative return by week after the event, with a ±1 standard error band and a control line. Where the curve flattens is where the edge is exhausted, which sets the holding period. Where the band clears zero is how long before anything shows.

**Which engine carries the result.** The same test per signal — Leg A, Leg B, Engine 2, Engine 3, and "both engines agree." The last row is the platform's triangulation thesis and is the row to watch as the sample grows. Leg A must be visibly marked as insufficient-history rather than presented as evidence.

**Slice table.** The same test on subsets: by tier, by hedge-efficiency bucket, by residual-share bucket, by size of the long leg, by subsector dispersion, by crowding, by valuation, plus the held-out period. Columns: events, decay sparkline, returns at two horizons, median, hit rate, t-stat, IC, sample start, and a plain-English note on what it suggests. Dim rows below ~300 events or with a t-stat under 1.

The header must warn that these slices are for **diagnosis, not selection**. With fifteen cuts, the best-looking row is partly luck. Treat a slice as real only if it is large, has an articulable mechanism, and survives out of sample.

The slices exist to answer specific design questions: do the factor-bet and crowding flags earn their place (those rows should show *no* edge)? Is the 0.30 hedge-efficiency gate set correctly? Does the edge actually concentrate in small/mid-caps as the thesis claims? Is the dispersion map predictive or merely descriptive?

**Distribution of outcomes.** Flagged events against control, bucketed. Distinguishes a genuine shift in the whole distribution from a mean dragged up by a fat right tail. These are different products: a tail-driven edge needs many positions to realise, a distribution shift does not. Show the worst decile — even when the screen is right on average, some go badly.

**Year by year.** The same test one year at a time. An edge that only worked in one regime is a regime bet. What kills the thesis is a single year carrying everything, or one negative year deep enough to swamp the rest.

**What this cannot tell you.** Coverage per input, plus the caveats in §11.

### 10.3 Tone

Set expectations correctly in the copy. A real result here looks like a modest edge — a hit rate in the mid-50s, a t-stat near 2, an effect measured in single-digit percentage points over a quarter. Anything dramatically better indicates a bug, a look-ahead leak, or survivorship bias. And a positive result is evidence the screen points somewhere useful; it is **not** a backtested strategy, and carries no transaction costs, borrow costs or slippage.

---

## 11. Data reality and limitations

These must be surfaced in the product, not just recorded here.

- **Engine 1 Leg A revision history accrues forward from go-live** and cannot be backfilled — FMP serves current consensus, not versioned history. Early validation rests on Leg B and Engine 2.
- **FMP's point-in-time and survivorship rigor is lighter than a specialist vendor**, so any backtest here is directional rather than definitive. A Sharadar-class bolt-on is the later option if rigorous backtesting becomes central.
- **13F is ~45 days stale by construction.** It confirms; it never leads.
- **Breadth is magnitude-blind** (§3).
- **Short interest coverage should be probed before relying on it.** If FMP's data is thin or stale for small-caps, the entire short-side screen is unreliable and the UI must say so rather than imply a clean screen. Ship the Hedge Finder with basket/ETF shorts only if necessary.

**Run a read-only Phase-0 validation probe before building**, as with the other engines, confirming on the actual universe and especially small-caps: short-interest coverage and staleness, ETF holdings data (needed for the contains-target check), earnings-date coverage for both legs, and whether subsector classifications are stable enough that basket membership does not churn week to week.

---

## 12. UI conventions

### 12.1 Definitions on hover

**Every column header, flag, summary statistic, control label and chart series gets a hover definition.** Assume the user does not know what an abbreviated variable means, and never make them infer it.

- Anything hoverable carries a dotted underline so it is discoverable.
- Tooltip = bold title plus 1–3 sentences of plain English: what the number is, how it is computed, how to read it. Not a restatement of the header.
- Matrix cells and chart dots show their own arithmetic on hover ("gap +48pp = +82 minus +34, changed +9pp in 4 weeks").
- Keep definitions in **one glossary keyed by metric id**, shared across all three screens and any future tab, so each definition is written once.
- Build tooltips as real popovers with keyboard focus support, not `title` attributes.

### 12.2 Labelling

- Every chart axis carries a written title with units and direction of good ("→ WIDENING"). No bare "x = Δ4W".
- Column headers spell things out: "BREADTH GAP, LONG − SHORT (pp)", not "DIFF pp". Two-line headers are fine.
- Units always: pp, %, σ, bps, $, decile, percentile.
- Where a scale has a good and bad end, say which in the panel subtitle.

### 12.3 Colour

- Green = long leg favoured / improving. Red = short leg favoured / deteriorating. Grey = neutral. Orange = selection, sort key, attention.
- Fixed colour scales across weeks, never auto-scaled per render.
- **Never colour alone.** Every colour-encoded value also appears as a number or a bar position.
- The one inversion — the hedge's own signals, where red is desirable — must be labelled in place.

### 12.4 Density

Match the existing tabs: 9.5–11px monospace, 22–30px rows, fixed pixel column widths, 1px borders, dark ground. Sparklines 68–84px wide, 18–22px tall. Panels flush in rows with a 5px gutter. No card shadows, no rounded containers, no decorative padding.

### 12.5 Raw quantities over composites

The project principle, restated because it erodes easily during implementation: prefer showing "18 funds bought, 2 sold" and "71% vs 38%" positionally over any blended score. A blended score hides the very information the user needs. Introduce a derived metric only when it corrects a real distortion — hedge efficiency, unpriced gap, conviction weighting — and then keep it as its own visible column with its own definition, never folded into a hidden rank.

### 12.6 Data vintage

Every panel mixing engines shows each engine's as-of date. The 13F lag is stated wherever 13F data appears. Sample or incomplete data carries a visible tag.

---

## 13. Suggested sequence

Each step should be usable on its own, so the tab delivers value before it is complete.

1. **Phase-0 probe.** Read-only. Decides whether the short-side screen is real.
2. **Subsector aggregates** — breadth and dispersion per group. Nearly free from existing engine output, and the dispersion map is useful even with nothing else built.
3. **Tier 1 pairs** — definitions, point-in-time membership, spreads, factor regressions, hedge efficiency, snapshots. Then the matrix, the 2×2 and the rank table.
4. **Tier 2** — cheap once the z-scores and kill screens are wired.
5. **Hedge Finder** — the solver, then the screen. Most likely to be used daily; do not leave it last if time is short.
6. **Tier 3** — curated link table and admin CRUD, then the read-through panel.
7. **Validation** — the pooled event study.

If scope must be cut: **Tier 1 + dispersion map + Hedge Finder is a complete, defensible product.** The all-pairs universe is the thing to skip permanently.

---

## 14. Success criteria

- The rank table surfaces largely **unfamiliar** subsector pairs and small/mid-cap names, not the mega-cap sectors everyone already watches. If the top of the list is dominated by the obvious, the ranking is picking up crowding rather than change.
- A user can read a row and say *why* it ranks without opening anything.
- The Hedge Finder's output differs meaningfully between Neutralize and Express. If both modes return the same answer, the signal gate is not working.
- Week-over-week turnover in the top decile is moderate. Near-total turnover means noise; near-zero means the change detector is measuring levels instead of changes.

---

## 15. Open questions for the product owner

1. **The 14 factors** — supply the real set plus one-line definitions for the tooltips.
2. **Fund watchlist size** for crowding percentages — 50 or 150 funds changes what "60% of funds hold it" means.
3. **Tier 3 seed list** — who curates it, and what is the initial set of links?
4. **Thresholds** throughout §6 are starting guesses. Tune against the first few weeks of live output rather than trusting them, but note that retuning burns the held-out validation sample.
5. **Magnitude column** beside breadth (§3) — wanted, or is breadth alone the right discovery unit?
6. **Borrow data** — if FMP's short interest proves unusable, source elsewhere or ship basket-only shorts?

---

## Appendix — visual reference

A clickable mockup of all three screens in the existing terminal UI:

**https://claude.ai/artifact/GUuHKGFH7iLKhhB92awJ36**

Three artboards: `Main.dc.html` (Pair Map), `Hedge.dc.html` (Hedge Finder), `Validation.dc.html` (Validation). Sub-tab links navigate between them; hover definitions work in play mode.

Use it for layout, density, column grouping, chart types and tooltip behaviour. **Every number, ticker and factor name in it is invented sample data.** Copy no value. The 14 factor names on the Hedge Finder are placeholders for the real model's factors.
