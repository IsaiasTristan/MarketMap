/**
 * One-shot read-only reconciliation script for INTC's per-stock detail
 * panel: pins down where the +311.61% Cumulative Excess (geom.) headline
 * sits relative to Google's +302.58% 1Y total return.
 *
 * Mirrors the math in factor-per-stock-timeseries.service.ts:
 *   • Loads adjClose from PriceHistory (same source the service uses).
 *   • Loads RF from FactorReturnDaily directly (stored as daily simple
 *     decimal — same units convention as every other code in the table).
 *   • Walks the same extendedWindowDates → aligned → trailing-window slice.
 *   • Computes:
 *       headline    = exp(Σ ln(1+r_stock) - Σ ln(1+r_f)) - 1
 *       Total ≈     = exp(Σ ln(1+r_stock)) - 1
 *       RF compounded = exp(Σ ln(1+r_f)) - 1
 *
 * Then reports endpoint adjClose values for the spot-check, the RF-row
 * count in the visible window for the coverage SQL, and the dropped
 * dates that fall inside the visible region (so we can quantify their
 * impact on the displayed compound).
 *
 * Read-only. No writes. Mirrors the style of factor-window-coverage.ts.
 *
 * Usage: `npx tsx scripts/factor-intc-reconcile.ts [TICKER] [WINDOW] [ROLLING]`
 *   defaults: INTC, 252, 60.
 */
import { prisma } from "../src/infrastructure/db/client";
import { MACRO14_FACTORS } from "../src/lib/factors/definitions/model-presets";

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function pct(v: number, decimals = 2): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(decimals)}%`;
}

async function main() {
  const ticker = (process.argv[2] ?? "INTC").toUpperCase();
  const windowDays = Number.parseInt(process.argv[3] ?? "252", 10);
  const rollingDays = Number.parseInt(process.argv[4] ?? "60", 10);

  console.log(`[reconcile] ticker=${ticker}  windowDays=${windowDays}  rollingDays=${rollingDays}`);

  const sec = await prisma.security.findUnique({
    where: { ticker },
    select: { id: true, ticker: true, name: true },
  });
  if (!sec) {
    console.error(`[reconcile] Security not found: ${ticker}`);
    process.exit(1);
  }

  // 1. Load factor matrix the same way loadFactorMatrix does.
  const factorRows = await prisma.factorReturnDaily.findMany({
    where: { factorCode: { in: [...MACRO14_FACTORS, "RF"] } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, factorCode: true, value: true },
  });

  const factorByDate = new Map<string, Record<string, number>>();
  const rfByDate = new Map<string, number>();
  const allDatesSet = new Set<string>();
  for (const row of factorRows) {
    const d = isoDay(row.tradeDate);
    allDatesSet.add(d);
    if (row.factorCode === "RF") {
      // Stored as daily simple decimal (KF native convention); no /252.
      rfByDate.set(d, Number(row.value));
      continue;
    }
    if (!factorByDate.has(d)) factorByDate.set(d, {});
    factorByDate.get(d)![row.factorCode] = Number(row.value);
  }
  const allDates = [...allDatesSet].sort();

  // 2. Same extendedWindowDates calc the service uses.
  const NORM_WARMUP = 60;
  const DATA_BUFFER = 20;
  const requiredHistory = windowDays + rollingDays + NORM_WARMUP + DATA_BUFFER;
  const extendedWindowDates = allDates.slice(-requiredHistory);
  console.log(
    `[reconcile] extended window: ${extendedWindowDates[0]} → ${
      extendedWindowDates[extendedWindowDates.length - 1]
    } (${extendedWindowDates.length} dates)`,
  );

  // 3. Pull priceMap with the same 7-day prepend.
  const winStart = new Date(extendedWindowDates[0]!);
  const winEnd = new Date(extendedWindowDates[extendedWindowDates.length - 1]!);
  winStart.setUTCDate(winStart.getUTCDate() - 7);
  const priceRows = await prisma.priceHistory.findMany({
    where: { securityId: sec.id, tradeDate: { gte: winStart, lte: winEnd } },
    orderBy: { tradeDate: "asc" },
    select: { tradeDate: true, adjClose: true },
  });
  const priceMap = new Map<string, number>();
  for (const r of priceRows) priceMap.set(isoDay(r.tradeDate), Number(r.adjClose));
  console.log(`[reconcile] priceMap loaded: ${priceMap.size} INTC trading days`);

  // 4. Walk the strict-drop loop the same way the service does.
  type Aligned = { date: string; rStock: number; excess: number };
  const aligned: Aligned[] = [];
  const droppedHolidays: string[] = [];
  for (let i = 0; i < extendedWindowDates.length; i++) {
    const d = extendedWindowDates[i]!;
    const dPrev = i === 0 ? null : extendedWindowDates[i - 1]!;
    const cur = priceMap.get(d);
    let prev: number | undefined;
    if (dPrev != null) prev = priceMap.get(dPrev);
    if (prev === undefined) {
      const check = new Date(d);
      for (let lag = 1; lag <= 7 && prev === undefined; lag++) {
        check.setUTCDate(check.getUTCDate() - 1);
        prev = priceMap.get(isoDay(check));
      }
    }
    if (cur == null || prev == null || prev <= 0) {
      droppedHolidays.push(d);
      continue;
    }
    const r = (cur - prev) / prev;
    const rfDaily = rfByDate.get(d) ?? 0;
    const excess = r - rfDaily;

    const dayMap = factorByDate.get(d);
    if (!dayMap) {
      droppedHolidays.push(d);
      continue;
    }
    let dropRow = false;
    for (const code of MACRO14_FACTORS) {
      if (dayMap[code] == null) {
        dropRow = true;
        break;
      }
    }
    if (dropRow) {
      droppedHolidays.push(d);
      continue;
    }
    aligned.push({ date: d, rStock: r, excess });
  }
  console.log(
    `[reconcile] strict-drop: ${aligned.length} kept / ${droppedHolidays.length} dropped (of ${extendedWindowDates.length} extended)`,
  );

  // 5. Compute the visible window slice the same way the service does.
  // burnInIndex = effectiveWindow - 1 = rollingDays - 1 (assuming defaults)
  // displayStartIndex = max(burnInIndex, n - windowDays)
  const n = aligned.length;
  const burnInIndex = rollingDays - 1;
  const displayStartIndex = Math.max(burnInIndex, n - windowDays);
  const visibleObs = n - displayStartIndex;
  console.log(
    `[reconcile] n=${n}  burnInIndex=${burnInIndex}  displayStartIndex=${displayStartIndex}  visibleObs=${visibleObs}`,
  );
  console.log(
    `[reconcile] visible window: ${aligned[displayStartIndex]?.date} → ${aligned[n - 1]?.date}`,
  );

  // 6. Compute headline and Total ≈ over the visible window.
  let sumLogStock = 0;
  let sumLogRf = 0;
  let sumLogExcess = 0;
  let rfCoverageInVisible = 0;
  let rfMissingInVisible = 0;
  for (let i = displayStartIndex; i < n; i++) {
    const a = aligned[i]!;
    const rfDaily = rfByDate.get(a.date) ?? 0;
    sumLogStock += Math.log(1 + a.rStock);
    sumLogRf += Math.log(1 + rfDaily);
    // y_log = ln(1+r_stock) - ln(1+r_f) — matches stockExcessLog
    sumLogExcess += Math.log(1 + a.rStock) - Math.log(1 + rfDaily);
    if (rfByDate.has(a.date)) rfCoverageInVisible++;
    else rfMissingInVisible++;
  }
  const headline = Math.exp(sumLogExcess) - 1;
  const totalGeom = Math.exp(sumLogStock) - 1;
  const rfCum = Math.exp(sumLogRf) - 1;

  console.log("");
  console.log(`[reconcile] === HEADLINE COMPUTATIONS over visible window ===`);
  console.log(`  Headline (excess geom.)  exp(Σ y_log) − 1            = ${pct(headline)}`);
  console.log(`  Total ≈   (sub-line)     exp(Σ ln(1+r_stock)) − 1     = ${pct(totalGeom)}`);
  console.log(`  RF cum.   (compounded)   exp(Σ ln(1+r_f)) − 1         = ${pct(rfCum)}`);
  console.log(`  Identity check: (1+headline)*(1+rfCum) = ${(1 + headline) * (1 + rfCum)}`);
  console.log(`                  (1+totalGeom)          = ${1 + totalGeom}  (should match within 1e-12)`);
  console.log("");
  console.log(`[reconcile] RF coverage inside visible window: ${rfCoverageInVisible} present / ${rfMissingInVisible} missing (of ${visibleObs})`);

  // 7. Identify dropped holidays inside the visible window date range.
  const visStart = aligned[displayStartIndex]?.date ?? "";
  const visEnd = aligned[n - 1]?.date ?? "";
  const droppedInVisible = droppedHolidays.filter((d) => d >= visStart && d <= visEnd);
  console.log("");
  console.log(`[reconcile] dropped dates inside visible window [${visStart} → ${visEnd}]:`);
  for (const d of droppedInVisible) {
    const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(d + "T12:00:00Z").getUTCDay()];
    console.log(`  ${d} ${dow}`);
  }

  // 8. Endpoint spot-checks.
  console.log("");
  console.log(`[reconcile] === endpoint adjClose spot-check (compare to Yahoo Finance) ===`);
  const checkDates = [
    "2025-04-21", "2025-04-22", "2025-04-23", "2025-04-24", "2025-04-25",
    "2025-04-28", "2025-04-29", "2025-04-30", "2025-05-01", "2025-05-02",
    "2025-05-08", // script's candidate-window start
    "...skip...",
    "2026-04-21", "2026-04-22", "2026-04-23", "2026-04-24",
  ];
  for (const d of checkDates) {
    if (d.includes("skip")) {
      console.log(`  ...`);
      continue;
    }
    const p = priceMap.get(d);
    console.log(`  ${d}  adjClose = ${p != null ? p.toFixed(4) : "(missing)"}`);
  }

  // 9. Decision rule output.
  console.log("");
  console.log(`[reconcile] === DECISION RULE ===`);
  const totalGeomPct = totalGeom * 100;
  const headlinePct = headline * 100;
  const diffFromHeadline = Math.abs(totalGeomPct - headlinePct);
  if (diffFromHeadline < 1.0) {
    console.log(
      `  Total ≈ (${totalGeomPct.toFixed(2)}%) ties to headline (${headlinePct.toFixed(2)}%) within 1pp.`,
    );
    console.log(`  → Branch (C): RF is being silently zeroed in the visible window. BUG.`);
  } else if (Math.abs(totalGeomPct - 302.58) < 5) {
    console.log(`  Total ≈ (${totalGeomPct.toFixed(2)}%) ≈ Google's 302.58%.`);
    console.log(`  → Branch (A): perfect tie-out. Headline gap is purely excess-vs-total semantic. NO BUG.`);
  } else {
    console.log(`  Total ≈ (${totalGeomPct.toFixed(2)}%) ≠ Google's 302.58%.`);
    console.log(`  → Branch (B): underlying data total differs from Google's source.`);
    console.log(`     Residual gap = ${(totalGeomPct - 302.58).toFixed(2)}pp.`);
    console.log(`     Likely sources: start-date offset, Yahoo adjClose vs Google price-only, dropped-day impact.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
