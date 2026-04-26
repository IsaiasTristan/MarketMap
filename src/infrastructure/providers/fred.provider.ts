/**
 * FredProvider: fetches FRED data series as CSV (no API key required).
 *
 * Two consumers today:
 *   • {@link fetchLatestRiskFreeRate} — TB3MS for legacy "what's RF right
 *     now" lookups.
 *   • {@link fetchDgs1moRfDaily} — DGS1MO daily, used by
 *     `factor-pipeline.service.refreshFactorPipeline` to back-fill the
 *     `RF` rows in `FactorReturnDaily` for the gap between Ken French's
 *     last published date and "today" (FRED publishes EOD; KF publishes
 *     ~30-45 days late). Without this back-fill, per-stock services treat
 *     missing RF as 0, silently inflating "excess" return over the gap
 *     tail and tripping the `factorDataStale` warning.
 *
 * FRED's CSV endpoint returns annualized percent (e.g. "4.40" = 4.40 %).
 * We normalise that to **annualized decimal** (e.g. 0.044) at parse time —
 * that is FRED's native unit and what data-provider tests pin. The
 * pipeline consumer is responsible for converting annual → daily (`/252`)
 * before persisting to `FactorReturnDaily.value`, which stores RF (and
 * every other code) as **daily simple decimal**.
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

/**
 * Fetch the daily 1-Month Treasury Constant Maturity rate (DGS1MO) and
 * return it in FRED's native unit: **annualized decimal** (e.g. 0.044 for
 * 4.4 % p.a.). Note this is NOT the unit `FactorReturnDaily.value` uses
 * for stored `RF` rows — those are **daily simple decimal**. The pipeline
 * service (`refreshFactorPipeline`) divides by 252 before calibrating to
 * KF's level and persisting.
 *
 * Why DGS1MO and not DTB4WK / TB3MS for this use case:
 *   • DGS1MO is a daily, smooth, methodologically consistent constant-
 *     maturity series — the standard practitioner stand-in for Ken
 *     French's monthly 1-month T-bill RF when KF is lagging.
 *   • DTB4WK reflects auction-cycle quirks of the actually-trading bill
 *     and can introduce stress-day spikes (Sep-2019 repo, Mar-2020,
 *     debt-ceiling) that aren't present in KF's smoothed series.
 *   • DGS1MO uses a 365-day annualization basis vs KF's 360-day discount
 *     basis (~1-2 bp/yr drift). For a tail-fill of a few weeks this is
 *     well below the noise floor of factor attribution.
 *
 * FRED reports missing trading days as ".", which `parseFloat` returns
 * as NaN — those are filtered out by `fetchFredSeries`. The caller is
 * still responsible for aligning to its own trading-day index (Mon-Fri
 * with the same caveat as `factor-pipeline.detectGap`: no US holiday
 * calendar; small dates may be lost on a few exchange holidays).
 */
export async function fetchDgs1moRfDaily(
  observationStart = "2000-01-01",
): Promise<FredObservation[]> {
  return fetchFredSeries("DGS1MO", observationStart);
}
