/**
 * Normalized SnapTrade shapes used by the brokerage services and the pure
 * position mapper. This is the stable boundary layer: signal/mirror code sees
 * these structural types, never the SDK's generated union types, so an SDK
 * bump can't ripple into business logic.
 *
 * Numeric fields SnapTrade returns as strings (e.g. `units`) are kept as
 * `string | number | null` here and coerced in the pure mapper.
 */

/** A brokerage account discovered under a SnapTrade connection. */
export interface SnapTradeAccount {
  id: string;
  brokerageAuthorization: string | null;
  name: string | null;
  number: string | null;
  institutionName: string | null;
}

/** A single position row from `getAllAccountPositions`. */
export interface SnapTradePosition {
  /** Instrument kind discriminator: stock | etf | adr | cef | option | crypto | future | ... */
  kind: string | null;
  symbol: string | null;
  /** Signed unit count as SnapTrade returns it (string in v12). */
  units: string | number | null;
  /** True when the position is also counted in cash/buying power (money-market). */
  cashEquivalent: boolean;
  currency: string | null;
}

/** A per-currency cash balance from `getUserAccountBalance`. */
export interface SnapTradeBalance {
  currency: string | null;
  cash: number | null;
}
