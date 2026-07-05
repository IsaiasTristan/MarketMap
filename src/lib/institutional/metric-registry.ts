/**
 * Flows / Fund Overview — the metric definition registry (Part 4a/4b).
 *
 * ONE typed definition per metric, shared across every flows tab so the same concise
 * text renders in every tooltip. Every NUMBER a definition cites (25 bps, turnover
 * bands, follow window, sizing multiple) is INTERPOLATED from the SAME config object
 * the computation reads — so the copy physically cannot drift from the code. The
 * registry is therefore a FUNCTION of the config objects; `METRIC_REGISTRY` is the
 * default binding. The registry-consistency test renders it against a modified config
 * and asserts the numbers move (metric-registry.test.ts).
 *
 * Definitions are seeded verbatim from fund_overview_mockup_v3.html.
 */
import { FUND_OVERVIEW_CONFIG, type FundOverviewConfig } from "@/domain/calculations/fund-overview-config";
import { FUNDS_ATTRIBUTION_CONFIG, type FundsAttributionConfig } from "@/domain/calculations/funds-attribution-config";
import { INITIATION_CONFIG, type InitiationConfig } from "@/domain/calculations/initiation";

export interface MetricDef {
  id: string;
  /** Short human label (matches the on-screen term). */
  label: string;
  /** One/two-sentence definition — the tooltip body. Config numbers are interpolated. */
  short_def: string;
  /** How it's calculated (optional second paragraph). */
  calculation?: string;
  /** Caveats / gotchas (optional). */
  caveats?: string;
  /** Window / basis line (optional). */
  basis?: string;
}

export interface RegistryConfigs {
  overview: FundOverviewConfig;
  attribution: FundsAttributionConfig;
  initiation: InitiationConfig;
}

/** All metric ids in the registry. Adding a metric here makes it available everywhere. */
export const METRIC_IDS = [
  "filingTiming",
  "concentration",
  "effPositions",
  "medianTenure",
  "turnover",
  "optionsLines",
  "cloneAlpha",
  "estLongBookReturn",
  "confidence",
  "qAction",
  "tenure",
  "peersHold",
  "pxSince",
  "pctBook",
  "contributors",
  "lagCost",
  "sizeMix",
  "sizeTilt",
  "tailShape",
  "overlap",
  "differentiatedIdeas",
  "styleTwins",
  "peerMedian",
  "followRate",
  "medianLead",
  "fwdAfterEntries",
  "exitLeads",
  "bestSector",
  "freshCall",
  "qualifiedInitiation",
] as const;

export type MetricId = (typeof METRIC_IDS)[number];

/** Build the registry from config objects; every cited number is interpolated. */
export function buildMetricRegistry(cfg: RegistryConfigs): Record<MetricId, MetricDef> {
  const { overview: o, attribution: a, initiation: init } = cfg;
  const bench = o.benchmark_symbol;
  const bps = o.diff_ideas_min_bps;
  const confHi = o.return_conf_bands.high;
  const confMed = o.return_conf_bands.med;

  return {
    filingTiming: {
      id: "filingTiming",
      label: "filing timing",
      short_def:
        "Days between quarter end and this fund's 13F submission (45 allowed). Persistent late filers are often minimizing information leakage — entries by late filers historically carry slightly more signal.",
    },
    concentration: {
      id: "concentration",
      label: "concentration",
      short_def: "Share of reported 13F value in the largest 10 / 20 positions. Reported value basis, current quarter.",
    },
    effPositions: {
      id: "effPositions",
      label: "eff. positions",
      short_def:
        "Effective number of positions = 1 / HHI of position weights — the number of EQUAL-sized positions that would give the same concentration. Fewer than the actual count means a concentrated book with a long thin tail.",
    },
    medianTenure: {
      id: "medianTenure",
      label: "median tenure",
      short_def:
        "Median across current positions of consecutive quarters held. Changes within ±10% of shares don't break tenure (dividend reinvestment etc). '≥' means held since before our data history begins.",
    },
    turnover: {
      id: "turnover",
      label: "turnover",
      short_def:
        "Average % of book value traded per quarter, share-count based and price-adjusted (a position that merely appreciated is not 'traded'). Trailing 4 quarters.",
    },
    optionsLines: {
      id: "optionsLines",
      label: "options lines",
      short_def:
        "Whether the fund reports put/call option lines on its 13F. Funds using options may have hedged or leveraged exposure the share counts don't show.",
    },
    cloneAlpha: {
      id: "cloneAlpha",
      label: "clone alpha",
      short_def: `Annualized excess return vs ${bench} of copying this fund's reported book at each FILING date (what a follower could actually have earned), full available history. Long book only.`,
      caveats: `${bench} is a total-return series; excess is measured against it, not a price-only index.`,
    },
    estLongBookReturn: {
      id: "estLongBookReturn",
      label: "estimated long-book return",
      short_def:
        "Return of the reported long book: freeze holdings at each quarter end, hold to the next quarter end, value-weight, chain quarters. EXCLUDES intra-quarter trades, shorts, options, cash, non-13F assets. This is NOT fund NAV — it estimates how the disclosed longs performed.",
    },
    confidence: {
      id: "confidence",
      label: "confidence",
      short_def: `Estimate reliability, derived from turnover: the less a fund trades between snapshots, the closer this estimate tracks the real long book. HIGH < ${confHi}%/q · MED ${confHi}-${confMed}% · LOW > ${confMed}%.`,
    },
    qAction: {
      id: "qAction",
      label: "quarter action",
      short_def:
        "This quarter's action, SHARE-COUNT based (price moves alone are not action): added / trimmed = shares changed ≥10%; held = within ±10%; NEW n.n× = initiated, sized at n.n× this fund's median position weight (their own sizing habit is the yardstick).",
    },
    tenure: {
      id: "tenure",
      label: "tenure",
      short_def:
        "Consecutive quarters this fund has held the position (±10% share deadzone doesn't reset it). '≥' = held since before our data history begins, so true tenure is at least this.",
    },
    peersHold: {
      id: "peersHold",
      label: "peers hold",
      short_def: `How many funds in the SELECTED peer set also hold this name at ≥${bps} bps of their book. High = consensus within your universe; 0 = differentiated idea.`,
    },
    pxSince: {
      id: "pxSince",
      label: "px since",
      short_def:
        "Split-adjusted price return from quarter end to the latest close. How much of the disclosed positioning has already been paid by the market.",
    },
    pctBook: {
      id: "pctBook",
      label: "% book",
      short_def: "Position's reported market value ÷ total reported 13F value, current quarter.",
    },
    contributors: {
      id: "contributors",
      label: "contributors",
      short_def:
        "Position weight × position return over the quarter, in percentage points of book return. Sums (with all positions) to the period return above.",
    },
    lagCost: {
      id: "lagCost",
      label: "lag cost",
      short_def:
        "Same book, entered at FILING date instead of period end — what a copier could achieve. Lag cost = book-from-period-end minus clone-from-filing-date: the price of the ~45-day disclosure delay, for this fund specifically.",
    },
    sizeMix: {
      id: "sizeMix",
      label: "size mix",
      short_def: "Share of book value by market-cap band at quarter end: mega ≥ $200B · large $10-200B · mid $2-10B · small < $2B.",
    },
    sizeTilt: {
      id: "sizeTilt",
      label: "size tilt",
      short_def:
        "Value-weighted average market cap of holdings, per quarter. Falling can mean hunting smaller ideas (deliberate) or holdings shrinking (passive) — the drift-read line disambiguates using the median cap of NEW positions.",
    },
    tailShape: {
      id: "tailShape",
      label: "tail shape",
      short_def: `Characterization of positions outside the top 20: count, weight, age, and rank migration — whether today's core positions started as tail positions (an 'incubation bench' pattern, flagged at ≥${o.incubation_min} risers over the last ${o.rank_migration_window} quarters).`,
    },
    overlap: {
      id: "overlap",
      label: "book overlap",
      short_def:
        "Value-weighted share of common holdings: sum over shared names of min(weight in fund A, weight in fund B). 31% means about a third of the books are the same positions at comparable size.",
    },
    differentiatedIdeas: {
      id: "differentiatedIdeas",
      label: "differentiated ideas",
      short_def: `Positions this fund holds at ≥${bps} bps that NO other fund in the selected peer set holds at ≥ the same floor. The manager's genuinely differentiated bets — often the best idea-sourcing list on the page.`,
    },
    styleTwins: {
      id: "styleTwins",
      label: "style twins",
      short_def: `${o.twins_k} nearest neighbors by style vector (sector mix, size mix, concentration, turnover, median tenure; cosine similarity). Fair benchmarking against funds that invest the same WAY — regardless of whether they own the same names.`,
    },
    peerMedian: {
      id: "peerMedian",
      label: "peer median",
      short_def: `Percentile rank within the selected peer set; the tick marks the peer median so every percentile has a visible anchor. Sets smaller than ${o.peer_min_size} funds render "too small to rank".`,
    },
    followRate: {
      id: "followRate",
      label: "follow rate",
      short_def: `% of this fund's qualified initiations that ≥${a.follow_min_funds} other signal-tier funds also initiated (≥${a.follow_min_bps} bps) within ${a.follow_window} quarters. Trailing ${a.stat_window} qtrs, filing-date basis. Pending entries (younger than ${a.follow_window} qtrs) are excluded from the rate.`,
    },
    medianLead: {
      id: "medianLead",
      label: "median lead",
      short_def:
        "Median quarters between this fund's qualified initiation and the FIRST follower's initiation — followed episodes only. Shorter lead = the market copies them faster; longer = more time to act on their fresh calls.",
    },
    fwdAfterEntries: {
      id: "fwdAfterEntries",
      label: "fwd after entries",
      short_def: `Average stock return in the 2 quarters after this fund's qualified initiations, entered at FILING date, vs ${bench}. Hit = % of entries with positive excess.`,
    },
    exitLeads: {
      id: "exitLeads",
      label: "exit-leads confirmed",
      short_def: `% of this fund's qualified trims/exits (≥${a.trim_min_pct}% of shares, from a ≥${bps} bps position) that an exit cluster (≥${a.follow_min_funds} high-conviction holders trimming) followed within ${a.follow_window} quarters. Their record as a SELL leader.`,
    },
    bestSector: {
      id: "bestSector",
      label: "best sector",
      short_def: `Sector with this fund's highest follow rate, minimum ${a.sector_min_n} qualified initiations in that sector.`,
    },
    freshCall: {
      id: "freshCall",
      label: "fresh call",
      short_def: `A qualified initiation with ZERO followers so far, younger than the ${a.follow_window}-quarter follow window — the pre-consensus watchlist item.`,
    },
    qualifiedInitiation: {
      id: "qualifiedInitiation",
      label: "qualified initiation",
      short_def: `A new position entered at ≥${init.min_entry_bps} bps of book AND ≥${init.min_sizing_mult}× this fund's median position size — a deliberate, material initiation (not a token starter).`,
    },
  };
}

/** Default registry bound to the live config objects. */
export const METRIC_REGISTRY: Record<MetricId, MetricDef> = buildMetricRegistry({
  overview: FUND_OVERVIEW_CONFIG,
  attribution: FUNDS_ATTRIBUTION_CONFIG,
  initiation: INITIATION_CONFIG,
});

/** Look up a metric definition (throws in dev if the id is unknown — catches typos). */
export function metric(id: MetricId): MetricDef {
  const def = METRIC_REGISTRY[id];
  if (!def && process.env.NODE_ENV !== "production") throw new Error(`Unknown metric id: ${id}`);
  return def;
}
