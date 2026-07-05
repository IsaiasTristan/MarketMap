/**
 * Rotation module v3 — Part 0 diffusion-asymmetry diagnostic (READ-ONLY).
 *
 * Hypothesis: per-fund active weight changes are ~zero-sum across sectors, but
 * SELLS concentrate (few, large, clear min_vote_bps) while ADDS diffuse (many,
 * small, fall below it) ⇒ diffusion is mechanically biased negative most quarters
 * regardless of regime.
 *
 * Procedure (no new metric code): loop the CURRENT scoring core
 * (buildActiveFlowMetrics + netDiffusionPct) over historical quarters with the
 * live config floors, and per quarter report:
 *   - % of sector rows negative
 *   - mean sector diffusion (simple + participation-weighted)
 *   - cross-sector diffusion sum
 *
 * Probes DB depth first and branches per the plan (>=12 / 4-11 / <4 quarters).
 * "Unclassified" is reported separately (it is a data-quality meter, not a sector).
 *
 *   npx tsx scripts/rotation-diffusion-diagnostic.ts
 */
import { prisma } from "../src/infrastructure/db/client";
import { Prisma } from "@prisma/client";
import {
  buildActiveFlowMetrics,
  netDiffusionPct,
  type SectorMeta,
} from "../src/server/services/institutional/institutional-active-flow.service";
import { signalFundFilter } from "../src/server/services/institutional/institutional-aggregate.service";
import { classifySecurity, UNCLASSIFIED_SECTOR } from "../src/lib/institutional/security-class";
import { participationWeightedMean } from "../src/lib/institutional/stock-rotation";
import { FLOW_LEADERBOARD_CONFIG } from "../src/domain/calculations/flow-leaderboard-config";

// --legacy reproduces the pre-Part-1 board (flat floor, no demeaning) for an
// apples-to-apples before/after. Default reads the live config.
const LEGACY = process.argv.includes("--legacy");

const iso = (d: Date | string): string =>
  (typeof d === "string" ? d : d.toISOString()).slice(0, 10);

/** Build the ticker → {sector, subsector} classification map, mirroring the
 *  aggregate service: LEFT JOIN RevisionReference, run classifySecurity. */
async function buildMeta(): Promise<SectorMeta> {
  const rows = await prisma.$queryRaw<Array<{ ticker: string; sector: string | null; subsector: string | null }>>(Prisma.sql`
    SELECT DISTINCT h.ticker, rr.sector, rr.subsector
    FROM "FundHoldingSnapshot" h
    LEFT JOIN "RevisionReference" rr ON rr.ticker = h.ticker
    WHERE h.shares > 0 AND ${signalFundFilter("h")}`);
  const meta = new Map<string, { sector: string | null; subsector: string | null }>();
  for (const r of rows) {
    const cls = classifySecurity(r.sector, r.subsector);
    meta.set(r.ticker, { sector: cls.groupSector, subsector: cls.groupSubsector });
  }
  return meta;
}

async function allPeriods(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ period: Date }>>(Prisma.sql`
    SELECT DISTINCT h."filingPeriod" AS period
    FROM "FundHoldingSnapshot" h
    WHERE h.shares > 0 AND ${signalFundFilter("h")}
    ORDER BY h."filingPeriod" ASC`);
  return rows.map((r) => iso(r.period));
}

function fmt(n: number, w = 7): string {
  return n.toFixed(1).padStart(w);
}

async function main() {
  const log = (m: string) => console.error(m); // logs to stderr so the table stays clean on stdout

  // ── Probe depth ──────────────────────────────────────────────────────────
  const periods = await allPeriods();
  const q = periods.length;
  console.log("=".repeat(78));
  console.log(`DB PROBE: ${q} signal-tier quarters` + (q ? ` (${periods[0]} → ${periods[q - 1]})` : " — EMPTY"));
  const branch = q >= 12 ? ">=12 (full)" : q >= 4 ? "4-11 (partial, downgraded gate)" : "<4 (insufficient; ACCEPTANCE-PENDING)";
  console.log(`BRANCH: ${branch}`);
  console.log("=".repeat(78));
  if (q < 2) {
    console.log("Fewer than 2 quarters — no adjacent pair to diff. Nothing to compute.");
    console.log("FINDING: percentiles / ghost ticks on the live board are computed from ~no history.");
    return;
  }

  // Last 12 quarters (the diagnostic window). buildActiveFlowMetrics needs the
  // pair before the first reported quarter, so include one extra lead-in period.
  const window = periods.slice(Math.max(0, q - 13));

  const meta = await buildMeta();
  const cfg = FLOW_LEADERBOARD_CONFIG;
  const mv = cfg.min_vote_bps;
  const demean = !LEGACY && cfg.demeaned_diffusion;
  console.log(`MODE: ${LEGACY ? "LEGACY (flat floor, no demean)" : `config (fund_relative_floor=${cfg.fund_relative_floor}, demeaned=${cfg.demeaned_diffusion})`}`);
  const { byGroupPeriod } = await buildActiveFlowMetrics(
    window,
    meta,
    log,
    { name: mv.stock, sector: mv.sector, subsector: mv.subsector },
    LEGACY ? {} : { fundRelativeFloor: cfg.fund_relative_floor, minVoteBpsFloor: cfg.min_vote_bps_floor, voteFrac: cfg.vote_frac },
  );

  // ── Per-quarter sector table ───────────────────────────────────────────────
  // byGroupPeriod key = `${groupType}|${groupKey}|${period}`; we want SECTOR rows,
  // excluding Unclassified (a data-quality meter, not a sector).
  type Row = { key: string; diffusion: number; participating: number };
  const perPeriod = new Map<string, Row[]>();
  const unclassified = new Map<string, Row>();
  for (const [k, stat] of byGroupPeriod) {
    const [type, groupKey, period] = k.split("|");
    if (type !== "SECTOR") continue;
    const row: Row = { key: groupKey, diffusion: netDiffusionPct(stat), participating: stat.fundsParticipating };
    if (groupKey === UNCLASSIFIED_SECTOR) {
      unclassified.set(period, row);
      continue;
    }
    if (!perPeriod.has(period)) perPeriod.set(period, []);
    perPeriod.get(period)!.push(row);
  }

  // Part 1a — demean each quarter's sector diffusions by the participation-weighted
  // cross-sector mean (Unclassified already excluded above). The participation-
  // weighted Σ of deviations is 0 by construction.
  if (demean) {
    for (const rows of perPeriod.values()) {
      const mean = participationWeightedMean(rows.map((r) => ({ value: r.diffusion, weight: r.participating })));
      for (const r of rows) r.diffusion = Math.round((r.diffusion - mean) * 100) / 100;
    }
  }

  const reportPeriods = [...perPeriod.keys()].sort();
  console.log("");
  console.log(`12-QUARTER SECTOR DIFFUSION SIGN TABLE (Unclassified excluded${demean ? ", demeaned" : ""})`);
  console.log("-".repeat(78));
  console.log(
    ["quarter".padEnd(12), "rows".padStart(5), "%neg".padStart(7), "meanDiff".padStart(9), "wMeanDiff".padStart(10), "sumDiff".padStart(9)].join(" "),
  );
  console.log("-".repeat(78));
  let majorityRedCount = 0;
  for (const p of reportPeriods) {
    const rows = perPeriod.get(p)!;
    const nRows = rows.length;
    const nNeg = rows.filter((r) => r.diffusion < 0).length;
    const pctNeg = nRows ? (nNeg / nRows) * 100 : 0;
    const mean = nRows ? rows.reduce((s, r) => s + r.diffusion, 0) / nRows : 0;
    const totP = rows.reduce((s, r) => s + r.participating, 0);
    const wMean = totP ? rows.reduce((s, r) => s + r.diffusion * r.participating, 0) / totP : 0;
    const sum = rows.reduce((s, r) => s + r.diffusion, 0);
    if (pctNeg >= 50) majorityRedCount++;
    console.log([p.padEnd(12), String(nRows).padStart(5), fmt(pctNeg), fmt(mean, 9), fmt(wMean, 10), fmt(sum, 9)].join(" "));
  }
  console.log("-".repeat(78));

  // ── Interpretation gate ─────────────────────────────────────────────────────
  const nQ = reportPeriods.length;
  console.log("");
  console.log(`INTERPRETATION: ${majorityRedCount}/${nQ} reported quarters are majority-red (>=50% of sector rows negative).`);
  if (nQ >= 12) {
    if (majorityRedCount >= 10) console.log("GATE: >=10/12 majority-red ⇒ STRUCTURAL ASYMMETRY CONFIRMED — execute Part 1.");
    else console.log("GATE: metric breathes across regimes ⇒ SKIP Part 1's changes; add registry note; proceed to Part 2.");
  } else if (nQ >= 4) {
    const allSameSign = majorityRedCount === nQ || majorityRedCount === 0;
    console.log("GATE (downgraded, partial window): a partial window can confirm asymmetry but not that the metric breathes.");
    if (allSameSign) console.log(`  All ${nQ} available quarters are same-sign ⇒ asymmetry case strong — execute Part 1.`);
    else console.log("  Sign varies across available quarters ⇒ Part 1 stays config-gated default-off; full table ACCEPTANCE-PENDING (deeper backfill).");
  } else {
    console.log("GATE: <4 quarters ⇒ real table ACCEPTANCE-PENDING; Part 1 built config-gated default-off; validated on synthetic fixtures only.");
    console.log("FINDING: percentiles / ghost ticks currently render off almost no history.");
  }

  // Unclassified footprint (context; it is excluded from the gate above).
  if (unclassified.size) {
    console.log("");
    console.log("Unclassified row (context — excluded from the sign table):");
    for (const p of [...unclassified.keys()].sort()) {
      const r = unclassified.get(p)!;
      console.log(`  ${p}  diffusion ${fmt(r.diffusion)}  participating ${r.participating}`);
    }
  }
}

main()
  .catch((e) => {
    console.error("[rotation-diffusion-diagnostic] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
