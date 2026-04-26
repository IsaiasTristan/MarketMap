/**
 * factor-sensitivity — sweep rolling betas across multiple regression
 * windows for a sample of tickers and print a summary so we can quantify
 * how much our cell-level betas depend on the choice of window.
 *
 * Phase 2 plan task: `beta_sensitivity_sweep`. Wire-up only — execute via
 *
 *   npx tsx scripts/factor-sensitivity.ts SPY,QQQ,XLE,XLU 30,60,90,252
 *
 * Both args optional. Defaults: AAPL,MSFT,JPM,XOM × 30/60/90/252.
 *
 * Output is a markdown table on stdout per ticker:
 *
 *   ## SPY (MACRO14, end-of-window β)
 *   | Factor   |  30D  |  60D  |  90D | 252D | range |
 *   | -------- | ----: | ----: | ---: | ---: | ----: |
 *
 * "range" = max − min across windows (a quick stability proxy).
 */
import { runPerStockTimeseries } from "@/server/services/factor-per-stock-timeseries.service";
import { resolveModel } from "@/lib/factors/definitions/model-presets";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode, ModelPresetName } from "@/types/factors";

const DEFAULT_TICKERS = ["AAPL", "MSFT", "JPM", "XOM"];
const DEFAULT_WINDOWS = [30, 60, 90, 252];
const MODEL: ModelPresetName = "MACRO14";

async function main() {
  const tickersArg = process.argv[2];
  const windowsArg = process.argv[3];
  const tickers = tickersArg ? tickersArg.split(",").map((t) => t.trim().toUpperCase()) : DEFAULT_TICKERS;
  const windows = windowsArg
    ? windowsArg.split(",").map((w) => parseInt(w.trim(), 10)).filter((n) => Number.isFinite(n) && n >= 20)
    : DEFAULT_WINDOWS;

  const factors = resolveModel(MODEL).factors as FactorCode[];

  for (const ticker of tickers) {
    console.log(`\n## ${ticker} (${MODEL}, end-of-window β)\n`);
    const header = ["Factor", ...windows.map((w) => `${w}D`), "range"];
    const align = ["-".repeat(8), ...windows.map(() => "----:"), "----:"];
    console.log(`| ${header.join(" | ")} |`);
    console.log(`| ${align.join(" | ")} |`);

    const rows: { code: FactorCode; betas: (number | null)[] }[] = factors.map((c) => ({
      code: c,
      betas: new Array(windows.length).fill(null),
    }));

    for (let wi = 0; wi < windows.length; wi++) {
      const win = windows[wi]!;
      try {
        const ts = await runPerStockTimeseries({ ticker, model: MODEL, window: win });
        if (!ts) continue;
        for (const code of factors) {
          const b = ts.betas[code];
          if (b == null) continue;
          const r = rows.find((rw) => rw.code === code);
          if (r) r.betas[wi] = b;
        }
      } catch (err) {
        console.error(`  (${win}D failed for ${ticker}): ${(err as Error).message}`);
      }
    }

    for (const r of rows) {
      const def = getFactorDef(r.code);
      const cells = r.betas.map((b) => (b == null ? "—" : b.toFixed(2)));
      const finite = r.betas.filter((b): b is number => b != null);
      const range =
        finite.length >= 2
          ? (Math.max(...finite) - Math.min(...finite)).toFixed(2)
          : "—";
      console.log(`| ${def.shortLabel.padEnd(20)} | ${cells.map((c) => c.padStart(5)).join(" | ")} | ${range.padStart(5)} |`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
