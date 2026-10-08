/**
 * Engine 1 — revision signal research lab (DB-only, ZERO FMP calls; writes
 * NOTHING to production tables). Replays the backfilled Leg-B + TipRanks
 * history onto the weekly price grid, builds a family of candidate signal
 * definitions (PT revision, rating, per-analyst recommendation, orthogonalized,
 * combos, gap), and evaluates each across horizons 1/2/4/8/13/26 weeks with an
 * out-of-sample train/test split. Prints a table and writes
 * logs/revision-signal-lab-<date>.json for review.
 *
 * Two things make the lab the same thing production runs:
 *   - `ptRevOrthZ` is built by `computePtRevOrth`, the exact function scoring
 *     calls, so a lab top-25 and a queue top-25 for a date are identical.
 *   - Forward returns are entry-to-entry on `closeNext` (t+1), the same
 *     convention Validation and the screen rows use. `--entry=close` re-runs
 *     the same evaluation on same-day entry to quantify the embargo's cost.
 *
 * Usage:
 *   npx tsx scripts/revision-signal-lab.ts
 *   npx tsx scripts/revision-signal-lab.ts --train-end=2025-06-30 --train-start=2024-01-01
 *   npx tsx scripts/revision-signal-lab.ts --entry=close    # t entry (diagnostic)
 *   npx tsx scripts/revision-signal-lab.ts --tickers=AAPL,MSFT   # smoke subset
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { prisma } from "../src/infrastructure/db/client";
import { REVISION_THRESHOLDS } from "../src/lib/revision/config";
import { resolvePeerGroups, type RefClassification } from "../src/lib/revision/aggregate";
import {
  reconstructPtPanels,
  weeklyNetActions,
  type PtPanel,
} from "../src/lib/revision/legb-history";
import { loadWeeklyGrid } from "../src/server/services/revision/price-ingest.service";
import { loadPriceTargetEvents } from "../src/server/services/revision/legb-weekly.service";
import { extractForwardFiscalDate } from "../src/server/services/revision/revision-scoring.service";
import {
  BASE_CANDIDATES,
  buildTickerCandidates,
  comboZ,
  evaluateZSeries,
  orthogonalizeZ,
  peerZSeries,
  rollWeekShare,
  type HorizonReport,
  type LabTickerInput,
  type RecoEventLike,
} from "../src/lib/revision/signal-lab";
import { computePtRevOrth } from "../src/lib/revision/orthogonalize";
import { loadMarketCaps } from "../src/server/services/revision/revision-rank.service";
import { forwardReturns } from "../src/lib/revision/prices";
import { spearman } from "../src/lib/revision/backtest";
import {
  cutStats,
  nextPrintOutcome,
  queueOverlap,
  survivorshipNote,
  topKPrecision,
  type FunnelWeek,
} from "../src/lib/revision/funnel-metrics";

const HORIZONS = [1, 2, 4, 8, 13, 26];
/** Headline horizon for the funnel metrics (the second is reported alongside). */
const FUNNEL_HORIZONS = [4, 13];
const TOP_K = 25;
const DAY_MS = 86_400_000;
const CHUNK = 200;

function opt(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : undefined;
}
function isoOf(d: Date): string {
  return d.toISOString().slice(0, 10);
}
const recoScore = (r: string | null): number | null =>
  r === "buy" ? 1 : r === "hold" ? 0 : r === "sell" ? -1 : null;

async function main() {
  const log = (m: string) => console.log(m);
  const trainEnd = opt("train-end") ?? "2025-06-30";
  const trainStart = opt("train-start") ?? "2024-01-01";
  const tickerArg = opt("tickers");
  const staleDays = REVISION_THRESHOLDS.ptReconStaleDays;

  const grid = await loadWeeklyGrid(REVISION_THRESHOLDS.priceBackfillWeeks);
  if (grid.length === 0) {
    log("[lab] no grid; aborting");
    return;
  }
  const gridIdx = new Map(grid.map((d, i) => [d, i]));

  const refs = await prisma.revisionReference.findMany({
    where: { isActive: true },
    select: { ticker: true, sector: true, subsector: true },
  });
  let tickers = refs.map((r) => r.ticker);
  if (tickerArg) {
    const want = new Set(tickerArg.split(",").map((s) => s.trim().toUpperCase()));
    tickers = tickers.filter((t) => want.has(t));
  }
  const peerGroups = resolvePeerGroups(refs as RefClassification[]);
  const peerOf = new Map([...peerGroups.entries()].map(([t, g]) => [t, g.peerGroupKey]));
  log(`[lab] ${tickers.length} tickers, ${grid.length} grid weeks (${grid[0]} .. ${grid[grid.length - 1]}); train ≤ ${trainEnd}, test > ${trainEnd}`);

  // Weekly closes, t+1 entries and trailing 4w returns per ticker.
  const blank = () => new Map<string, Array<number | null>>(tickers.map((t) => [t, new Array<number | null>(grid.length).fill(null)]));
  const closeByTicker = blank();
  const entryByTicker = blank();
  const ret4wByTicker = blank();
  const presentByWeek: Array<Set<string>> = grid.map(() => new Set<string>());
  const priceRows = await prisma.revisionPriceSnapshot.findMany({
    select: { ticker: true, snapshotDate: true, close: true, closeNext: true, ret4w: true },
  });
  for (const r of priceRows) {
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w === undefined || !closeByTicker.has(r.ticker)) continue;
    if (r.close !== null) closeByTicker.get(r.ticker)![w] = r.close;
    if (r.closeNext !== null) entryByTicker.get(r.ticker)![w] = r.closeNext;
    if (r.ret4w !== null) ret4wByTicker.get(r.ticker)![w] = r.ret4w;
    if (r.close !== null) presentByWeek[w]!.add(r.ticker);
  }
  // `--entry=close` measures same-day entry to show what the t+1 embargo costs.
  const entryMode = opt("entry") === "close" ? "close" : "closeNext";
  const entrySeries = entryMode === "close" ? closeByTicker : entryByTicker;

  // Reconstruct per-ticker primitives (PT panels, netUpDown, reco events) — chunked.
  const eventsFrom = new Date(new Date(`${grid[0]}T00:00:00Z`).getTime() - (staleDays + 14) * DAY_MS);
  const gridEnd = new Date(`${grid[grid.length - 1]}T23:59:59Z`);
  const inputs = new Map<string, LabTickerInput>();
  for (let i = 0; i < tickers.length; i += CHUNK) {
    const chunk = tickers.slice(i, i + CHUNK);
    const [ratings, targets, reco] = await Promise.all([
      prisma.ratingEvent.findMany({ where: { ticker: { in: chunk }, eventDate: { gte: eventsFrom, lte: gridEnd } }, select: { ticker: true, eventDate: true, action: true } }),
      loadPriceTargetEvents(chunk, eventsFrom, gridEnd),
      prisma.tipRanksRatingEvent.findMany({ where: { ticker: { in: chunk }, ratingDate: { gte: eventsFrom, lte: gridEnd }, expertUID: { not: null }, recommendation: { not: null } }, select: { ticker: true, ratingDate: true, expertUID: true, recommendation: true } }),
    ]);
    const ratingsBy = new Map<string, Array<{ dateIso: string; action: string | null }>>();
    for (const r of ratings) {
      const e = { dateIso: isoOf(r.eventDate), action: r.action };
      const arr = ratingsBy.get(r.ticker);
      if (arr) arr.push(e);
      else ratingsBy.set(r.ticker, [e]);
    }
    const recoBy = new Map<string, RecoEventLike[]>();
    for (const r of reco) {
      const s = recoScore(r.recommendation);
      if (s === null || !r.expertUID) continue;
      const e: RecoEventLike = { dateIso: isoOf(r.ratingDate), key: r.expertUID, score: s };
      const arr = recoBy.get(r.ticker);
      if (arr) arr.push(e);
      else recoBy.set(r.ticker, [e]);
    }
    for (const ticker of chunk) {
      const pt = targets.get(ticker) ?? { events: [], droppedFmp: 0 };
      const panels: PtPanel[] = reconstructPtPanels(pt.events, grid, staleDays);
      const net = weeklyNetActions(ratingsBy.get(ticker) ?? [], grid);
      inputs.set(ticker, {
        ticker,
        panels,
        netUpDown: net.map((w) => w.net),
        recoEvents: recoBy.get(ticker) ?? [],
        closes: closeByTicker.get(ticker) ?? new Array(grid.length).fill(null),
      });
    }
    log(`[lab] reconstructed ${Math.min(i + CHUNK, tickers.length)}/${tickers.length}`);
  }

  // Build raw candidate series per ticker, then peer-z each candidate.
  const rawByCandidate = new Map<string, Map<string, Array<number | null>>>();
  for (const name of BASE_CANDIDATES) rawByCandidate.set(name, new Map());
  for (const ticker of tickers) {
    const cands = buildTickerCandidates(inputs.get(ticker)!, grid, staleDays);
    for (const name of BASE_CANDIDATES) rawByCandidate.get(name)!.set(ticker, cands[name]!);
  }
  const zByCandidate = new Map<string, Map<string, Array<number | null>>>();
  for (const name of BASE_CANDIDATES) {
    zByCandidate.set(name, peerZSeries(rawByCandidate.get(name)!, tickers, peerOf, grid.length));
  }

  const ret4wZ = peerZSeries(ret4wByTicker, tickers, peerOf, grid.length);

  // Cross-sectional derived candidates.
  const ptZ = zByCandidate.get("pt_matched_1w")!;
  const pt4wZ = zByCandidate.get("pt_matched_4w")!;
  const rtgZ = zByCandidate.get("rating_net_1w")!;
  zByCandidate.set("pt_matched_1w_orth_ret", orthogonalizeZ(ptZ, ret4wZ, tickers, grid.length));
  zByCandidate.set("pt_matched_4w_orth_ret", orthogonalizeZ(pt4wZ, ret4wZ, tickers, grid.length));
  zByCandidate.set("combo_equal_rtg_pt", comboZ([{ z: rtgZ, weight: 1 }, { z: ptZ, weight: 1 }], tickers, grid.length));
  zByCandidate.set("gap_pt4w_ret4w", comboZ([{ z: pt4wZ, weight: 1 }, { z: ret4wZ, weight: -1 }], tickers, grid.length));

  // THE production rank, built by the same function scoring calls (winsorize ->
  // CS residual vs ret4w -> peer z) over the stored Leg-B revisions. This is
  // what makes a lab top-25 and a live queue top-25 the same list.
  const reconByTicker = blank();
  const legbRows = await prisma.revisionLegBWeekly.findMany({
    select: { ticker: true, snapshotDate: true, ptRevisionRecon: true },
  });
  for (const r of legbRows) {
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w !== undefined && reconByTicker.has(r.ticker)) reconByTicker.get(r.ticker)![w] = r.ptRevisionRecon;
  }
  const rankZ = blank();
  const rankRaw = blank();
  for (let w = 0; w < grid.length; w++) {
    const out = computePtRevOrth(
      tickers.map((t) => ({
        ticker: t,
        ptRevisionRecon: reconByTicker.get(t)![w],
        ret4w: ret4wByTicker.get(t)![w],
      })),
      peerOf,
    );
    for (const t of tickers) {
      const e = out.byTicker.get(t)!;
      rankZ.get(t)![w] = e.z;
      rankRaw.get(t)![w] = e.raw;
    }
  }
  zByCandidate.set("ptRevOrthZ", rankZ);

  // Forward peer-relative returns per horizon, entry-to-entry.
  const forwardByHorizon = new Map<number, Array<Map<string, number>>>();
  let droppedNoEntry = 0;
  for (const h of HORIZONS) {
    const fwdByTicker = new Map<string, Array<number | null>>();
    for (const t of tickers) {
      const f = forwardReturns(entrySeries.get(t)!, h);
      fwdByTicker.set(t, f.values);
      if (h === FUNNEL_HORIZONS[0]) droppedNoEntry += f.dropped;
    }
    const perWeek: Array<Map<string, number>> = [];
    for (let w = 0; w < grid.length; w++) {
      const rel = new Map<string, number>();
      const raw = new Map<string, number>();
      const groups = new Map<string, { sum: number; n: number }>();
      for (const t of tickers) {
        const r = fwdByTicker.get(t)![w];
        if (r == null) continue;
        raw.set(t, r);
        const g = peerOf.get(t) ?? "Unclassified";
        const acc = groups.get(g);
        if (acc) { acc.sum += r; acc.n++; } else groups.set(g, { sum: r, n: 1 });
      }
      for (const [t, r] of raw) {
        const acc = groups.get(peerOf.get(t) ?? "Unclassified")!;
        rel.set(t, r - acc.sum / acc.n);
      }
      perWeek.push(rel);
    }
    forwardByHorizon.set(h, perWeek);
  }

  // IC-weighted combo (weights fit on TRAIN only, per horizon) — evaluated separately below.
  const evalName = (zmap: Map<string, Array<number | null>>, h: number): HorizonReport =>
    evaluateZSeries(zmap, tickers, grid, forwardByHorizon.get(h)!, h, trainEnd, trainStart);

  const candidateNames = [...zByCandidate.keys()];
  const results: Record<string, Record<number, HorizonReport>> = {};
  for (const name of candidateNames) {
    results[name] = {};
    for (const h of HORIZONS) results[name]![h] = evalName(zByCandidate.get(name)!, h);
  }

  // IC-weighted combo of {rating_net_1w, pt_matched_1w}: weight = max(0, train IC).
  results["combo_icw_rtg_pt"] = {};
  for (const h of HORIZONS) {
    const wRtg = Math.max(0, results["rating_net_1w"]![h]!.train.meanIC ?? 0);
    const wPt = Math.max(0, results["pt_matched_1w"]![h]!.train.meanIC ?? 0);
    const combo = wRtg + wPt > 0
      ? comboZ([{ z: rtgZ, weight: wRtg }, { z: ptZ, weight: wPt }], tickers, grid.length)
      : comboZ([{ z: rtgZ, weight: 1 }, { z: ptZ, weight: 1 }], tickers, grid.length);
    results["combo_icw_rtg_pt"]![h] = evalName(combo, h);
  }

  // ---- Funnel metrics on the production rank ----
  // A universe IC says nothing about the 25 names a user actually reads; these
  // measure the top of the list against a random basket of the same size.
  const funnelWeeks = (h: number): FunnelWeek[] => {
    const fwd = forwardByHorizon.get(h)!;
    return grid.map((date, w) => {
      const score = new Map<string, number>();
      for (const t of tickers) {
        const z = rankZ.get(t)![w];
        if (z !== null && Number.isFinite(z)) score.set(t, z);
      }
      return { date, score, forward: fwd[w]! };
    });
  };

  // Cap tercile (today's market cap — a known limitation, there is no
  // point-in-time cap) and coverage tercile (that week's live analyst panel).
  const capByTicker = await loadMarketCaps();
  const tercile = (v: number, cuts: [number, number]) => (v <= cuts[0] ? "LOW" : v <= cuts[1] ? "MID" : "HIGH");
  const capValues = [...capByTicker.values()].sort((a, b) => a - b);
  const capCuts: [number, number] = [
    capValues[Math.floor(capValues.length / 3)] ?? 0,
    capValues[Math.floor((2 * capValues.length) / 3)] ?? 0,
  ];
  const panelByTicker = blank();
  for (const r of await prisma.revisionLegBWeekly.findMany({ select: { ticker: true, snapshotDate: true, ptPanelSize: true } })) {
    const w = gridIdx.get(isoOf(r.snapshotDate));
    if (w !== undefined && panelByTicker.has(r.ticker)) panelByTicker.get(r.ticker)![w] = r.ptPanelSize;
  }

  // Earnings reports: the post-print window cut and the next-print outcome.
  const reportsByTicker = new Map<string, Array<{ iso: string; beat: boolean | null }>>();
  for (const r of await prisma.earningsSurprise.findMany({
    select: { ticker: true, reportDate: true, epsActual: true, epsEstimated: true },
    orderBy: { reportDate: "asc" },
  })) {
    const a = r.epsActual === null ? null : Number(r.epsActual);
    const e = r.epsEstimated === null ? null : Number(r.epsEstimated);
    const arr = reportsByTicker.get(r.ticker) ?? [];
    arr.push({ iso: isoOf(r.reportDate), beat: a !== null && e !== null ? a > e : null });
    reportsByTicker.set(r.ticker, arr);
  }
  const daysSincePrint = (date: string, ticker: string): number | null => {
    const arr = reportsByTicker.get(ticker);
    if (!arr) return null;
    let last: string | null = null;
    for (const r of arr) {
      if (r.iso <= date) last = r.iso;
      else break;
    }
    if (last === null) return null;
    return Math.round((new Date(`${date}T00:00:00Z`).getTime() - new Date(`${last}T00:00:00Z`).getTime()) / DAY_MS);
  };
  const nextBeat = (date: string, ticker: string): boolean | null =>
    reportsByTicker.get(ticker)?.find((r) => r.iso > date)?.beat ?? null;
  const nextNetUp = (date: string, ticker: string): boolean | null => {
    const w = gridIdx.get(date);
    if (w === undefined || w + 1 >= grid.length) return null;
    const v = reconByTicker.get(ticker)?.[w + 1];
    return v === null || v === undefined ? null : v > 0;
  };

  const funnel: Record<string, unknown> = {};
  for (const h of FUNNEL_HORIZONS) {
    const weeksAt = funnelWeeks(h);
    funnel[`h${h}w`] = {
      topK: topKPrecision(weeksAt, TOP_K, { draws: 1000, seed: 20260916 }),
      overlap: queueOverlap(weeksAt, TOP_K),
      capTerciles: cutStats(
        weeksAt,
        (_d, t) => {
          const c = capByTicker.get(t);
          return c === undefined ? null : `cap:${tercile(c, capCuts)}`;
        },
        spearman,
      ),
      coverageTerciles: cutStats(
        weeksAt,
        (d, t) => {
          const n = panelByTicker.get(t)?.[gridIdx.get(d)!];
          return n === null || n === undefined ? null : `cov:${n <= 4 ? "THIN" : n <= 10 ? "MID" : "DEEP"}`;
        },
        spearman,
      ),
      earningsWindow: cutStats(
        weeksAt,
        (d, t) => {
          const days = daysSincePrint(d, t);
          return days === null ? null : days <= 14 ? "er:0-14d" : "er:rest";
        },
        spearman,
      ),
      nextPrint: nextPrintOutcome(weeksAt, TOP_K, nextBeat, nextNetUp),
    };
  }
  const survivorship = survivorshipNote(
    grid.map((date, w) => ({ date, present: presentByWeek[w]! })),
    new Set(tickers),
    droppedNoEntry,
  );

  // Fiscal-roll diagnostic over the scored Leg-A snapshot weeks.
  const snapRows = await prisma.revisionSnapshot.findMany({ select: { ticker: true, snapshotDate: true, estimatesJson: true }, orderBy: { snapshotDate: "asc" } });
  const fwdFiscalBy = new Map<string, Array<string | null>>();
  const snapDates = [...new Set(snapRows.map((r) => isoOf(r.snapshotDate)))].sort();
  const snapIdx = new Map(snapDates.map((d, i) => [d, i]));
  for (const r of snapRows) {
    const arr = fwdFiscalBy.get(r.ticker) ?? new Array<string | null>(snapDates.length).fill(null);
    arr[snapIdx.get(isoOf(r.snapshotDate))!] = extractForwardFiscalDate(r.estimatesJson);
    fwdFiscalBy.set(r.ticker, arr);
  }
  const roll = rollWeekShare(fwdFiscalBy);

  // ---- Console table (TEST period is the headline) ----
  const fmt = (v: number | null, d = 4) => (v == null ? "  —  " : v.toFixed(d));
  const pct = (v: number | null | undefined, d = 2) => (v == null ? "—" : `${(v * 100).toFixed(d)}%`);
  console.log("\n================ REVISION SIGNAL LAB — TEST period (OOS) ================");
  console.log(`entry ${entryMode} (${entryMode === "closeNext" ? "t+1" : "same-day, diagnostic"})`);
  console.log(`train ${trainStart}..${trainEnd} · test >${trainEnd} · fiscal-roll ticker-weeks ${roll.rollWeeks}/${roll.totalTransitions} (${((roll.rollWeeks / Math.max(1, roll.totalTransitions)) * 100).toFixed(1)}%)`);
  console.log("candidate                     h   testIC   nwT    d10d1%   mono  effW   cov   autoc");
  const rank: Array<{ name: string; h: number; ic: number; nwT: number }> = [];
  for (const name of [...candidateNames, "combo_icw_rtg_pt"]) {
    for (const h of HORIZONS) {
      const r = results[name]![h]!;
      const t = r.test;
      console.log(
        `${name.padEnd(28)} ${String(h).padStart(2)}  ${fmt(t.meanIC).padStart(7)} ${fmt(t.nwT, 2).padStart(5)}  ${fmt((t.d10d1 ?? NaN) * 100, 2).padStart(6)}  ${fmt(t.monotonic, 2).padStart(5)} ${fmt(t.effWeeks, 0).padStart(4)}  ${String(Math.round(r.coverage)).padStart(4)}  ${fmt(r.signalAutocorr, 2).padStart(5)}`,
      );
      if (t.meanIC != null && t.nwT != null) rank.push({ name, h, ic: t.meanIC, nwT: t.nwT });
    }
  }
  rank.sort((a, b) => Math.abs(b.nwT) - Math.abs(a.nwT));
  console.log("\nTop 10 by |NW t| (test):");
  for (const r of rank.slice(0, 10)) console.log(`  ${r.name} @${r.h}w  IC ${r.ic.toFixed(4)}  t ${r.nwT.toFixed(2)}`);

  // ---- Funnel report (the rank, full grid) ----
  console.log(`\n================ FUNNEL — top ${TOP_K} by ptRevOrthZ (full grid) ================`);
  for (const h of FUNNEL_HORIZONS) {
    const f = funnel[`h${h}w`] as {
      topK: ReturnType<typeof topKPrecision>;
      overlap: ReturnType<typeof queueOverlap>;
      capTerciles: ReturnType<typeof cutStats>;
      coverageTerciles: ReturnType<typeof cutStats>;
      earningsWindow: ReturnType<typeof cutStats>;
      nextPrint: ReturnType<typeof nextPrintOutcome>;
    };
    console.log(`\n-- ${h}-week peer-relative outcome (${f.topK.weeks} weeks) --`);
    console.log(
      `  top-${TOP_K} median return ${pct(f.topK.medianReturn)} vs random ${pct(f.topK.randomMedian)} ` +
        `[p5 ${pct(f.topK.randomP5)} .. p95 ${pct(f.topK.randomP95)}] · beats ${pct(f.topK.percentileVsRandom, 1)} of ${f.topK.draws} draws`,
    );
    console.log(`  hit rate ${pct(f.topK.hitRate, 1)} vs random ${pct(f.topK.randomHitRate, 1)}`);
    console.log(`  week-over-week overlap (Jaccard) ${fmt(f.overlap.meanJaccard, 3)} · ${fmt(f.overlap.meanArrivals, 1)} new names/wk`);
    console.log(
      `  next print: ${pct(f.nextPrint.surpriseBeatRate, 1)} beat (universe ${pct(f.nextPrint.baseSurpriseBeatRate, 1)}) · ` +
        `${pct(f.nextPrint.followThroughRate, 1)} still net-up next week (universe ${pct(f.nextPrint.baseFollowThroughRate, 1)})`,
    );
    for (const [label, cuts] of [
      ["cap", f.capTerciles],
      ["coverage", f.coverageTerciles],
      ["earnings window", f.earningsWindow],
    ] as const) {
      console.log(
        `  ${label}: ` +
          cuts.map((c) => `${c.label} IC ${fmt(c.meanIC, 3)} (n=${c.tickerWeeks}, top-decile ${pct(c.topDecileShare, 0)})`).join(" · "),
      );
    }
  }
  console.log(
    `\nsurvivorship: ${survivorship.labUniverse} tickers in the lab universe; ` +
      `mean ${fmt(survivorship.meanMissing, 0)} absent per grid week (delisted names are NOT backfilled — the stats never see their outcome); ` +
      `${survivorship.droppedNoEntry} ticker-weeks dropped for want of a tradeable t+1 entry`,
  );

  mkdirSync("logs", { recursive: true });
  const outPath = `logs/revision-signal-lab-${entryMode}-${isoOf(new Date())}.json`;
  writeFileSync(
    outPath,
    JSON.stringify(
      {
        meta: {
          trainStart,
          trainEnd,
          entryMode,
          grid: { from: grid[0], to: grid[grid.length - 1], weeks: grid.length },
          tickers: tickers.length,
          horizons: HORIZONS,
          fiscalRoll: roll,
        },
        results,
        funnel,
        survivorship: { ...survivorship, missingByDate: undefined },
      },
      null,
      2,
    ),
  );
  console.log(`\n[lab] wrote ${outPath}`);
}

main()
  .catch((e) => {
    console.error("[revision-signal-lab] fatal:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
