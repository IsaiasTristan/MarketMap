/**
 * Engine 1 — Leg A (estimate consensus) snapshot builder. FMP returns current
 * consensus only, so the weekly snapshot store IS Leg A's revision history.
 * Produces a per-ticker partial; the weekly orchestrator merges it with Leg B
 * and writes one RevisionSnapshot row per (ticker, snapshotDate).
 */
import {
  fetchAnalystEstimates,
  fmpPool,
  type NormalizedEstimatePeriod,
} from "@/infrastructure/providers/fmp";

export interface LegASnapshotPart {
  ticker: string;
  revenueAvg: number | null;
  epsAvg: number | null;
  numAnalystsRevenue: number | null;
  numAnalystsEps: number | null;
  estimatesJson: {
    nextFiscalDate: string | null;
    annual: NormalizedEstimatePeriod[];
    quarter: NormalizedEstimatePeriod[];
  };
}

/** The nearest forward fiscal period at/after `asOf` (fallback: latest). */
function pickForward(
  periods: NormalizedEstimatePeriod[],
  asOf: string,
): NormalizedEstimatePeriod | null {
  if (periods.length === 0) return null;
  const forward = periods.find((p) => p.fiscalDate >= asOf);
  return forward ?? periods[periods.length - 1]!;
}

function build(
  ticker: string,
  annual: NormalizedEstimatePeriod[],
  quarter: NormalizedEstimatePeriod[],
  asOf: string,
): LegASnapshotPart {
  const fwd = pickForward(annual, asOf);
  return {
    ticker,
    revenueAvg: fwd?.revenue.avg ?? null,
    epsAvg: fwd?.eps.avg ?? null,
    numAnalystsRevenue: fwd?.numAnalystsRevenue ?? null,
    numAnalystsEps: fwd?.numAnalystsEps ?? null,
    estimatesJson: { nextFiscalDate: fwd?.fiscalDate ?? null, annual, quarter },
  };
}

export async function buildLegASnapshots(
  tickers: string[],
  asOf: string,
  opts: { log?: (msg: string) => void } = {},
): Promise<{ parts: Map<string, LegASnapshotPart>; failures: string[] }> {
  const log = opts.log ?? (() => {});
  const { results, failures } = await fmpPool(
    tickers,
    async (ticker) => {
      const [annual, quarter] = await Promise.all([
        fetchAnalystEstimates(ticker, "annual", 16),
        fetchAnalystEstimates(ticker, "quarter", 16),
      ]);
      return build(ticker, annual, quarter, asOf);
    },
    { concurrency: 8 },
  );
  log(`[leg-a] estimates for ${results.length}/${tickers.length} tickers (${failures.length} failed)`);
  return {
    parts: new Map(results.map((r) => [r.item, r.value])),
    failures: failures.map((f) => `${f.item}: ${f.error}`),
  };
}
