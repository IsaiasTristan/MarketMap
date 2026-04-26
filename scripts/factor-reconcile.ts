/**
 * factor-reconcile — diagnostic dump that proves the per-stock factor
 * decomposition obeys the two identities locked in for Phase 3:
 *
 *   (1) RETURN IDENTITY (Q2/Q5 lock-in, post burn-in):
 *       Σy_i ≡ Σ(β_t · r_t)_i + Σα_t,i + Σε_t,i      for i ≥ displayStartIndex
 *
 *   (2) VARIANCE IDENTITY (Q1 lock-in, on regression-aligned dates):
 *       β'Σβ + σ²_idio  ≈  realised variance       (within varGapPct)
 *       and the latest rolling Euler point ties to the snapshot Euler
 *       within ≤ 1 bp.
 *
 * Output is a markdown table with one row per (ticker, window) showing the
 * raw numbers plus pass/fail flags. The script exits with code 1 if any
 * row fails — wire it into CI before promoting Phase 3 to "stable".
 *
 *   npx tsx scripts/factor-reconcile.ts SPY,QQQ,XLE 60,252
 *
 * Both args optional. Defaults: AAPL,MSFT,JPM,XOM,SPY × 60,252.
 *
 * Tolerances:
 *   • Return identity: |gap| ≤ 1e-6 (~ 0.0001%) — pure FP noise
 *   • Latest rolling Euler ↔ snapshot Euler share gap: ≤ 1 bp (Q1)
 *   • Latest rolling total σ ↔ snapshot model σ gap: ≤ 1 bp
 *   • Var-gap (model vs realised): NOT enforced — reported only.
 */
import { runPerStockFactors } from "@/server/services/factor-per-stock.service";
import { runPerStockTimeseries } from "@/server/services/factor-per-stock-timeseries.service";
import type { ModelPresetName } from "@/types/factors";

const DEFAULT_TICKERS = ["AAPL", "MSFT", "JPM", "XOM", "SPY"];
const DEFAULT_WINDOWS = [60, 252];
const MODEL: ModelPresetName = "MACRO14";

const RETURN_IDENTITY_TOL = 1e-6;
const EULER_TIE_TOL_BP = 0.0001; // 1 bp

function fmtPct(v: number, dp = 2): string {
  if (!Number.isFinite(v)) return "—";
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(dp)}%`;
}

function fmtNum(v: number, dp = 4): string {
  if (!Number.isFinite(v)) return "—";
  return v.toFixed(dp);
}

interface Row {
  ticker: string;
  window: number;
  obs: number;
  postBurnObs: number;
  realisedSigma: number;
  modelSigma: number;
  varGapPct: number;
  rSquared: number;
  eulerSnap: number;
  eulerLatestRolling: number;
  totalSigmaLatestRolling: number;
  retIdentityGap: number;
  alphaRatio: number;
  rollingFailures: number;
  droppedCells: number;
  retIdentityPass: boolean;
  eulerTiePass: boolean;
  sigmaTiePass: boolean;
}

async function reconcileTickerWindow(ticker: string, window: number): Promise<Row | null> {
  // Snapshot — full per-stock decomposition.
  const snap = await runPerStockFactors({ model: MODEL, window });
  const row = snap?.rows.find((r) => r.ticker === ticker);
  if (!row || !snap) return null;

  // Time series — rolling fits + per-day Euler at the same window
  // (Q1 lock: rolling W = snapshot W).
  const ts = await runPerStockTimeseries({ ticker, model: MODEL, window });
  if (!ts) return null;

  const startIdx = ts.displayStartIndex;
  const n = ts.dates.length;

  // Return identity (post burn-in).
  let factorContribSum = 0;
  for (const code of ts.usableFactors) {
    const arr = ts.factorContrib[code];
    if (!arr) continue;
    for (let i = startIdx; i < n; i++) {
      const v = arr[i];
      if (v != null && Number.isFinite(v)) factorContribSum += v;
    }
  }
  let alphaSum = 0;
  let residualSum = 0;
  let actualSum = 0;
  let postBurnObs = 0;
  for (let i = startIdx; i < n; i++) {
    const a = ts.alpha[i];
    const e = ts.residual[i];
    actualSum += ts.excessReturn[i] ?? 0;
    if (a != null && Number.isFinite(a)) alphaSum += a;
    if (e != null && Number.isFinite(e)) residualSum += e;
    postBurnObs++;
  }
  const retIdentityGap = actualSum - (factorContribSum + alphaSum + residualSum);

  // Latest rolling Euler vs snapshot Euler.
  let eulerLatestRolling = 0;
  for (const code of ts.usableFactors) {
    const arr = ts.rollingPctVarianceContrib[code];
    if (!arr) continue;
    const v = arr[n - 1];
    if (v != null && Number.isFinite(v)) eulerLatestRolling += v;
  }
  const totalSigmaLatestRolling = ts.rollingTotalVolAnn[n - 1] ?? 0;

  const eulerTieGap = Math.abs(row.systematicShareEulerAligned - eulerLatestRolling);
  const sigmaTieGap = Math.abs(row.modelImpliedAnnualizedVol - (totalSigmaLatestRolling ?? 0));
  const alphaRatio = Math.abs(actualSum) > 1e-9 ? Math.abs(alphaSum) / Math.abs(actualSum) : 0;

  return {
    ticker,
    window,
    obs: row.observations,
    postBurnObs,
    realisedSigma: row.realizedAnnualizedVol,
    modelSigma: row.modelImpliedAnnualizedVol,
    varGapPct: row.varGapPct,
    rSquared: row.rSquared,
    eulerSnap: row.systematicShareEulerAligned,
    eulerLatestRolling,
    totalSigmaLatestRolling: totalSigmaLatestRolling ?? 0,
    retIdentityGap,
    alphaRatio,
    rollingFailures: ts.rollingFitFailures,
    droppedCells: row.droppedDates.length,
    retIdentityPass: Math.abs(retIdentityGap) <= RETURN_IDENTITY_TOL,
    eulerTiePass: eulerTieGap <= EULER_TIE_TOL_BP,
    sigmaTiePass: sigmaTieGap <= EULER_TIE_TOL_BP,
  };
}

async function main() {
  const tickersArg = process.argv[2];
  const windowsArg = process.argv[3];
  const tickers = tickersArg
    ? tickersArg.split(",").map((t) => t.trim().toUpperCase())
    : DEFAULT_TICKERS;
  const windows = windowsArg
    ? windowsArg
        .split(",")
        .map((w) => parseInt(w.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 20)
    : DEFAULT_WINDOWS;

  console.log(`# factor-reconcile · model = ${MODEL} · ${tickers.length} ticker(s) × ${windows.length} window(s)\n`);
  console.log(
    "| Ticker | W | obs | post-burn | realised σ | model σ | Δσ²/σ²ᵣ | R² | Euler snap | Euler last-roll | σ last-roll | Σy gap | |Σα|/|Σy| | fit fails | dropped | RET | EULER | σ |",
  );
  console.log(
    "| ------ | -: | -: | -------: | ---------: | ------: | -------: | --: | ---------: | --------------: | ----------: | -----: | -------: | --------: | ------: | --- | ----- | --- |",
  );

  const all: Row[] = [];
  let failures = 0;

  for (const ticker of tickers) {
    for (const window of windows) {
      try {
        const r = await reconcileTickerWindow(ticker, window);
        if (!r) {
          console.log(`| ${ticker} | ${window} | — | (skipped — no data / insufficient overlap) | | | | | | | | | | | | | | |`);
          continue;
        }
        all.push(r);
        const pass = r.retIdentityPass && r.eulerTiePass && r.sigmaTiePass;
        if (!pass) failures++;
        console.log(
          `| ${r.ticker} | ${r.window} | ${r.obs} | ${r.postBurnObs} ` +
            `| ${fmtPct(r.realisedSigma, 1)} | ${fmtPct(r.modelSigma, 1)} | ${fmtPct(r.varGapPct, 1)} ` +
            `| ${fmtPct(r.rSquared, 0)} ` +
            `| ${fmtPct(r.eulerSnap, 1)} | ${fmtPct(r.eulerLatestRolling, 1)} | ${fmtPct(r.totalSigmaLatestRolling, 1)} ` +
            `| ${fmtNum(r.retIdentityGap, 8)} | ${fmtPct(r.alphaRatio, 0)} ` +
            `| ${r.rollingFailures} | ${r.droppedCells} ` +
            `| ${r.retIdentityPass ? "✓" : "✗"} | ${r.eulerTiePass ? "✓" : "✗"} | ${r.sigmaTiePass ? "✓" : "✗"} |`,
        );
      } catch (e) {
        console.error(`! ${ticker} W=${window} ERROR: ${(e as Error).message}`);
        failures++;
      }
    }
  }

  console.log("");
  console.log(`## Summary`);
  console.log(`Rows: ${all.length} · Failures: ${failures}`);
  if (failures > 0) {
    console.error(
      `\nFAIL — ${failures} reconciliation row(s) outside tolerance.\n` +
        `  • Return identity tolerance: ${RETURN_IDENTITY_TOL}\n` +
        `  • Euler tie / σ tie tolerance: ${EULER_TIE_TOL_BP * 100}bp\n`,
    );
    process.exitCode = 1;
  } else {
    console.log(`PASS — all rows within tolerance.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
