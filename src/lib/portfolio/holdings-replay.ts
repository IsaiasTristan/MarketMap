/**
 * holdings-replay — pure reconstruction of actual day-by-day portfolio state
 * from a brokerage transaction ledger. No I/O; every function is deterministic
 * and unit-tested.
 *
 * Reconstruction direction is BACKWARD from today's known positions and cash:
 * the current snapshot is anchored to reality by the brokerage mirror, so
 * undoing each activity (subtracting its unit/cash delta) walks the balances
 * back through time and cannot drift. Whatever remains before the earliest
 * activity is the labelled opening position.
 *
 * Sign conventions (validated against live Robinhood-via-SnapTrade data):
 *   - `units` is already signed by SnapTrade (SELL is negative).
 *   - `amount` is the authoritative signed cash delta (BUY negative, DIVIDEND
 *     positive, CONTRIBUTION positive, FEE negative, ...).
 *
 * External flows (deposits, withdrawals, asset/cash transfers) are NOT
 * investment performance and must be removed from the return series. Buys,
 * sells, dividends, reinvestments, interest, and fees stay inside the return
 * (they are rebalancing, income, or cost — all part of what the portfolio
 * earned). The flow-adjusted daily return convention is:
 *
 *     r_t = NAV_t / (NAV_{t-1} + flow_t) - 1
 *
 * i.e. a flow arriving on day t is treated as available at the start of that
 * day, so a pure deposit day produces a 0% return.
 */

/** Normalized activity category. Mirrors the Prisma `BrokerageActivityType`. */
export type ActivityTypeCode =
  | "BUY"
  | "SELL"
  | "DIVIDEND"
  | "REINVEST"
  | "CONTRIBUTION"
  | "WITHDRAWAL"
  | "FEE"
  | "TAX"
  | "INTEREST"
  | "TRANSFER_IN"
  | "TRANSFER_OUT"
  | "CASH_TRANSFER"
  | "SPLIT"
  | "OTHER";

/**
 * Map SnapTrade's raw `type` string to the normalized category. Unrecognized
 * values return "OTHER" (the caller preserves the raw string and flags it).
 */
export function normalizeActivityType(raw: string | null | undefined): ActivityTypeCode {
  const t = (raw ?? "").trim().toUpperCase();
  switch (t) {
    case "BUY":
      return "BUY";
    case "SELL":
      return "SELL";
    case "DIVIDEND":
    case "SUBSTITUTE_DIVIDEND":
      return "DIVIDEND";
    case "REI":
    case "REINVEST":
    case "STOCK_DIVIDEND": // shares granted, ~no cash — treated as an internal share add
      return "REINVEST";
    case "CONTRIBUTION":
    case "DEPOSIT":
      return "CONTRIBUTION";
    case "WITHDRAWAL":
      return "WITHDRAWAL";
    case "FEE":
      return "FEE";
    case "TAX":
      return "TAX";
    case "INTEREST":
      return "INTEREST";
    case "EXTERNAL_ASSET_TRANSFER_IN":
      return "TRANSFER_IN";
    case "EXTERNAL_ASSET_TRANSFER_OUT":
      return "TRANSFER_OUT";
    case "TRANSFER": // generic; refined by classifyActivity when a security is attached
      return "CASH_TRANSFER";
    case "SPLIT":
      return "SPLIT";
    default:
      return "OTHER";
  }
}

/** A single normalized activity ready for replay. `date` is an ET yyyy-mm-dd. */
export interface ReplayActivity {
  date: string;
  activityType: ActivityTypeCode;
  ticker: string | null;
  units: number | null; // signed
  amount: number | null; // signed cash delta
  isOption?: boolean;
}

/** Per-activity effect on balances and external-flow classification. */
export interface ActivityEffect {
  ticker: string | null;
  unitsDelta: number;
  cashDelta: number;
  /** Cash portion that is an external flow (not performance). */
  externalCashFlow: number;
  /** Share units moved externally (valued at market close by buildDailyNav). */
  externalShareUnits: number;
  valuable: boolean;
}

/**
 * Classify one activity into its balance deltas and external-flow parts.
 * `cashDelta`/`unitsDelta` always come straight from the signed vendor fields;
 * only the external-flow split depends on the category.
 */
export function classifyActivity(a: ReplayActivity): ActivityEffect {
  const rawUnits = a.units ?? 0;
  const amount = a.amount ?? 0;
  const ticker = a.ticker ? a.ticker.toUpperCase() : null;
  const valuable = ticker != null && !a.isOption;
  // Option (and other unpriceable) rows: the premium still moves cash via
  // `amount`, but their `units` are contracts, NOT equity shares, and must
  // never touch an equity ticker's share balance.
  const unitsDelta = valuable ? rawUnits : 0;

  let externalCashFlow = 0;
  let externalShareUnits = 0;

  switch (a.activityType) {
    case "CONTRIBUTION":
    case "WITHDRAWAL":
    case "CASH_TRANSFER":
      externalCashFlow = amount;
      break;
    case "TRANSFER_IN":
    case "TRANSFER_OUT":
      // Shares (and occasionally cash) moving in/out of the account. The share
      // leg is valued at the day's close inside buildDailyNav; any cash leg is
      // an external flow directly.
      externalCashFlow = amount;
      externalShareUnits = valuable ? rawUnits : 0;
      break;
    default:
      // BUY / SELL / DIVIDEND / REINVEST / INTEREST / FEE / TAX / SPLIT / OTHER
      // are internal (rebalancing, income, or cost) — no external flow.
      break;
  }

  return {
    ticker,
    unitsDelta,
    cashDelta: amount,
    externalCashFlow,
    externalShareUnits,
    valuable,
  };
}

export interface HoldingsSnapshot {
  date: string;
  shares: Record<string, number>; // signed, by ticker
  cash: number;
}

/** Per-date external flow, split into a cash part and a to-be-valued share part. */
export interface ExternalFlowRow {
  date: string;
  cash: number;
  shareUnits: Record<string, number>;
}

export interface ReplayResult {
  /** Balances implied before the earliest activity (the opening position). */
  openingShares: Record<string, number>;
  openingCash: number;
  /** End-of-day balances at each distinct activity date, ascending. */
  snapshots: HoldingsSnapshot[];
  /** External flows keyed by date, ascending. */
  externalFlows: ExternalFlowRow[];
  /** Every ticker that ever appears in the ledger (for onboarding/pricing). */
  tickers: string[];
  /** Distinct raw activity types classified as OTHER (data-quality surface). */
  unvaluedOpenTickers: string[];
}

function cloneShares(s: Record<string, number>): Record<string, number> {
  return { ...s };
}

/**
 * Replay the ledger backward from the current (known) balances to derive the
 * opening position, then roll forward to produce an end-of-day snapshot at each
 * activity date and the external-flow series.
 *
 * `currentShares` must be SIGNED (short positions negative). Tiny residual
 * balances (below `epsilon`) are snapped to zero so floating-point dust from
 * fractional-share reinvestments doesn't leave phantom holdings.
 */
export function replayHoldingsBackward(
  currentShares: Record<string, number>,
  currentCash: number,
  activities: ReplayActivity[],
  epsilon = 1e-6,
): ReplayResult {
  const sorted = [...activities].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const effects = sorted.map((a) => ({ date: a.date, effect: classifyActivity(a) }));

  const tickerSet = new Set<string>();
  for (const t of Object.keys(currentShares)) tickerSet.add(t.toUpperCase());
  for (const { effect } of effects) if (effect.ticker) tickerSet.add(effect.ticker);

  // Opening = current − Σ deltas.
  const totalUnits: Record<string, number> = {};
  let totalCash = 0;
  for (const { effect } of effects) {
    if (effect.ticker) totalUnits[effect.ticker] = (totalUnits[effect.ticker] ?? 0) + effect.unitsDelta;
    totalCash += effect.cashDelta;
  }
  const openingShares: Record<string, number> = {};
  for (const t of tickerSet) {
    const v = (currentShares[t] ?? 0) - (totalUnits[t] ?? 0);
    openingShares[t] = Math.abs(v) < epsilon ? 0 : v;
  }
  const openingCash = currentCash - totalCash;

  // Roll forward from opening, snapshotting end-of-day balances per date.
  const shares = cloneShares(openingShares);
  let cash = openingCash;
  const snapshots: HoldingsSnapshot[] = [];
  const flowByDate = new Map<string, ExternalFlowRow>();

  let i = 0;
  while (i < effects.length) {
    const date = effects[i].date;
    let flow = flowByDate.get(date);
    if (!flow) {
      flow = { date, cash: 0, shareUnits: {} };
      flowByDate.set(date, flow);
    }
    while (i < effects.length && effects[i].date === date) {
      const e = effects[i].effect;
      if (e.ticker) shares[e.ticker] = (shares[e.ticker] ?? 0) + e.unitsDelta;
      cash += e.cashDelta;
      if (e.externalCashFlow !== 0) flow.cash += e.externalCashFlow;
      if (e.externalShareUnits !== 0 && e.ticker) {
        flow.shareUnits[e.ticker] = (flow.shareUnits[e.ticker] ?? 0) + e.externalShareUnits;
      }
      i++;
    }
    // Snap dust to zero in the snapshot copy.
    const snapShares: Record<string, number> = {};
    for (const [t, v] of Object.entries(shares)) snapShares[t] = Math.abs(v) < epsilon ? 0 : v;
    snapshots.push({ date, shares: snapShares, cash });
  }

  const externalFlows = [...flowByDate.values()]
    .filter((f) => f.cash !== 0 || Object.keys(f.shareUnits).length > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    openingShares,
    openingCash,
    snapshots,
    externalFlows,
    tickers: [...tickerSet].sort(),
    unvaluedOpenTickers: [],
  };
}

/** Holdings + cash as of a given date (step function; opening before day 0). */
export function holdingsOnDate(
  replay: ReplayResult,
  dateIso: string,
): { shares: Record<string, number>; cash: number } {
  let chosen: HoldingsSnapshot | null = null;
  for (const s of replay.snapshots) {
    if (s.date <= dateIso) chosen = s;
    else break;
  }
  if (!chosen) return { shares: replay.openingShares, cash: replay.openingCash };
  return { shares: chosen.shares, cash: chosen.cash };
}

/** Ticker → (date → unadjusted close). */
export type PriceLookup = (ticker: string, dateIso: string) => number | null;

export interface DailyNavResult {
  navByDate: number[];
  /** Dollar external flow per date (cash + share transfers valued at close). */
  flowByDate: number[];
  /** Dates (yyyy-mm-dd) aligned 1:1 with navByDate. */
  dates: string[];
  /** (ticker,date) pairs with a held position but no price — NAV understated. */
  missingPriceDays: { ticker: string; date: string }[];
}

/**
 * Build the daily dollar NAV and dollar external-flow series over `dates`.
 *
 * Uses UNADJUSTED closes: share counts come from raw transaction units, so
 * pairing them with dividend-adjusted prices would double-count dividends. The
 * caller supplies `priceOf` reading `PriceHistory.close` (with an `adjClose`
 * fallback flagged upstream).
 *
 * `openingFlow` (default = opening position value at the first date) is folded
 * into the first date's flow so the flow-matched benchmark starts with the same
 * capital as the portfolio.
 */
export function buildDailyNav(
  replay: ReplayResult,
  dates: string[],
  priceOf: PriceLookup,
  openingFlowOverride?: number,
): DailyNavResult {
  const navByDate: number[] = [];
  const flowByDate: number[] = [];
  const missingPriceDays: { ticker: string; date: string }[] = [];

  const flowLookup = new Map(replay.externalFlows.map((f) => [f.date, f]));

  for (let idx = 0; idx < dates.length; idx++) {
    const date = dates[idx];
    const { shares, cash } = holdingsOnDate(replay, date);
    let nav = cash;
    for (const [ticker, qty] of Object.entries(shares)) {
      if (Math.abs(qty) < 1e-9) continue;
      const px = priceOf(ticker, date);
      if (px == null) {
        missingPriceDays.push({ ticker, date });
        continue;
      }
      nav += qty * px;
    }
    navByDate.push(nav);

    // Dollar external flow on this date.
    const f = flowLookup.get(date);
    let flowDollars = 0;
    if (f) {
      flowDollars += f.cash;
      for (const [ticker, units] of Object.entries(f.shareUnits)) {
        if (Math.abs(units) < 1e-9) continue;
        const px = priceOf(ticker, date);
        if (px != null) flowDollars += units * px;
      }
    }
    flowByDate.push(flowDollars);
  }

  // Fold the opening position value into the first date's flow so the benchmark
  // and P&L see the same starting capital.
  if (dates.length > 0) {
    const openingValue =
      openingFlowOverride ??
      openingPositionValue(replay, dates[0], priceOf);
    flowByDate[0] += openingValue;
  }

  return { navByDate, flowByDate, dates, missingPriceDays };
}

/** Dollar value of the opening (pre-history) position at a valuation date. */
export function openingPositionValue(
  replay: ReplayResult,
  dateIso: string,
  priceOf: PriceLookup,
): number {
  let v = replay.openingCash;
  for (const [ticker, qty] of Object.entries(replay.openingShares)) {
    if (Math.abs(qty) < 1e-9) continue;
    const px = priceOf(ticker, dateIso);
    if (px != null) v += qty * px;
  }
  return v;
}

/**
 * Flow-adjusted daily returns:  r_t = NAV_t / (NAV_{t-1} + flow_t) - 1.
 * The first day has no return. A day whose (NAV_{t-1} + flow_t) base is <= 0 is
 * emitted as 0 (undefined return on a wiped-out / not-yet-funded base).
 */
export function flowAdjustedDailyReturns(nav: number[], flow: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < nav.length; i++) {
    const base = nav[i - 1] + (flow[i] ?? 0);
    if (base <= 0) {
      out.push(0);
      continue;
    }
    out.push(nav[i] / base - 1);
  }
  return out;
}

/**
 * Dollar value of a benchmark position funded by the same external flows on the
 * same dates: each flow buys `flow / benchClose` index units; the curve is the
 * accumulated units marked at each day's benchmark close.
 */
export function flowMatchedBenchmarkDollars(
  flow: number[],
  benchClose: (number | null)[],
): number[] {
  const out: number[] = [];
  let units = 0;
  for (let i = 0; i < flow.length; i++) {
    const px = benchClose[i];
    if (px != null && px > 0 && flow[i] !== 0) units += flow[i] / px;
    out.push(px != null ? units * px : out.length ? out[out.length - 1] : 0);
  }
  return out;
}

export interface SplitEvent {
  date: string;
  factor: number; // post/pre share multiplier (2 for a 2:1 split)
}

/**
 * Detect split events for one ticker by comparing raw close returns to adjusted
 * close returns. On a split day the raw close jumps by ~1/factor while the
 * adjusted (split-corrected) close moves only with the market, so
 * factor = ratio_adj / ratio_close. Only divergences beyond `tolerance` that
 * land near a clean ratio are reported. Used as a safety net when the brokerage
 * emits no SPLIT activity row.
 */
export function detectSplitFactors(
  series: { date: string; close: number | null; adjClose: number | null }[],
  tolerance = 0.1,
): SplitEvent[] {
  const events: SplitEvent[] = [];
  for (let i = 1; i < series.length; i++) {
    const p = series[i - 1];
    const c = series[i];
    if (p.close == null || c.close == null || p.adjClose == null || c.adjClose == null) continue;
    if (p.close <= 0 || p.adjClose <= 0) continue;
    const ratioClose = c.close / p.close;
    const ratioAdj = c.adjClose / p.adjClose;
    if (ratioClose <= 0) continue;
    const factor = ratioAdj / ratioClose;
    // A split makes factor materially different from 1 and close to an integer
    // ratio (2, 3, 1/2, ...). Market-move noise keeps factor within tolerance.
    if (Math.abs(factor - 1) <= tolerance) continue;
    const nearest = factor >= 1 ? Math.round(factor) : 1 / Math.round(1 / factor);
    if (nearest === 0 || !Number.isFinite(nearest)) continue;
    if (Math.abs(factor - nearest) / nearest <= tolerance) {
      events.push({ date: c.date, factor: nearest });
    }
  }
  return events;
}
