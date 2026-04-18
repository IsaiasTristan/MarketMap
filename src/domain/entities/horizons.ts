/** UI + analytics horizon keys; trading-day counts per product rules. */
export const HORIZON_TRADING_DAYS = {
  D1: 1,
  D5: 5,
  M1: 21,
  M3: 63,
  M6: 126,
  Y1: 252,
} as const;

export type Horizon = keyof typeof HORIZON_TRADING_DAYS;

export const HORIZON_ORDER: readonly Horizon[] = [
  "D1",
  "D5",
  "M1",
  "M3",
  "M6",
  "Y1",
];

export function tradingDaysForHorizon(h: Horizon): number {
  return HORIZON_TRADING_DAYS[h];
}
