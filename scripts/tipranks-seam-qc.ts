/**
 * Engine 1 — TipRanks cancellation seam QC (DB-only, zero FMP calls).
 *
 * Simulates a subscription lapse by ignoring every TipRanks row dated after
 * --cutoff, reconstructs the Leg-B price-target signal three ways over the
 * weekly grid, and gates the post-cutoff behaviour:
 *   A  FULL       both sources, no cutoff              (truth)
 *   B  TRUNCATED  TipRanks stops at cutoff, FMP tails  (what cancellation looks like)
 *   C  FMP-ONLY   no TipRanks at all                   (the old world / floor)
 *
 * Gates, evaluated on every week after the cutoff through the full 180-day
 * staleness decay. They test what a SEAM can break — spurious signal, a panel
 * cliff, being worse than the FMP-only world — not the inherent information
 * loss of the sparser source (that is reported, not gated):
 *   G1 floor     Spearman(revB, revA) ≥ Spearman(revC, revA) − 0.10 every week
 *                (cancelling can never leave the signal worse than FMP-only)
 *   G2 carry     mean over the first 4 post-cutoff weeks of rho(B,A) − rho(C,A) ≥ 0
 *                (the retained TipRanks panel keeps adding rank information as it decays)
 *   G3 spurious  share of names with |revB| > 5% while revA == 0 ≤ 1% every week
 *                (panel entry/exit generates no signal — the matched-panel property)
 *   G4 cliff     mean panel size (B) never drops > 25% week-over-week
 *                (the 180-day staleness window decays smoothly, no step)
 * Reported only: xs-mean bias (dominated by market-wide revision waves; the
 * composite is peer z-scored per week so level scale is irrelevant) and obs%
 * (share of A's non-zero revisions B still observes — the cost of cancelling).
 *
 * Usage:
 *   npx tsx scripts/tipranks-seam-qc.ts                         # cutoff = 36 grid weeks before the end
 *   npx tsx scripts/tipranks-seam-qc.ts --cutoff=2025-12-27     # explicit cutoff (grid date)
 *   npx tsx scripts/tipranks-seam-qc.ts --sample=400            # every Nth active ticker
 * Exit code 1 on any gate failure (CI-friendly).
 */
import { prisma } from "../src/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "../src/lib/revision/config";
import { spearmanIC } from "../src/lib/revision/backtest";
import { loadWeeklyGrid } from "../src/server/services/revision/price-ingest.service";
import { reconstructSeries } from "../src/server/services/revision/legb-weekly.service";

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}

const GATES = {
  floorSlack: 0.1,
  carryWeeks: 4,
  spuriousMax: 0.01,
  spuriousJump: 0.05,
  cliffMaxDrop: 0.25,
};

function mean(xs: number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function fmt(v: number | null, dp = 3): string {
  return v === null ? "   —  " : v.toFixed(dp).padStart(6);
}

async function main() {
  const log = (m: string) => console.log(m);
  const grid = await loadWeeklyGrid(REVISION_THRESHOLDS.priceBackfillWeeks);
  if (grid.length < 40) throw new Error(`grid too short (${grid.length} weeks) for a seam experiment`);

  const cutoff = opt("cutoff") ?? grid[Math.max(0, grid.length - 36)]!;
  const cutoffIdx = grid.indexOf(cutoff);
  if (cutoffIdx < 0) throw new Error(`--cutoff=${cutoff} is not a grid date`);

  const active = (
    await prisma.revisionReference.findMany({ where: { isActive: true }, select: { ticker: true }, orderBy: { ticker: "asc" } })
  ).map((r) => r.ticker);
  const sample = Number(opt("sample") ?? active.length);
  const step = Math.max(1, Math.floor(active.length / sample));
  const tickers = active.filter((_, i) => i % step === 0).slice(0, sample);
  log(`[seam-qc] grid ${grid[0]}..${grid[grid.length - 1]} (${grid.length}w) · cutoff ${cutoff} (idx ${cutoffIdx}) · ${tickers.length} tickers`);

  const quiet = () => {};
  const [A, B, C] = await Promise.all([
    reconstructSeries(tickers, grid, quiet),
    reconstructSeries(tickers, grid, quiet, { tipranksCutoff: cutoff }),
    reconstructSeries(tickers, grid, quiet, { excludeTipranks: true }),
  ]);

  const staleWeeks = Math.ceil(REVISION_THRESHOLDS.ptReconStaleDays / 7) + 2;
  const lastIdx = Math.min(grid.length - 1, cutoffIdx + staleWeeks);
  const failures: string[] = [];
  let prevPanelB: number | null = null;
  const carry: number[] = [];

  log("");
  log("week        | meanA   meanB   bias   | rhoBA  rhoCA  | obs%  spur%  | nullA nullB nullC | panelA panelB panelC | mixB");
  log("------------+------------------------+---------------+--------------+-------------------+----------------------+------");
  for (let w = cutoffIdx; w <= lastIdx; w++) {
    const revA: number[] = [];
    const revB: number[] = [];
    const revC: number[] = [];
    const pairsBA: Array<{ signal: number; forwardReturn: number }> = [];
    const pairsCA: Array<{ signal: number; forwardReturn: number }> = [];
    let spurious = 0;
    let nonZeroA = 0;
    let observedB = 0;
    let nullA = 0;
    let nullB = 0;
    let nullC = 0;
    const panelA: number[] = [];
    const panelB: number[] = [];
    const panelC: number[] = [];
    const mixB: number[] = [];
    for (const t of tickers) {
      const a = A.get(t)!;
      const b = B.get(t)!;
      const c = C.get(t)!;
      const ra = a.ptRevisionRecon[w] ?? null;
      const rb = b.ptRevisionRecon[w] ?? null;
      const rc = c.ptRevisionRecon[w] ?? null;
      if (ra === null) nullA++;
      else revA.push(ra);
      if (rb === null) nullB++;
      else revB.push(rb);
      if (rc === null) nullC++;
      else revC.push(rc);
      if (ra !== null && rb !== null) pairsBA.push({ signal: rb, forwardReturn: ra });
      if (ra !== null && rc !== null) pairsCA.push({ signal: rc, forwardReturn: ra });
      if (ra === 0 && rb !== null && Math.abs(rb) > GATES.spuriousJump) spurious++;
      if (ra !== null && ra !== 0) {
        nonZeroA++;
        if (rb !== null && rb !== 0) observedB++;
      }
      panelA.push(a.ptPanelSize[w] ?? 0);
      panelB.push(b.ptPanelSize[w] ?? 0);
      panelC.push(c.ptPanelSize[w] ?? 0);
      const m = b.ptSourceMix[w] ?? null;
      if (m !== null) mixB.push(m);
    }
    const mA = mean(revA);
    const mB = mean(revB);
    const bias = mA !== null && mB !== null ? mB - mA : null;
    const rhoBA = pairsBA.length >= 10 ? spearmanIC(pairsBA) : null;
    const rhoCA = pairsCA.length >= 10 ? spearmanIC(pairsCA) : null;
    const spurRate = spurious / tickers.length;
    const obsRate = nonZeroA > 0 ? observedB / nonZeroA : null;
    const pB = mean(panelB);
    const weeksAfter = w - cutoffIdx;

    log(
      `${grid[w]}${weeksAfter === 0 ? " *" : "  "} | ${fmt(mA, 4)} ${fmt(mB, 4)} ${fmt(bias, 4)} | ${fmt(rhoBA)} ${fmt(rhoCA)} | ` +
        `${obsRate === null ? "  —  " : `${(obsRate * 100).toFixed(0).padStart(4)}%`} ${(spurRate * 100).toFixed(2).padStart(5)}% | ` +
        `${String(nullA).padStart(5)} ${String(nullB).padStart(5)} ${String(nullC).padStart(5)} | ` +
        `${fmt(mean(panelA), 1)} ${fmt(pB, 1)} ${fmt(mean(panelC), 1)} | ${fmt(mean(mixB), 2)}`,
    );

    if (weeksAfter === 0) {
      prevPanelB = pB;
      continue; // cutoff week itself is identical in A and B by construction
    }
    if (rhoBA !== null && rhoCA !== null) {
      if (rhoBA < rhoCA - GATES.floorSlack)
        failures.push(`G1 floor ${grid[w]}: rho(B,A)=${rhoBA.toFixed(3)} < rho(C,A)−0.10=${(rhoCA - 0.1).toFixed(3)}`);
      if (weeksAfter <= GATES.carryWeeks) carry.push(rhoBA - rhoCA);
    }
    if (spurRate > GATES.spuriousMax)
      failures.push(`G3 spurious ${grid[w]}: ${(spurRate * 100).toFixed(2)}% > ${(GATES.spuriousMax * 100).toFixed(0)}%`);
    if (prevPanelB !== null && pB !== null && prevPanelB > 0 && pB / prevPanelB < 1 - GATES.cliffMaxDrop)
      failures.push(`G4 cliff ${grid[w]}: panel ${prevPanelB.toFixed(1)} → ${pB.toFixed(1)} (−${((1 - pB / prevPanelB) * 100).toFixed(0)}%)`);
    prevPanelB = pB;
  }

  const carryMean = mean(carry);
  if (carryMean !== null && carryMean < 0)
    failures.push(`G2 carry: mean rho(B,A)−rho(C,A) over first ${GATES.carryWeeks} weeks = ${carryMean.toFixed(3)} < 0`);

  log("");
  log(`[seam-qc] * = cutoff week. Evaluated ${lastIdx - cutoffIdx} post-cutoff weeks (staleness ${REVISION_THRESHOLDS.ptReconStaleDays}d).`);
  log(`[seam-qc] G2 carry: mean rho(B,A)−rho(C,A) over first ${GATES.carryWeeks} weeks = ${carryMean === null ? "—" : carryMean.toFixed(3)}`);
  log("[seam-qc] obs% = share of names whose true (A) revision was non-zero that the truncated feed (B) still observed as non-zero — the information cost of cancelling.");
  if (failures.length === 0) {
    log("[seam-qc] PASS — all gates hold across the decay window");
  } else {
    log(`[seam-qc] FAIL — ${failures.length} gate breach(es):`);
    for (const f of failures) log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error("[seam-qc] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
