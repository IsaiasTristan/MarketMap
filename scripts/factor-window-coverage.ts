/**
 * One-shot diagnostic for the per-stock visible-window shortfall.
 *
 * Symptom: per-stock detail panel shows "visible 235/252" instead of 252;
 * the geometric headline `exp(Σ y_log) − 1` therefore compounds across
 * fewer days than a broker / Google "1Y return" figure.
 *
 * Strategy: walk the trailing N trading days (default 252, ~ 1Y), and for
 * each candidate date classify it as one of:
 *   • KEPT             — stock + every MACRO14 factor + RF all present
 *   • STOCK_MISSING    — Security has no PriceHistory row that day
 *   • FACTOR_MISSING:X — at least one MACRO14 factor X has no FactorReturnDaily
 *   • RF_MISSING       — RF row absent (currently treated as 0 by readers,
 *                        so doesn't drop, but reported here for visibility)
 *
 * The candidate trading-day set is the union of (a) the ticker's
 * PriceHistory dates and (b) every FactorReturnDaily date in the window —
 * Mon-Fri only is unreliable around holidays, so we take the actual data
 * union to avoid false positives.
 *
 * Read-only. No writes. Mirrors the style of factor-freshness-check.ts.
 *
 * Usage: `npx tsx scripts/factor-window-coverage.ts [TICKER] [WINDOW]`
 *   defaults: INTC, 252.
 */
import { prisma } from "../src/infrastructure/db/client";
import { MACRO14_FACTORS } from "../src/lib/factors/definitions/model-presets";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function main() {
  const ticker = (process.argv[2] ?? "INTC").toUpperCase();
  const windowDays = Number.parseInt(process.argv[3] ?? "252", 10);

  // 1. Resolve security id.
  const sec = await prisma.security.findUnique({
    where: { ticker },
    select: { id: true, ticker: true, name: true, isActive: true },
  });
  if (!sec) {
    console.error(`[coverage] Security not found: ${ticker}`);
    process.exit(1);
  }
  console.log(`[coverage] ticker=${sec.ticker} (${sec.name}, active=${sec.isActive})  windowDays=${windowDays}`);

  // 2. Latest factor day defines our reference end (matches what
  //    detectFactorStaleness uses as "today" inside the regression).
  const latestFactorRow = await prisma.factorReturnDaily.findFirst({
    orderBy: { tradeDate: "desc" },
    select: { tradeDate: true },
  });
  const latestStockRow = await prisma.priceHistory.findFirst({
    where: { securityId: sec.id },
    orderBy: { tradeDate: "desc" },
    select: { tradeDate: true },
  });
  if (!latestFactorRow || !latestStockRow) {
    console.error(`[coverage] missing latest data: factor=${latestFactorRow} stock=${latestStockRow}`);
    process.exit(1);
  }
  // Use the *earlier* of the two latest dates so we don't ask about days
  // that no source has yet (otherwise everything trailing would be marked
  // missing on whichever side hadn't published).
  const referenceEnd =
    latestFactorRow.tradeDate < latestStockRow.tradeDate
      ? latestFactorRow.tradeDate
      : latestStockRow.tradeDate;
  console.log(
    `[coverage] reference end = ${isoDay(referenceEnd)}  ` +
      `(factor latest ${isoDay(latestFactorRow.tradeDate)}, stock latest ${isoDay(latestStockRow.tradeDate)})`,
  );

  // 3. Pull the union of candidate dates: every day in the window where
  //    EITHER stock OR any factor has a row. This is the largest possible
  //    sample the timeseries service would consider — if a date has
  //    neither, the regression would never look at it anyway.
  const stockDates = await prisma.priceHistory.findMany({
    where: {
      securityId: sec.id,
      tradeDate: { lte: referenceEnd },
    },
    orderBy: { tradeDate: "desc" },
    take: windowDays + 100, // small overshoot to be safe
    select: { tradeDate: true },
  });
  const stockDateSet = new Set(stockDates.map((r) => isoDay(r.tradeDate)));

  // The factor matrix is the source of truth for what trading days exist —
  // it includes US equity holidays correctly because Yahoo / KF don't
  // publish on those days either.
  const factorRows = await prisma.factorReturnDaily.findMany({
    where: {
      tradeDate: { lte: referenceEnd },
      factorCode: { in: [...MACRO14_FACTORS, "RF"] },
    },
    orderBy: { tradeDate: "desc" },
    select: { tradeDate: true, factorCode: true },
  });

  // Build per-factor presence map and the master ordered date list.
  const datesSeen = new Set<string>();
  const presentByFactor: Record<string, Set<string>> = {};
  for (const code of [...MACRO14_FACTORS, "RF"]) presentByFactor[code] = new Set();
  for (const r of factorRows) {
    const d = isoDay(r.tradeDate);
    datesSeen.add(d);
    presentByFactor[r.factorCode]?.add(d);
  }
  for (const d of stockDateSet) datesSeen.add(d);

  // 4. Take the trailing `windowDays` candidate dates ending at referenceEnd.
  const orderedAll = [...datesSeen].sort(); // ascending
  const tail = orderedAll.slice(Math.max(0, orderedAll.length - windowDays));
  const tailStart = tail[0];
  const tailEnd = tail[tail.length - 1];
  console.log(
    `[coverage] candidate window: ${tailStart} → ${tailEnd}  (${tail.length} candidate days)`,
  );

  // 5. Classify each date with full stock + per-factor presence.
  const dropped: {
    date: string;
    dow: string;
    stockOk: boolean;
    rfOk: boolean;
    missingFactors: string[];
    presentFactors: string[];
  }[] = [];
  let kept = 0;
  for (const d of tail) {
    const stockOk = stockDateSet.has(d);
    const missingFactors = MACRO14_FACTORS.filter((c) => !presentByFactor[c]!.has(d));
    const presentFactors = MACRO14_FACTORS.filter((c) => presentByFactor[c]!.has(d));
    const rfOk = presentByFactor.RF!.has(d);
    if (stockOk && missingFactors.length === 0 && rfOk) {
      kept++;
      continue;
    }
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T12:00:00Z").getUTCDay()];
    dropped.push({ date: d, dow, stockOk, rfOk, missingFactors, presentFactors });
  }

  // 6. Print summary.
  console.log("");
  console.log(`[coverage] result: ${kept} KEPT  /  ${dropped.length} DROPPED  (of ${tail.length} candidate days)`);

  // Classify each dropped row into a higher-level bucket.
  let stockOnly = 0;
  let factorOnly = 0;
  let bothMissing = 0;
  let rfOnly = 0;
  let phantomCalendar = 0; // weekend / non-equity-trading day where SOME factor still wrote a row
  for (const r of dropped) {
    const isWeekend = r.dow === "Sat" || r.dow === "Sun";
    if (isWeekend) phantomCalendar++;
    else if (!r.stockOk && r.missingFactors.length === 0) stockOnly++;
    else if (r.stockOk && r.missingFactors.length > 0) factorOnly++;
    else if (!r.stockOk && r.missingFactors.length > 0) bothMissing++;
    else if (r.stockOk && r.missingFactors.length === 0 && !r.rfOk) rfOnly++;
  }
  console.log("");
  console.log("[coverage] dropped bucket summary:");
  console.log(`  ${String(stockOnly).padStart(4)}  STOCK_MISSING only  (factor matrix complete; ticker ingest gap)`);
  console.log(`  ${String(factorOnly).padStart(4)}  FACTOR_MISSING only (stock present; one+ factors short of the date)`);
  console.log(`  ${String(bothMissing).padStart(4)}  BOTH MISSING       (US equity holiday with phantom factor rows from AQR/FRED)`);
  console.log(`  ${String(phantomCalendar).padStart(4)}  WEEKEND_PHANTOM    (Sat/Sun phantom row; should never have been written)`);
  console.log(`  ${String(rfOnly).padStart(4)}  RF_ONLY_MISSING    (non-dropping; readers default to 0)`);

  console.log("");
  console.log("[coverage] dropped dates (date, dow, stock?, RF?, missing factors):");
  for (const r of dropped) {
    const stockMark = r.stockOk ? "stk" : "-  ";
    const rfMark = r.rfOk ? "rf" : "- ";
    const missList = r.missingFactors.length === MACRO14_FACTORS.length ? "ALL" : r.missingFactors.join(",");
    console.log(`  ${r.date} ${r.dow}  ${stockMark} ${rfMark}  missing=${missList}`);
  }

  // 7. Verdict.
  console.log("");
  const realDrops = stockOnly + factorOnly + bothMissing;
  if (realDrops === 0 && phantomCalendar === 0) {
    console.log(`[coverage] VERDICT: clean (${tail.length}/${tail.length}).`);
  } else if (phantomCalendar > stockOnly + factorOnly) {
    console.log(
      `[coverage] VERDICT: PHANTOM_CALENDAR dominates (${phantomCalendar} weekend/phantom dates) — ` +
        `the FRED RF back-fill or AQR ingest wrote rows on non-equity-trading days. ` +
        `Real ingestion gaps: ${stockOnly} stock + ${factorOnly} factor.`,
    );
  } else if (stockOnly > factorOnly + bothMissing) {
    console.log(`[coverage] VERDICT: STOCK-SIDE dominates (${stockOnly} stock vs ${factorOnly + bothMissing} factor).`);
  } else {
    console.log(
      `[coverage] VERDICT: FACTOR-SIDE dominates (${factorOnly + bothMissing} factor vs ${stockOnly} stock). ` +
        `Inspect the missing-factors lists above for the laggard.`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
