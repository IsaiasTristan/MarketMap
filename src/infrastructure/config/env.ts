function readNumber(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Annualized risk-free rate as decimal (e.g. 0.04). */
export function riskFreeAnnual(): number {
  return readNumber("RISK_FREE_ANNUAL", 0.04);
}

export function marketDataProviderId(): string {
  return process.env.MARKET_DATA_PROVIDER ?? "yahoo";
}
