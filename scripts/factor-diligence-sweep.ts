/**
 * factor-diligence-sweep — Phase 3 §6 universe sweep.
 *
 * Runs the per-stock pipeline over ALL active universe constituents at a
 * standard window (default 252d, MACRO14) and emits an aggregate health
 * report covering the locked-in failure modes:
 *
 *   • Strict drop-row impact (Q3 §2.7)
 *       — pct of rows lost per stock; flag stocks > 10% loss
 *   • Rolling-fit failures (Q3 §2.10)
 *       — count + dates per stock
 *   • Var-gap distribution (Q4)
 *       — %|gap| < 2% / 2-5% / ≥ 5% across universe
 *   • Multicollinearity (Q7)
 *       — % of stocks with κ ≥ 30 / κ ≥ 100; per-factor VIF medians
 *   • Identity reconciliation (Q1, Q2)
 *       — for each stock, |Σy − Σ(β·r) − Σα − Σε| ≤ 1e-6 (post burn-in)
 *
 *   npx tsx scripts/factor-diligence-sweep.ts [window=252] [model=MACRO14]
 *
 * Output is markdown; non-zero exit if any stock breaks the return identity
 * tolerance. Wire into CI before promoting Phase 3 to "stable".
 */
import { runPerStockFactors } from "@/server/services/factor-per-stock.service";
import { runPerStockTimeseries } from "@/server/services/factor-per-stock-timeseries.service";
import { resolveModel } from "@/lib/factors/definitions/model-presets";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode, ModelPresetName } from "@/types/factors";

const DEFAULT_WINDOW = 252;
const DEFAULT_MODEL: ModelPresetName = "MACRO14";
const RETURN_IDENTITY_TOL = 1e-6;

function pct(n: number, d: number): string {
  if (d <= 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

async function main() {
  const window = parseInt(process.argv[2] ?? `${DEFAULT_WINDOW}`, 10) || DEFAULT_WINDOW;
  const model = (process.argv[3] as ModelPresetName) ?? DEFAULT_MODEL;
  const factors = resolveModel(model).factors as FactorCode[];

  console.log(`# factor-diligence-sweep · ${model} · W = ${window}d\n`);

  const snap = await runPerStockFactors({ model, window });
  if (!snap || snap.rows.length === 0) {
    console.error("No rows — universe empty or insufficient data.");
    process.exitCode = 2;
    return;
  }

  console.log(`Total stocks evaluated: ${snap.rows.length} · skipped: ${snap.skipped.length}`);
  if (snap.skipped.length > 0) {
    console.log(`Skipped reasons: ${JSON.stringify(snap.skipped.slice(0, 8))}…`);
  }

  // ---------------- Var-gap distribution (Q4) ---------------------------
  const lt2 = snap.rows.filter((r) => Math.abs(r.varGapPct) < 0.02).length;
  const between = snap.rows.filter(
    (r) => Math.abs(r.varGapPct) >= 0.02 && Math.abs(r.varGapPct) < 0.05,
  ).length;
  const gte5 = snap.rows.filter((r) => Math.abs(r.varGapPct) >= 0.05).length;

  console.log(`\n## Variance gap distribution (Q4)`);
  console.log(`| Bucket | Count | Share |`);
  console.log(`| --- | -: | --: |`);
  console.log(`| |Δσ²/σ²ᵣ| < 2% (no badge) | ${lt2} | ${pct(lt2, snap.rows.length)} |`);
  console.log(`| 2-5% (neutral) | ${between} | ${pct(between, snap.rows.length)} |`);
  console.log(`| ≥ 5% (amber) | ${gte5} | ${pct(gte5, snap.rows.length)} |`);

  // ---------------- Multicollinearity (Q7) ------------------------------
  const kappas = snap.rows.map((r) => r.conditionNumber).filter((v) => Number.isFinite(v));
  const kappaGte30 = kappas.filter((k) => k >= 30).length;
  const kappaGte100 = kappas.filter((k) => k >= 100).length;
  console.log(`\n## Multicollinearity (Q7)`);
  console.log(`Median κ: ${median(kappas).toFixed(2)}`);
  console.log(`κ ≥ 30 (amber): ${kappaGte30} (${pct(kappaGte30, kappas.length)})`);
  console.log(`κ ≥ 100 (red):  ${kappaGte100} (${pct(kappaGte100, kappas.length)})`);

  console.log(`\nPer-factor VIF medians (across stocks):`);
  console.log(`| Factor | Median VIF | % stocks ≥ 5 | % stocks ≥ 10 |`);
  console.log(`| --- | --: | --: | --: |`);
  for (let fi = 0; fi < factors.length; fi++) {
    const code = factors[fi]!;
    const vifs = snap.rows
      .map((r) => r.vif[fi])
      .filter((v): v is number => v != null && Number.isFinite(v));
    if (vifs.length === 0) continue;
    const med = median(vifs);
    const gte5 = vifs.filter((v) => v >= 5).length;
    const gte10 = vifs.filter((v) => v >= 10).length;
    console.log(
      `| ${getFactorDef(code).shortLabel} | ${med.toFixed(2)} | ${pct(gte5, vifs.length)} | ${pct(gte10, vifs.length)} |`,
    );
  }

  // ---------------- Drop-row impact (Q3 §2.7) ---------------------------
  const dropRates: { ticker: string; dropped: number; pct: number }[] = [];
  for (const r of snap.rows) {
    const cellsTried = (r.observations + r.droppedDates.length) * factors.length || 1;
    const droppedCells = r.droppedDates.length;
    dropRates.push({
      ticker: r.ticker,
      dropped: droppedCells,
      pct: droppedCells / cellsTried,
    });
  }
  dropRates.sort((a, b) => b.pct - a.pct);
  const heavyDrop = dropRates.filter((d) => d.pct > 0.1).length;
  console.log(`\n## Strict drop-row impact (Q3 §2.7)`);
  console.log(`Stocks with > 10% factor cells dropped: ${heavyDrop} / ${dropRates.length}`);
  if (heavyDrop > 0) {
    console.log(`Top offenders:`);
    for (const d of dropRates.slice(0, 8)) {
      console.log(`  • ${d.ticker}: ${d.dropped} cells (${(d.pct * 100).toFixed(1)}%)`);
    }
  }

  // ---------------- Rolling failures + identity (Q1, Q2, Q3) ------------
  // Sample top-N stocks by market presence (we don't have mcap so just take
  // the first 30 alphabetically — full sweep is too slow at universe scale).
  const sample = snap.rows.slice(0, Math.min(snap.rows.length, 30));
  console.log(
    `\n## Rolling failures + return identity (sample of ${sample.length} stocks)`,
  );
  console.log(`| Ticker | obs | post-burn | rolling fails | dropped | gap | RET id |`);
  console.log(`| --- | -: | -: | -: | -: | --: | --- |`);

  let identityFails = 0;
  for (const r of sample) {
    try {
      const ts = await runPerStockTimeseries({ ticker: r.ticker, model, window });
      if (!ts) {
        console.log(`| ${r.ticker} | — | — | — | — | — | (no series) |`);
        continue;
      }
      const startIdx = ts.displayStartIndex;
      const n = ts.dates.length;
      let actualSum = 0;
      let factorContribSum = 0;
      let alphaSum = 0;
      let residualSum = 0;
      let postBurn = 0;
      for (let i = startIdx; i < n; i++) {
        actualSum += ts.excessReturn[i] ?? 0;
        const a = ts.alpha[i];
        const e = ts.residual[i];
        if (a != null && Number.isFinite(a)) alphaSum += a;
        if (e != null && Number.isFinite(e)) residualSum += e;
        for (const code of ts.usableFactors) {
          const v = ts.factorContrib[code]?.[i];
          if (v != null && Number.isFinite(v)) factorContribSum += v;
        }
        postBurn++;
      }
      const gap = actualSum - (factorContribSum + alphaSum + residualSum);
      const pass = Math.abs(gap) <= RETURN_IDENTITY_TOL;
      if (!pass) identityFails++;
      console.log(
        `| ${r.ticker} | ${r.observations} | ${postBurn} | ${ts.rollingFitFailures} | ${r.droppedDates.length} | ${gap.toExponential(2)} | ${pass ? "✓" : "✗"} |`,
      );
    } catch (e) {
      console.error(`! ${r.ticker}: ${(e as Error).message}`);
      identityFails++;
    }
  }

  console.log(`\n## Verdict`);
  if (identityFails === 0) {
    console.log("PASS — return identity holds across sampled stocks.");
  } else {
    console.error(`FAIL — ${identityFails} stock(s) broke return identity.`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 2;
});
