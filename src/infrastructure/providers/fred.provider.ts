/**
 * FredProvider: fetches FRED data series as CSV (no API key required).
 * Used primarily for TB3MS (3-month T-bill rate as risk-free rate proxy).
 */

export interface FredObservation {
  date: string; // YYYY-MM-DD
  value: number; // as decimal e.g. 0.0525 = 5.25%
}

const FRED_BASE = "https://fred.stlouisfed.org/graph/fredgraph.csv";

export async function fetchFredSeries(
  seriesId: string,
  observationStart = "2000-01-01",
): Promise<FredObservation[]> {
  const url = `${FRED_BASE}?id=${seriesId}&vintage_date=&realtime_start=${observationStart}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketMap/1.0)" },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`FRED ${seriesId} fetch failed: ${res.status}`);
  const text = await res.text();

  const lines = text.split("\n").slice(1); // skip header "DATE,VALUE"
  return lines
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      const [date, val] = l.split(",");
      const v = parseFloat(val);
      return { date: date.trim(), value: isNaN(v) ? null : v / 100 };
    })
    .filter((r): r is FredObservation => r.value !== null);
}

/** Returns the most recent annual risk-free rate from TB3MS. */
export async function fetchLatestRiskFreeRate(): Promise<number> {
  const obs = await fetchFredSeries("TB3MS");
  if (!obs.length) return 0.05;
  return obs[obs.length - 1].value;
}
