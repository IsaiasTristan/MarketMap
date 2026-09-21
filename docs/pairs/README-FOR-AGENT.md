# Pairs Tab — handoff package

Everything needed to build the Pairs tab in the existing Next.js / Prisma / Postgres
equity platform. Read this file first; it says what each other file is for and,
more importantly, what **not** to take from it.

```
pairs-tab-brief.md          ← the spec. Source of truth for behaviour.
glossary.json               ← 149 plain-English metric definitions. Ship as-is.
tokens.css                  ← colors, type, density extracted from the mockup.
reference/
  pair-map.html             ← static mockup, screen 1   (opens in any browser)
  hedge-finder.html         ← static mockup, screen 2
  validation.html           ← static mockup, screen 3
  *.png                     ← rendered screenshots of the same three screens
```

---

## How to use each file

**`pairs-tab-brief.md` — start here, and treat it as authoritative.**
It defines the concept, every metric with its formula, the flag rules, the hedge
solver, all three screens panel by panel, and the known data limitations. Where the
brief and the mockup disagree, **the brief wins**.

**`reference/*.png` — look at these before writing any layout code.**
Fastest way to understand the information density and the panel arrangement. Start
here rather than with the HTML.

**`reference/*.html` — open in a browser; grep for specifics; do not paste wholesale.**
These are ~230KB of generated markup with ~1,700 inline `style` attributes. They are
precise about column widths, spacing, bar treatments and chart geometry, and that
precision is the reason they exist. Use them to answer narrow questions — "how wide is
the valuation column", "what does the z-bar look like" — by opening the file and
looking, or by grepping for a panel title. **Do not read them into context in full and
do not port the markup.** Hover works in a browser; the tooltips are live.

**`glossary.json` — the highest-value file per byte.**
Maps a metric label to its plain-English definition. Load it as a lookup and render
every tooltip from it, so each definition is written once and is identical across all
three screens. These are already written to the right standard: what the number is,
how it is computed, how to read it.

**`tokens.css` — reconcile with what the app already has.**
If equivalent variables exist in the codebase, use those and delete this file. It is
extracted from the mockup, not authored ahead of it.

---

## What NOT to copy

**Every number, ticker and company in the mockup is invented.** Pair rankings, breadth
gaps, t-statistics, hedge ratios, fund counts — all fabricated to exercise the layout.
Nothing in `reference/` is a real security, a real relationship, or a real result.

**The 14 factor names in `hedge-finder.html` are placeholders.** `MKT`, `SIZE`, `VALUE`,
`MOM`, `IND:AERO` and the rest stand in for the real Engine 4 factor set, which has not
been supplied yet. Pull the real names and their definitions from the Factors tab.

**The fixed 1900px canvas is a mockup artifact.** The real tab lives in the app's normal
layout. Keep the density — fixed pixel column widths, 22–30px rows, 1px borders, no
decorative padding — but not the hardcoded page width.

**The Tier 3 link table is empty by design.** The examples shown (`AMAT → MU`,
`VLO ↔ DAL`, etc.) are illustrative. Build the schema and admin CRUD; the real links
are hand-curated by the product owner and get added through the UI.

**The CSS-only tooltip is a stand-in.** It uses `:hover` on a positioned span because
that is all a static file can do. Build a real popover with keyboard focus support.

---

## The five things most likely to be got wrong

These are the traps. Each is explained fully in the brief; they are repeated here
because they are easy to miss and expensive to discover later.

1. **Breadth, not z-scores, for anything compared across groups.** (brief §3)
   The platform's peer-relative z-scores are mean-zero within subsector by
   construction, so every cross-group differential computed from them is zero. Group
   comparisons use breadth — a count-based percentage that is not normalised.

2. **The dispersion map measures raw values, not z-scores.** (brief §8.4)
   Same trap, different symptom: within-subsector z-scores have unit variance by
   construction, so every subsector lands at the same x position and the chart
   collapses to a vertical line.

3. **Basket membership must be point-in-time.** (brief §4.2)
   Snapshot the constituent list each week. Computing historical spreads with today's
   membership is the single most common source of fake backtest performance.

4. **Signals choose pairs; price only qualifies them.** (brief §2)
   Never rank pairs on past relative price performance. Ranking on winners gives a
   momentum screen; ranking on stretched spreads gives a mean-reversion screen, which
   bets *against* what Engines 1 and 2 are detecting. Price history is for hedge
   efficiency, the already-priced check, risk measurement and validation only.

5. **Report both risk-removed numbers in the Hedge Finder.** (brief §7.5)
   Factor risk removed and total variance removed diverge sharply for single-name
   hedges. A name can cancel factor exposure almost perfectly while barely reducing
   total risk, or increasing it. Show the negative case; do not clamp to zero.

---

## Ordering

The brief closes with a suggested sequence (§13) and success criteria (§14). The short
version: probe the data first, then subsector aggregates and the dispersion map (nearly
free, useful alone), then Tier 1 and the Pair Map, then the Hedge Finder. Tier 3 and
Validation come last. If scope is cut, Tier 1 + dispersion map + Hedge Finder is a
complete, defensible product.

Open questions the product owner still needs to answer are listed in brief §15 — most
importantly the real factor set, which the Hedge Finder cannot ship without.
