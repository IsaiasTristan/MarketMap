/**
 * Pure mapping from SnapTrade holdings to MarketMap portfolio positions.
 *
 * No I/O — takes the normalized SnapTrade shapes and returns the exact set of
 * equity positions + a cash figure to mirror into a portfolio, plus a list of
 * instruments we deliberately dropped (options, crypto, futures, ...) so the
 * UI can surface them rather than hide them.
 *
 * Rules:
 *  - Only equity-like instruments are kept (stock, ETF, ADR, closed-end fund);
 *    `PortfolioPosition` has no representation for a contract, so everything
 *    else is reported as skipped.
 *  - Units are signed: negative means short. Positions are aggregated by
 *    ticker on signed units, so a long+short pair nets and duplicates sum.
 *  - Zero (or non-finite) net units are dropped.
 *  - `cashEquivalent` positions (money-market funds already counted in the
 *    brokerage cash balance) are dropped so nothing is double-counted; cash is
 *    taken from the balance rows.
 */
import type {
  SnapTradeBalance,
  SnapTradePosition,
} from "@/infrastructure/providers/snaptrade/types";

/** Position shape consumed by `replacePositions` (structurally a PositionInput). */
export interface BrokeragePositionInput {
  ticker: string;
  shares: number;
  isShort: boolean;
}

export interface SkippedPosition {
  symbol: string | null;
  kind: string;
  reason: string;
}

export interface MappedHoldings {
  equities: BrokeragePositionInput[];
  /** Total cash in dollars, or null when the brokerage reported no cash balance. */
  cash: number | null;
  skipped: SkippedPosition[];
}

/** Instrument kinds that map cleanly to a tradeable equity ticker. */
const EQUITY_KINDS = new Set(["stock", "etf", "adr", "cef"]);

function toNumber(v: string | number | null | undefined): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") return Number(v);
  return NaN;
}

export function mapSnapTradePositions(
  positions: SnapTradePosition[],
  balances: SnapTradeBalance[],
): MappedHoldings {
  // Aggregate signed net units per ticker, preserving first-seen order.
  const netUnits = new Map<string, number>();
  const skipped: SkippedPosition[] = [];

  for (const p of positions) {
    const kind = (p.kind ?? "").toLowerCase().trim();
    const units = toNumber(p.units);

    // Money-market / cash-equivalent holdings are reflected in the cash
    // balance; drop them so they aren't counted twice.
    if (p.cashEquivalent) continue;

    if (!EQUITY_KINDS.has(kind)) {
      skipped.push({
        symbol: p.symbol ?? null,
        kind: kind || "unknown",
        reason: "non-equity instrument (not representable as a share position)",
      });
      continue;
    }

    if (!Number.isFinite(units) || units === 0) continue;

    const ticker = (p.symbol ?? "").trim().toUpperCase();
    if (!ticker) {
      skipped.push({ symbol: null, kind, reason: "missing ticker symbol" });
      continue;
    }

    netUnits.set(ticker, (netUnits.get(ticker) ?? 0) + units);
  }

  const equities: BrokeragePositionInput[] = [];
  for (const [ticker, signed] of netUnits) {
    if (!Number.isFinite(signed) || signed === 0) continue;
    equities.push({
      ticker,
      shares: Math.abs(signed),
      isShort: signed < 0,
    });
  }

  let cash: number | null = null;
  for (const b of balances) {
    if (typeof b.cash === "number" && Number.isFinite(b.cash)) {
      cash = (cash ?? 0) + b.cash;
    }
  }

  return { equities, cash, skipped };
}
