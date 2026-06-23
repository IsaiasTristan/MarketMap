"use client";
/**
 * PerStockDetail — sticky right-side panel showing the full single-stock
 * factor decomposition.
 *
 * Phase 3 lock-ins (2026-04-25):
 *   • UX hierarchy (Q13 lock): 1-large + 3-small headline.
 *       — Large primary: Realised σ (annualised).
 *       — Small secondary: Model-implied σ (ann.) + var-gap badge.
 *       — Small diagnostic: R² (in-sample) + Variance share (Euler).
 *       — Small tertiary: Static alpha (ann.).
 *     A reconciliation strip just below the header restates everything in
 *     one monospace line for at-a-glance scanning.
 *   • Var-gap badge thresholds (Q4 lock):
 *       |Δσ²/σ²_realised| < 2% → no badge
 *       2-5% → neutral chip
 *       ≥ 5% → amber warning chip
 *   • Alpha disambiguation (Q5 lock):
 *       — Headline: "Static alpha (ann.)" = α × 252 from snapshot OLS.
 *       — Waterfall residual cell: "Σ rolling α_t" = Σ α_t over post burn-in.
 *       — Idiosyncratic segment in waterfall: "Unexplained Residual" (Σ ε_t).
 *       — Identity sub-line under waterfall confirms
 *         Σy = Σ(β·r) + Σα + Σε.
 *       — Amber sub-line on alpha row when |Σα|/|Σy| > 0.50.
 *   • Burn-in (Q2 lock): waterfall identity sums skip i < displayStartIndex.
 *   • Multicollinearity flagging (Q7 lock): per-stock κ + per-factor VIF
 *     surfaced in a footer card; factor name tinted amber/red on
 *     waterfall/grid using the same thresholds.
 *   • Rolling-fit failure telemetry (Q3 lock): banner when count > 0 or
 *     droppedDates is non-empty.
 *
 * Identity invariant:
 *   Σ_{i ≥ displayStartIndex} y_i ≡ Σ(β_t · r_t) + Σ α_t + Σ ε_t
 *   to floating-point precision (tested in factor-attribution-identity.test.ts).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  PerStockPeriodSlice,
  PerStockResult,
} from "@/server/services/factor-per-stock.service";
import {
  useAnalysisStore,
  type FactorPeriod,
} from "@/store/analysis";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { pickHeadlineValue } from "@/lib/factors/attribution/headline-picker";
import { StockPriceChart } from "./StockPriceChart";
import type { FactorCode } from "@/types/factors";
import { Waterfall, type WaterfallSegment } from "../shared/Waterfall";
import { FactorInfoIcon } from "../shared/FactorInfoIcon";
import { FactorFreshnessBadge, type FactorFreshnessMode } from "../shared/FactorFreshnessBadge";
import { getUsMarketSession, type MarketSession } from "@/lib/market-map/market-session";
import {
  PerStockTimeSeries,
  isPerStockTimeSeriesPayload,
  type PerStockTimeSeriesPayload,
} from "./PerStockTimeSeries";
import { PredictedActualScatter } from "./PredictedActualScatter";
import { LogModeMethodology } from "./LogModeMethodology";

interface PerStockDetailProps {
  data: PerStockResult;
  selectedTicker: string | null;
  /**
   * Optional surface-level override for the Attribution Period. When set,
   * the panel uses this period for the waterfall instead of the global
   * `factorPeriod` from the store. Used by the market-map popup so opening
   * a stock from the grid always lands on the live 1D decomposition,
   * independent of the Factors-tab Attribution Period control.
   */
  periodOverride?: FactorPeriod;
}

/** Live-1D endpoint response (mirrors the route's discriminated union). */
type LiveOneDay =
  | {
      live: true;
      asOf: string;
      session: MarketSession;
      slice: PerStockPeriodSlice;
      stock: { price: number; prevClose: number; return1D: number };
      missingLegs: string[];
      factorsUsed: FactorCode[];
    }
  | { live: false; reason: string };

function isLiveOneDay(x: unknown): x is LiveOneDay {
  if (!x || typeof x !== "object") return false;
  const o = x as { live?: unknown };
  return o.live === true || o.live === false;
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  padding: "12px 14px 6px",
};

const num = (v: number | null | undefined): number =>
  v == null || !Number.isFinite(v) ? 0 : v;

function vifColor(vif: number): string {
  if (!Number.isFinite(vif)) return "#ef4444";
  if (vif >= 10) return "#ef4444";
  if (vif >= 5) return "#f59e0b";
  return "var(--text-secondary)";
}

function conditionColor(kappa: number): string {
  if (!Number.isFinite(kappa)) return "#ef4444";
  if (kappa >= 100) return "#ef4444";
  if (kappa >= 30) return "#f59e0b";
  return "var(--color-accent)";
}

/**
 * Var-gap badge per Q4 lock-in: <2% no badge, 2-5% neutral, ≥5% amber.
 * Returns null inside the [-2%, +2%] band.
 */
function VarGapBadge({ varGapPct }: { varGapPct: number }) {
  const abs = Math.abs(varGapPct);
  if (!Number.isFinite(varGapPct) || abs < 0.02) return null;
  const isAmber = abs >= 0.05;
  const sign = varGapPct >= 0 ? "+" : "";
  return (
    <span
      title={
        `(model_var − realised_var) / realised_var = ${sign}${(varGapPct * 100).toFixed(1)}%.\n` +
        `Q4 lock-in: |gap| < 2% → no badge, 2-5% → neutral, ≥ 5% → amber.\n\n` +
        (isAmber
          ? `Amber: model variance disagrees with realised by ≥ 5%. Check coverage / β stability.`
          : `Neutral: small model-vs-realised gap (2-5%) — within expected sample noise.`)
      }
      style={{
        display: "inline-block",
        marginLeft: 6,
        padding: "0 6px",
        fontSize: 9,
        fontWeight: 600,
        fontFamily: "var(--font-mono, monospace)",
        background: isAmber ? "rgba(245,158,11,0.15)" : "rgba(255,255,255,0.06)",
        color: isAmber ? "#f59e0b" : "var(--text-secondary)",
        border: `1px solid ${isAmber ? "rgba(245,158,11,0.45)" : "rgba(255,255,255,0.18)"}`,
        verticalAlign: "middle",
      }}
    >
      Δσ² {sign}{(varGapPct * 100).toFixed(1)}%
    </span>
  );
}

export function PerStockDetail({
  data,
  selectedTicker,
  periodOverride,
}: PerStockDetailProps) {
  const [tsMetric, setTsMetric] = useState<"return" | "risk" | "beta">("return");
  const factorTsRollingWindow = useAnalysisStore((s) => s.factorTsRollingWindow);
  const setFactorTsRollingWindow = useAnalysisStore((s) => s.setFactorTsRollingWindow);
  const attributionMode = useAnalysisStore((s) => s.factorAttributionMode);
  const storeAttributionPeriod = useAnalysisStore((s) => s.factorPeriod);
  // Surface-level override (market-map popup defaults to 1D) wins over the
  // global Factors-tab control. The Factors-tab Per-Stock view continues to
  // pass no override so changing the Attribution Period there still flows.
  const attributionPeriod: FactorPeriod = periodOverride ?? storeAttributionPeriod;

  const row = selectedTicker ? data.rows.find((r) => r.ticker === selectedTicker) : null;
  const factors = data.usableFactors;
  const tsRollingWindow = factorTsRollingWindow === "match" ? data.regressionWindow : factorTsRollingWindow;

  // ---------- LIVE 1D wiring -------------------------------------------------
  // When the user is looking at the 1D period and the US market is in regular
  // hours, fetch the live 1D slice for THIS stock so the waterfall reflects
  // TODAY's intraday move instead of the last completed close. Live mode never
  // blocks rendering: any failure (session change, throttle, cache miss) makes
  // the badge fall back to "at close" and the cached slice is used.
  //
  // Session check is re-evaluated every 30s alongside the live fetch so a
  // browser left open through 4 PM ET cleanly drops back to at-close.
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (attributionPeriod !== "1D") return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [attributionPeriod]);
  const liveEnabled =
    attributionPeriod === "1D" && !!selectedTicker && !!row;
  const sessionNow = getUsMarketSession(new Date(now));
  const pollIntervalMs = sessionNow === "REGULAR" ? 30_000 : 5 * 60_000;

  const { data: liveRaw, isFetching: liveFetching } = useQuery<LiveOneDay | null>({
    queryKey: [
      "factor-per-stock-live-1d",
      selectedTicker,
      data.model,
      data.regressionWindow,
    ],
    queryFn: () =>
      fetch(
        `/api/analysis/factors/per-stock/live-1d?ticker=${encodeURIComponent(
          selectedTicker!,
        )}&model=${data.model}&window=${data.regressionWindow}`,
      )
        .then((r) => r.json())
        .then((d) => (isLiveOneDay(d) ? d : null)),
    enabled: liveEnabled,
    refetchInterval: liveEnabled ? pollIntervalMs : false,
    staleTime: pollIntervalMs - 5_000,
  });
  const liveSlice =
    liveRaw && liveRaw.live ? liveRaw.slice : null;
  const liveAsOf = liveRaw && liveRaw.live ? liveRaw.asOf : null;
  const liveSession = liveRaw && liveRaw.live ? liveRaw.session : null;
  const liveBadgeMode: FactorFreshnessMode = liveSlice
    ? liveSession === "REGULAR"
      ? "live"
      : "today-close"
    : liveFetching && liveEnabled
      ? "loading"
      : "at-close";

  const { data: tsRaw, isLoading: tsLoading } = useQuery({
    queryKey: [
      "factor-per-stock-ts",
      selectedTicker,
      data.model,
      data.regressionWindow,
      tsRollingWindow,
    ],
    queryFn: () =>
      fetch(
        `/api/analysis/factors/per-stock/timeseries?ticker=${encodeURIComponent(
          selectedTicker!,
        )}&model=${data.model}&window=${data.regressionWindow}&rollingWindow=${tsRollingWindow}`,
      ).then((r) => r.json()),
    enabled: !!selectedTicker,
    staleTime: 5 * 60_000,
    select: (d: unknown) => (isPerStockTimeSeriesPayload(d) ? d : null),
  });
  const tsData: PerStockTimeSeriesPayload | null = tsRaw ?? null;

  // STATIC-HORIZON-BETA period decomposition (2026-06-21). The waterfall now
  // reads the snapshot row's `periodSlices` — the SAME numbers the grid shows
  // — so the popup and the table tie by construction. Betas + intercept come
  // from the single full-horizon OLS fit; the trailing Attribution Period only
  // restricts the realized contribution sums. The rolling-60d time series
  // below is an illustrative beta-drift chart only.
  //
  // Identity over the slice: Σ y = Σ_f (β_f × Σr_f) + (α × days) + residual,
  // where residual is the plug, so the identity closes by construction.
  // Live 1D slice takes precedence over the cached at-close slice when the
  // server fetched one this refresh interval. Falls back automatically when
  // `liveSlice` is null (session closed / throttle / cache miss / non-1D).
  const periodSlice: PerStockPeriodSlice | null =
    liveSlice ?? row?.periodSlices?.[attributionPeriod] ?? null;
  const logAvailable = periodSlice != null && periodSlice.alphaSumLog != null;
  // Log is the default; fall back to simple only when the log path was
  // strict-dropped for this stock (a daily 1+r ≤ 0 killed ln(1+r)).
  const useLog = attributionMode === "log" && logAvailable;
  const logWantedButUnavailable = attributionMode === "log" && !logAvailable;
  const {
    returnSegments,
    windowAlpha,
    sumLogInner,
    geometricTotalReturn,
    geometricTotalReturnIncRf,
    arithmeticTotalReturn,
    identitySumGap,
    postBurnObs,
    rollingAlphaToTotalRatio,
    windowStartDate,
    windowEndDate,
  } = useMemo(() => {
    const empty = {
      returnSegments: [] as WaterfallSegment[],
      windowAlpha: 0,
      sumLogInner: 0,
      geometricTotalReturn: 0,
      geometricTotalReturnIncRf: null as number | null,
      arithmeticTotalReturn: 0,
      identitySumGap: 0,
      postBurnObs: 0,
      rollingAlphaToTotalRatio: 0,
      windowStartDate: "",
      windowEndDate: "",
    };
    if (!row || !periodSlice || periodSlice.observations <= 0) return empty;

    const returnByFactor = useLog ? periodSlice.returnByFactorLog : periodSlice.returnByFactor;
    const alphaSum = num(useLog ? periodSlice.alphaSumLog : periodSlice.alphaSum);
    const idioSum = num(useLog ? periodSlice.residualSumLog : periodSlice.residualSum);

    const segs: WaterfallSegment[] = [];
    let factorContribTotal = 0;
    for (const code of factors) {
      const v = returnByFactor[code];
      if (v == null || !Number.isFinite(v)) continue;
      factorContribTotal += v;
      const def = getFactorDef(code);
      const beta = num(row.cells[code]?.beta);
      segs.push({
        key: `ret-${code}`,
        label: def.label,
        value: v,
        color: def.color,
        sub: `Static β (horizon) = ${beta >= 0 ? "+" : ""}${beta.toFixed(2)} · β × Σ${useLog ? " ln(1+r)" : " r"} over period`,
        info: { name: def.label, definition: def.description, howCalculated: def.howCalculated },
      });
    }
    segs.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    // Σ y over the period = systematic + alpha + residual (residual is the
    // plug, so this is an exact identity).
    const innerSum = factorContribTotal + alphaSum + idioSum;

    // Simple-space Σ y over the same period — for the methodology popover.
    let simpleSum = num(periodSlice.alphaSum) + num(periodSlice.residualSum);
    for (const code of factors) {
      const sv = periodSlice.returnByFactor[code];
      if (sv != null && Number.isFinite(sv)) simpleSum += sv;
    }

    const idioSeg: WaterfallSegment = {
      key: "idio-ret",
      label: "Unexplained Residual",
      value: idioSum,
      color: "#94a3b8",
      sub: useLog
        ? "Σ y_log − systematic − α (static-β plug over period)"
        : "Σ y − systematic − α (static-β plug over period)",
      info: {
        name: "Unexplained Residual",
        definition:
          "The part of the stock's period return not explained by the static factor loadings or the static alpha — the realized return minus (Σ β × factor return) minus (α × days). Over the full horizon this is ~0 by OLS; over a shorter period it captures what the static fit missed.",
        howCalculated: "realized excess − Σ(β × factor return) − (α × days), over the Attribution Period.",
      },
    };

    const ratio = Math.abs(innerSum) > 1e-9 ? Math.abs(alphaSum) / Math.abs(innerSum) : 0;

    const headline = pickHeadlineValue({
      arithmeticSum: simpleSum,
      logSum: useLog ? innerSum : null,
    });

    // Geometric TOTAL return (incl. RF) over this exact period — the
    // price-based realized total, directly comparable to a broker "1Y return".
    // Available for any period (it's the slice's price-endpoint ratio), shown
    // only in log mode where the excess headline is geometric.
    const totalRet = periodSlice.realizedTotalReturn;
    const geomTotalIncRf =
      useLog && totalRet != null && Number.isFinite(totalRet) ? totalRet : null;

    return {
      returnSegments: [...segs, idioSeg],
      windowAlpha: alphaSum,
      sumLogInner: innerSum,
      geometricTotalReturn: headline.useLog ? headline.geometric! : headline.arithmetic,
      geometricTotalReturnIncRf: geomTotalIncRf,
      arithmeticTotalReturn: simpleSum,
      // Residual is the plug, so the identity closes exactly by construction.
      identitySumGap: innerSum - (factorContribTotal + alphaSum + idioSum),
      postBurnObs: periodSlice.observations,
      rollingAlphaToTotalRatio: ratio,
      windowStartDate: periodSlice.startDate,
      windowEndDate: periodSlice.endDate,
    };
  }, [row, periodSlice, factors, useLog]);

  const riskSegments: WaterfallSegment[] = useMemo(() => {
    if (!row) return [];
    const segs: WaterfallSegment[] = [];
    for (let fi = 0; fi < factors.length; fi++) {
      const code = factors[fi]!;
      const cell = row.cells[code];
      if (!cell) continue;
      const def = getFactorDef(code);
      const vif = row.vif?.[fi];
      const tinted = vifColor(vif ?? 0);
      let sub = `β = ${cell.beta >= 0 ? "+" : ""}${cell.beta.toFixed(2)}`;
      if (vif != null && Number.isFinite(vif) && vif >= 5) {
        sub += ` · VIF ${vif.toFixed(1)}`;
      }
      if (cell.riskContribution < 0 && cell.topCovariers && cell.topCovariers.length > 0) {
        const drivers = cell.topCovariers
          .slice(0, 2)
          .map((d) => `${getFactorDef(d.code).shortLabel} (${d.cov >= 0 ? "+" : ""}${(d.cov * 100).toFixed(2)})`)
          .join(", ");
        sub += ` · driven by ${drivers}`;
      }
      segs.push({
        key: `risk-${code}`,
        label:
          tinted !== "var(--text-secondary)"
            ? `${def.label} ⚠`
            : def.label,
        value: cell.riskContribution,
        color: def.color,
        sub,
      });
    }
    segs.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    return segs;
  }, [row, factors]);

  if (!row) {
    // No selection at all — render the same placeholder as before.
    if (!selectedTicker) {
      return (
        <div
          style={{
            background: "var(--bg-surface)",
            border: "1px solid var(--bg-border)",
            height: "100%",
            minHeight: 400,
            padding: 24,
            color: "var(--text-muted)",
            fontSize: 12,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            textAlign: "center",
          }}
        >
          Select a stock from the grid to see its full β / return / risk breakdown across all factors.
        </div>
      );
    }
    // Selected ticker is not present in the universe-wide factor grid (e.g.
    // insufficient price history for the MACRO14 regression, or filtered out
    // by sector/sub-theme). Surface what we still can — the live price chart
    // — and explain why the factor decomposition is missing so the popup
    // never appears broken when opened from the market map.
    return (
      <div
        style={{
          background: "var(--bg-surface)",
          height: "100%",
          minHeight: 400,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <StockPriceChart ticker={selectedTicker} />
        <div
          role="status"
          style={{
            margin: "12px 14px",
            padding: "10px 12px",
            background: "rgba(245,158,11,0.08)",
            border: "1px solid rgba(245,158,11,0.45)",
            color: "var(--text-secondary)",
            fontSize: 12,
            lineHeight: 1.4,
            fontFamily:
              'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
          }}
        >
          <div style={{ color: "#f59e0b", fontWeight: 600, marginBottom: 4 }}>
            Factor decomposition unavailable for {selectedTicker}
          </div>
          This ticker isn&apos;t in the current {data.model} factor grid
          (likely insufficient price history for the {data.regressionWindow}d
          regression window, or filtered out by a sector / sub-theme picker on
          the Factors tab). The price chart above is live; β / return / risk
          decomposition and the rolling diagnostics will appear once the
          ticker has enough history to fit.
        </div>
      </div>
    );
  }

  // The waterfall now renders from the snapshot row's period slices, so it no
  // longer waits on the rolling time-series fetch.
  const returnWaterfallReady = returnSegments.length > 0;

  // Reconciliation strip values (single line, monospace) — Q13 + Q4 lock.
  const reconLine =
    `Realized vol ${(row.realizedAnnualizedVol * 100).toFixed(1)}%  ·  ` +
    `model vol ${(row.modelImpliedAnnualizedVol * 100).toFixed(1)}%  ` +
    `(Δ ${row.varGapPct >= 0 ? "+" : ""}${(row.varGapPct * 100).toFixed(1)}%)  ·  ` +
    `R² ${(row.rSquared * 100).toFixed(0)}%  ·  ` +
    `sys. var. ${(row.systematicShareEulerAligned * 100).toFixed(0)}%  ·  ` +
    `α ${row.alphaAnnualized >= 0 ? "+" : ""}${(row.alphaAnnualized * 100).toFixed(1)}% ` +
    `± ${(row.alphaCi95Half * 100).toFixed(1)}% (95%)`;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div style={{ padding: "10px 14px 4px", borderBottom: "1px solid var(--bg-border)" }}>
        <div style={{ fontSize: 12, color: "var(--text-primary)", fontWeight: 500 }}>{row.name}</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
          {row.sector} · {row.subTheme}
        </div>
      </div>

      {/* 1-LARGE + 3-SMALL HEADLINE LAYOUT (Q13 lock) */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1.4fr 1fr",
          borderBottom: "1px solid var(--bg-border)",
        }}
      >
        {/* Primary: Realized volatility (annualized) — sample σ of daily excess returns. */}
        <div
          style={{
            padding: "12px 14px",
            borderRight: "1px solid rgba(255,255,255,0.04)",
          }}
          title={
            `Realized volatility (annualized).\n` +
            `Annualized sample standard deviation of DAILY EXCESS RETURNS over the regression-aligned dates ` +
            `(σ̂ × √252, where σ̂ = √Var(y) and y = r_stock − r_f).\n\n` +
            `This is HISTORICAL / SAMPLE volatility of excess returns — NOT a portfolio "total risk" budget ` +
            `and NOT the sum of the variance decomposition below. The decomposition card uses MODEL-IMPLIED ` +
            `variance (β'Σβ + σ²_idio); the Variance gap chip on the right reports model − realized.`
          }
        >
          <div
            style={{
              fontSize: 9,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
              display: "flex",
              alignItems: "center",
            }}
          >
            Realized vol (ann.)
            <FactorInfoIcon
              tip={
                `Annualized sample standard deviation of daily EXCESS returns (stock − RF) ` +
                `over the regression-aligned window:  σ̂_y × √252.\n\n` +
                `Distinct from the variance decomposition below, which is MODEL-implied ` +
                `(β'Σβ + σ²_idio) and decomposes ex-ante variance into systematic + idiosyncratic shares.`
              }
              ariaLabel="Realized volatility methodology"
            />
          </div>
          <div
            style={{
              fontSize: 28,
              fontWeight: 700,
              fontFamily: "var(--font-mono, monospace)",
              color: "var(--text-primary)",
              lineHeight: 1.1,
              marginTop: 2,
            }}
          >
            {(row.realizedAnnualizedVol * 100).toFixed(1)}%
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
            Model-implied vol {(row.modelImpliedAnnualizedVol * 100).toFixed(1)}%
            <VarGapBadge varGapPct={row.varGapPct} />
          </div>
        </div>

        {/* Secondary stack: 3 small cells */}
        <div
          style={{
            display: "grid",
            gridTemplateRows: "1fr 1fr 1fr",
          }}
        >
          <div
            style={{
              padding: "6px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
            }}
            title={
              `Coefficient of determination from the snapshot multivariate OLS over ${row.observations} observations.\n` +
              `Variance share (Euler) = β'Σβ / (β'Σβ + σ²_idio) using Σ recomputed on the regression-aligned dates.\n\n` +
              `Both labelled — they answer DIFFERENT questions (in-sample fit vs covariance-implied share).`
            }
          >
            <div
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              R² (in-sample) · Sys. var. share
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "var(--font-mono, monospace)",
                color: "var(--text-primary)",
                marginTop: 1,
              }}
            >
              {(row.rSquared * 100).toFixed(0)}% · {(row.systematicShareEulerAligned * 100).toFixed(0)}%
              <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>
                (Δ vs full-window {row.systematicShareDelta >= 0 ? "+" : ""}
                {(row.systematicShareDelta * 100).toFixed(0)}pp)
              </span>
            </div>
          </div>
          <div
            style={{
              padding: "6px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.04)",
            }}
            title={
              `(model_var − realised_var) / realised_var.\n` +
              `Phase 3 Q4 thresholds: |gap| < 2% no badge · 2-5% neutral · ≥ 5% amber.`
            }
          >
            <div
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Variance gap (model vs realized)
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "var(--font-mono, monospace)",
                color: Math.abs(row.varGapPct) >= 0.05 ? "#f59e0b" : "var(--text-primary)",
                marginTop: 1,
              }}
            >
              {row.varGapPct >= 0 ? "+" : ""}{(row.varGapPct * 100).toFixed(1)}%
            </div>
          </div>
          <div
            style={{
              padding: "6px 14px",
            }}
            title={(() => {
              // Static alpha pill is mode-aware. Log mode reads the parallel
              // log-space snapshot OLS; simple stays on the original. For
              // high-vol stocks the two can disagree by hundreds of percent
              // (Jensen's inequality on each day's residual).
              const modeAnn =
                attributionMode === "log" ? row.alphaAnnualizedLog : row.alphaAnnualized;
              const modeT =
                attributionMode === "log" ? row.alphaTStatLog : row.alphaTStat;
              const modeCi =
                attributionMode === "log" ? row.alphaCi95HalfLog : row.alphaCi95Half;
              const annNum = modeAnn ?? Number.NaN;
              const tNum = modeT ?? Number.NaN;
              const ciNum = modeCi ?? Number.NaN;
              return (
                `Daily intercept × 252 from the horizon OLS in ${attributionMode} space. t = ${Number.isFinite(tNum) ? tNum.toFixed(2) : "—"}.\n` +
                `This is the SAME fit that drives the waterfall's Alpha bar and the grid ALPHA column — ` +
                `the only difference is units: this headline is the ANNUALIZED RATE (α × 252), while the ` +
                `waterfall/grid show the PERIOD TOTAL (α × days in the Attribution Period). ` +
                `So it is period-independent: changing 1D…1Y does not move it.\n\n` +
                `95 % CI = α ± 1.96 × SE(α) × 252 = ` +
                `${Number.isFinite(annNum) ? (annNum * 100).toFixed(2) : "—"}% ± ${Number.isFinite(ciNum) ? (ciNum * 100).toFixed(2) : "—"}%.\n` +
                `Factor z-scoring does not affect this band — α and SE(α) are in y-units (excess return), and the studentised statistic is invariant to factor reparameterisation. With our typical DOF (≈ 250–365) the exact t-critical ≈ 1.97, so z = 1.96 is essentially equivalent.\n\n` +
                (attributionMode === "log"
                  ? `Log space: the waterfall Alpha bar = this α × days; this headline = α × 252.`
                  : `Simple space: for high-vol stocks this can be wildly larger than the log-space static-α (Jensen's inequality on daily residuals). Switch attribution mode to log to align with the waterfall.`) +
                `\n\nLARGE α may reflect model misspecification rather than skill — check residual scatter for systematic patterns.`
              );
            })()}
          >
            <div
              style={{
                fontSize: 9,
                color: "var(--text-muted)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
              }}
            >
              Static alpha (ann., {attributionMode})
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "var(--font-mono, monospace)",
                color:
                  (attributionMode === "log" ? row.alphaAnnualizedLog : row.alphaAnnualized) ?? 0 >= 0
                    ? "var(--color-positive)"
                    : "var(--color-negative)",
                marginTop: 1,
              }}
            >
              {(() => {
                const ann =
                  attributionMode === "log"
                    ? row.alphaAnnualizedLog
                    : row.alphaAnnualized;
                const t =
                  attributionMode === "log" ? row.alphaTStatLog : row.alphaTStat;
                const ci =
                  attributionMode === "log" ? row.alphaCi95HalfLog : row.alphaCi95Half;
                if (ann == null || !Number.isFinite(ann)) return "—";
                const tStr = t != null && Number.isFinite(t) ? t.toFixed(2) : "—";
                const ciStr =
                  ci != null && Number.isFinite(ci) ? `${(ci * 100).toFixed(2)}%` : "—";
                return (
                  <>
                    {ann >= 0 ? "+" : ""}{(ann * 100).toFixed(2)}%
                    <span
                      style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}
                    >
                      ± {ciStr} (95%) · t = {tStr}
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
        </div>
      </div>

      {/* RECONCILIATION STRIP (Q13 lock) — single monospace line, scannable */}
      <div
        style={{
          padding: "6px 14px",
          background: "rgba(0,0,0,0.25)",
          borderBottom: "1px solid var(--bg-border)",
          fontSize: 10,
          fontFamily: "var(--font-mono, monospace)",
          fontVariantNumeric: "tabular-nums",
          color: "var(--text-secondary)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
        title={
          `Reconciliation strip — primary anchor is realized vol; everything else is reported relative to it.\n` +
          `R² is in-sample fit; "sys. var." is the covariance-implied systematic variance share (Euler ` +
          `decomposition β'Σβ / (β'Σβ + σ²_idio)). They are different concepts (Q1 lock).`
        }
      >
        {reconLine}
      </div>

      {/* WARNING BANNERS (Q3 lock + window fallback + factor freshness) */}
      {(() => {
        const fb = tsData?.windowFallback;
        const rollingPoints = tsData ? Math.max(0, tsData.dates.length - tsData.displayStartIndex) : 0;
        const fallbackSignificant = !!fb && (
          Math.abs(fb.requestedWindow - fb.effectiveWindow) / Math.max(1, fb.requestedWindow) >= 0.05 ||
          rollingPoints < 60
        );
        const stale = data.factorDataStale ?? [];
        const staleCount = stale.length;
        const showBanner =
          fallbackSignificant ||
          (tsData?.rollingFitFailures ?? 0) > 0 ||
          row.droppedDates.length > 0 ||
          staleCount > 0;
        if (!showBanner) return null;
        const staleSummary = staleCount > 0
          ? stale
              .map((s) => `${s.factor} last published ${s.lastDate} (lags ${s.lagTradingDays}d)`)
              .join("\n  ")
          : "";
        return (
        <div
          style={{
            padding: "6px 14px",
            fontSize: 10,
            fontFamily: "var(--font-mono, monospace)",
            color: "var(--color-warning, #f59e0b)",
            background: "rgba(245,158,11,0.06)",
            borderBottom: "1px solid rgba(245,158,11,0.25)",
          }}
          title={
            (fallbackSignificant && tsData?.windowFallback
              ? `Rolling window shrunk from ${tsData.windowFallback.requestedWindow} → ${tsData.windowFallback.effectiveWindow} ` +
                `(${tsData.windowFallback.availableObservations} aligned obs available; reason: ${tsData.windowFallback.reason}). ` +
                `Q1 snapshot tie-out is intentionally relaxed in this case — the snapshot itself runs OLS on whatever ` +
                `aligned obs exist when n < requested window (KF/RF data typically lags Yahoo by a few weeks).\n\n`
              : "") +
            `${tsData?.rollingFitFailures ?? 0} rolling-fit failure(s) (singular X'WX). ` +
            `${row.droppedDates.length} factor cells dropped from snapshot regression because of missing data.\n\n` +
            (staleCount > 0
              ? `STALE FACTOR DATA (${staleCount}):\n  ${staleSummary}\n\n` +
                `Run POST /api/analysis/factors/pipeline-refresh to backfill ETF-proxy splice rows ` +
                `for the missing dates. Without the refresh, the strict drop-row policy silently ` +
                `caps the visible regression sample at the freshest factor's last date — see the ` +
                `factor-data-freshness-guard plan (2026-04-26) for context.\n\n`
              : "") +
            `Phase 3 Q3 lock-in: failed fits skip from cumulative sums (no silent (α=0, ε=y) fallback); ` +
            `missing factor cells drop the row entirely (no silent zero-fill).`
          }
        >
          ⚠
          {fallbackSignificant && tsData?.windowFallback && (
            <span style={{ marginLeft: 6 }}>
              Rolling window {tsData.windowFallback.effectiveWindow}d (requested {tsData.windowFallback.requestedWindow}d, only {tsData.windowFallback.availableObservations} aligned obs)
            </span>
          )}
          {fallbackSignificant && tsData?.windowFallback &&
            ((tsData.rollingFitFailures > 0) || row.droppedDates.length > 0 || staleCount > 0) &&
            " · "}
          {tsData && tsData.rollingFitFailures > 0 && (
            <span style={{ marginLeft: 6 }}>
              {tsData.rollingFitFailures} rolling-fit failure(s)
            </span>
          )}
          {tsData && tsData.rollingFitFailures > 0 && (row.droppedDates.length > 0 || staleCount > 0) && " · "}
          {row.droppedDates.length > 0 && (
            <span style={{ marginLeft: 6 }}>
              {row.droppedDates.length} factor cell(s) dropped from snapshot
            </span>
          )}
          {row.droppedDates.length > 0 && staleCount > 0 && " · "}
          {staleCount > 0 && (
            <span style={{ marginLeft: 6 }}>
              {staleCount} factor{staleCount === 1 ? "" : "s"} stale ({stale[0]!.factor}
              {staleCount > 1 ? ` +${staleCount - 1}` : ""} - run /api/analysis/factors/pipeline-refresh)
            </span>
          )}
        </div>
        );
      })()}

      <div style={{ flex: 1, overflowY: "auto" }}>
        <div style={{ padding: "12px 14px 0" }}>
          <StockPriceChart ticker={row.ticker} />
        </div>
        {tsLoading && !tsData && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--text-muted)" }}>
            Loading rolling factor time series (beta-drift chart)…
          </div>
        )}
        {!tsLoading && !tsData && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--text-muted)" }}>
            Rolling factor time series unavailable for this window — the beta-drift chart below is hidden, but the attribution waterfall above is unaffected.
          </div>
        )}

        {returnWaterfallReady && (
          <div style={{ padding: "12px 14px 4px" }}>
            {logWantedButUnavailable && (
              <div
                style={{
                  marginBottom: 8,
                  padding: "6px 8px",
                  fontSize: 10,
                  fontFamily: "var(--font-mono, monospace)",
                  fontVariantNumeric: "tabular-nums",
                  color: "#f59e0b",
                  background: "rgba(245,158,11,0.08)",
                  border: "1px solid rgba(245,158,11,0.30)",
                }}
                title={
                  `Log attribution path (Path B) is unavailable for this window: ` +
                  `at least one daily simple return ≤ -100% killed the ln(1+r) ` +
                  `domain check. Falling back to arithmetic Σ y_simple. ` +
                  `Note: this number is the sum of daily simple excess returns, ` +
                  `NOT a compounded total return — multi-period arithmetic sums ` +
                  `do not reconcile to realised performance.`
                }
              >
                ⚠ Log path unavailable — falling back to arithmetic Σ y_simple. Headline is NOT a compounded total.
              </div>
            )}
            <Waterfall
              title={
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  Excess return attribution
                  <FactorInfoIcon
                    tip={
                      `Attribution Period: ${attributionPeriod} (${postBurnObs} trading days).\n\n` +
                      `STATIC-BETA decomposition: the betas and intercept come from ONE OLS fit ` +
                      `over the full ${data.regressionWindow}-day horizon; the Attribution Period only ` +
                      `restricts the realized sums. Each factor bar = β_horizon × Σ factor return over ` +
                      `the period; Alpha = α × days; the residual is the plug (realized − systematic − α). ` +
                      `These are exactly the numbers in the grid row, so the popup and table tie.\n\n` +
                      `The rolling-60-day betas in the time-series chart below are an illustrative ` +
                      `drift view only — they are NOT used here (a 60-day, 14-factor regression is too ` +
                      `noisy to attribute per-factor returns from).\n\n` +
                      (useLog
                        ? `Headline = exp(Σ y_log) − 1 = compounded geometric excess return over ` +
                          `the period. The per-factor bars are additive in log space only — ` +
                          `exp(component) − 1 of an individual factor does NOT sum to the geometric total.`
                        : `Headline = Σ y_simple — arithmetic sum of daily simple excess returns. ` +
                          `Identity holds but the multi-period sum is NOT a compounded total.`)
                    }
                    ariaLabel="Attribution window methodology"
                  />
                  {attributionPeriod === "1D" && (
                    <FactorFreshnessBadge
                      mode={liveBadgeMode}
                      asOf={liveSlice ? liveAsOf : (windowEndDate || data.asOfDate)}
                      surface="stock"
                      trailing={
                        liveSlice && liveRaw?.live
                          ? `· ${liveRaw.factorsUsed.length}/${data.usableFactors.length} factors`
                          : null
                      }
                    />
                  )}
                </span>
              }
              titleSub={
                windowStartDate && windowEndDate
                  ? `${windowStartDate} — ${windowEndDate} · ${attributionPeriod}`
                  : undefined
              }
              total={sumLogInner}
              totalLabel="Cumulative excess (geom.)"
              segments={returnSegments}
              residual={{
                key: "alpha",
                label: useLog ? "Alpha (α × days, log)" : "Alpha (α × days)",
                value: windowAlpha,
                color: "#f1f5f9",
                sub:
                  rollingAlphaToTotalRatio > 0.5
                    ? `⚠ |α|/|Σy| = ${(rollingAlphaToTotalRatio * 100).toFixed(0)}% — alpha dominates the period return (possible model misspecification)`
                    : `Static intercept × ${postBurnObs} days. Annualized rate = α × 252 = ${(postBurnObs > 0 ? (windowAlpha * 252) / postBurnObs * 100 : 0).toFixed(1)}% (the headline "Static alpha (ann.)" above).`,
              }}
              headlineOverride={
                useLog ? { value: geometricTotalReturn } : undefined
              }
              totalAnnotation={
                useLog ? (
                  <div
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-end",
                      gap: 2,
                    }}
                  >
                    {geometricTotalReturnIncRf != null && (
                      <div
                        title={
                          `Total return = price-based realized return over the ` +
                          `${attributionPeriod} period (${postBurnObs} days) — endpoint ` +
                          `price ratio, dividend-inclusive.\n\n` +
                          `Identity: Σ ln(1 + r_stock) = Σ y_log + Σ ln(1 + r_f).\n` +
                          `So this number adds the RF back onto the ` +
                          `excess headline above, giving a figure directly comparable ` +
                          `to a broker / Google "1Y return" (which quotes total, not excess).\n\n` +
                          `Excess (geom.) = ${(geometricTotalReturn * 100).toFixed(2)}%\n` +
                          `Total  (geom.) = ${(geometricTotalReturnIncRf * 100).toFixed(2)}%\n` +
                          `Δ from RF      = ${((geometricTotalReturnIncRf - geometricTotalReturn) * 100).toFixed(2)} pp`
                        }
                        style={{
                          fontSize: 10,
                          color: "var(--text-secondary)",
                          fontFamily: "var(--font-mono, monospace)",
                          fontVariantNumeric: "tabular-nums",
                          cursor: "help",
                          letterSpacing: "0.02em",
                        }}
                      >
                        Total ≈{" "}
                        <span
                          style={{
                            color:
                              geometricTotalReturnIncRf >= 0
                                ? "var(--color-positive)"
                                : "var(--color-negative)",
                            fontWeight: 600,
                          }}
                        >
                          {geometricTotalReturnIncRf >= 0 ? "+" : ""}
                          {(geometricTotalReturnIncRf * 100).toFixed(1)}%
                        </span>
                      </div>
                    )}
                    <LogModeMethodology
                      sumLog={sumLogInner}
                      geometric={geometricTotalReturn}
                      arithmeticSimple={arithmeticTotalReturn}
                      identityGap={identitySumGap}
                      obsCount={postBurnObs}
                    />
                  </div>
                ) : undefined
              }
            />
            {/* Reconciliation sub-line — single-line identity-passes tick.
                Full formula and residual gap live in the hover so the
                visible row stays clean and Bloomberg-like. */}
            <div
              style={{
                padding: "6px 4px 0",
                fontSize: 10,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono, monospace)",
                fontVariantNumeric: "tabular-nums",
                display: "flex",
                alignItems: "center",
                gap: 4,
              }}
              title={
                useLog
                  ? `Log-space period identity (static-β decomposition):\n` +
                    `  Σ y_log − [Σ(β·Σln(1+r)) + α·days + residual] = ${(identitySumGap * 100).toFixed(4)}%\n` +
                    `Closes by construction (residual is the plug).\n\n` +
                    `Headline reconciliation:\n` +
                    `  Σ y_log = ${(sumLogInner * 100).toFixed(2)}%\n` +
                    `  exp(Σ y_log) − 1 = ${(geometricTotalReturn * 100).toFixed(2)}% (compounded realized excess)\n\n` +
                    `Bars are additive in log space only; exp(component) − 1 of an ` +
                    `individual factor does NOT sum to the geometric headline.`
                  : `Arithmetic period identity (static-β decomposition):\n` +
                    `  Σy − [Σ(β·Σr) + α·days + residual] = ${(identitySumGap * 100).toFixed(4)}%\n` +
                    `Closes by construction (residual is the plug).`
              }
            >
              <span
                style={{
                  color:
                    Math.abs(identitySumGap) < 1e-6
                      ? "var(--color-positive)"
                      : "#f59e0b",
                  fontWeight: 600,
                }}
              >
                {Math.abs(identitySumGap) < 1e-6 ? "✓" : "⚠"}
              </span>
              <span>
                Period identity {Math.abs(identitySumGap) < 1e-6 ? "closes" : "open"}
                {" "}
                {useLog
                  ? `(static β · log space; bars sum to Σ y_log)`
                  : `(static β · arithmetic; residual ${(identitySumGap * 100).toFixed(4)}%)`}
              </span>
            </div>
          </div>
        )}

        <div style={{ padding: "8px 14px 4px" }}>
          <Waterfall
            title={
              <>
                Variance decomposition (model)
                <FactorInfoIcon
                  tip={
                    `Each component is its share of MODEL-IMPLIED total variance ` +
                    `(β'Σβ + σ²_idio), where Σ is the factor covariance matrix recomputed ` +
                    `on the regression-aligned sample. Bars sum to 100% by construction.\n\n` +
                    `Distinct from the realized vol number at the top of the panel, which is ` +
                    `the sample standard deviation of daily excess returns (historical, ` +
                    `not model-implied). The Variance gap chip in the headline reports ` +
                    `(model − realized) / realized.`
                  }
                  ariaLabel="Variance decomposition methodology"
                />
              </>
            }
            total={1}
            totalLabel="100% of model variance"
            formatValue={(v) => `${(v * 100).toFixed(1)}%`}
            totalAnnotation={
              `Realized vol ${(row.realizedAnnualizedVol * 100).toFixed(1)}% · ` +
              `model vol ${(row.modelImpliedAnnualizedVol * 100).toFixed(1)}% · ` +
              `systematic ${(row.systematicShareEulerAligned * 100).toFixed(0)}% / idio ${(row.idiosyncraticShare * 100).toFixed(0)}%`
            }
            segments={riskSegments}
            residual={{
              key: "idio",
              label: "Idiosyncratic (Stock-specific)",
              value: row.idiosyncraticShare,
              color: "#94a3b8",
            }}
          />
        </div>

        <div style={{ padding: "8px 14px 4px" }}>
          <PerStockTimeSeries
            ticker={row.ticker}
            metric={tsMetric}
            onMetricChange={setTsMetric}
            rollingWindowSelection={factorTsRollingWindow}
            onRollingWindowSelectionChange={setFactorTsRollingWindow}
            snapshotWindow={data.regressionWindow}
            data={tsData}
            loading={tsLoading}
          />
        </div>

        <div style={{ padding: "8px 14px 4px" }}>
          <PredictedActualScatter
            data={tsData}
            staticRSquared={row.rSquared}
            loading={tsLoading}
          />
        </div>

        {/* MULTICOLLINEARITY FOOTER (Q7 lock — flag only) */}
        <div style={{ padding: "8px 14px 14px" }}>
          <MulticollinearityFooter row={row} factors={factors} />
        </div>

        {data.coverage.some((c) => c.status !== "OK") && (
          <div style={{ ...sectionTitleStyle, paddingTop: 0 }}>Factors dropped from this window</div>
        )}
        {data.coverage.some((c) => c.status !== "OK") && (
          <div style={{ padding: "0 14px 14px" }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
              {data.coverage
                .filter((c) => c.status !== "OK")
                .map(
                  (c) =>
                    `${getFactorDef(c.code as FactorCode).shortLabel}${
                      c.inceptionDate ? ` (since ${c.inceptionDate})` : ""
                    }`,
                )
                .join(", ")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function MulticollinearityFooter({
  row,
  factors,
}: {
  row: { vif?: number[]; conditionNumber?: number };
  factors: FactorCode[];
}) {
  if (!row.vif || row.vif.length === 0) return null;
  const kappa = row.conditionNumber ?? 0;
  const monoSmall: React.CSSProperties = {
    fontSize: 10,
    fontFamily: "var(--font-mono, monospace)",
    fontVariantNumeric: "tabular-nums",
  };
  return (
    <div
      style={{
        padding: "8px 10px",
        background: "var(--bg-base)",
        border: "1px solid var(--bg-border)",
        ...monoSmall,
        color: "var(--text-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 6,
        }}
      >
        <div
          style={{
            color: "var(--color-accent)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
          }}
          title={
            `Multicollinearity diagnostics on this stock's regression-aligned factor matrix.\n` +
            `VIF_j = (R⁻¹)_jj · κ = √(λmax/λmin) of the correlation matrix.\n` +
            `Phase 3 Q7 lock-in: FLAG ONLY (no rolling-OLS regularization). Amber: VIF≥5 / κ≥30.  Red: VIF≥10 / κ≥100.`
          }
        >
          Multicollinearity (this stock)
        </div>
        <div>
          κ ={" "}
          <span style={{ color: conditionColor(kappa) }}>
            {Number.isFinite(kappa) ? kappa.toFixed(1) : "∞"}
          </span>
          <span style={{ color: "var(--text-muted)", marginLeft: 6 }}>(flag ≥ 30)</span>
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${Math.min(factors.length, 4)}, 1fr)`,
          gap: 4,
        }}
      >
        {factors.map((c, i) => {
          const vif = row.vif?.[i] ?? 0;
          const def = getFactorDef(c);
          return (
            <div
              key={c}
              title={`${def.label} · VIF = ${
                Number.isFinite(vif) ? vif.toFixed(2) : "∞"
              } · 1 = uncorrelated, 5 = moderate, 10 = severe`}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 6,
                padding: "2px 6px",
                background: "rgba(255,255,255,0.02)",
              }}
            >
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--text-muted)",
                }}
              >
                {def.shortLabel}
              </span>
              <span style={{ color: vifColor(vif), fontWeight: 600 }}>
                {Number.isFinite(vif) ? vif.toFixed(1) : "∞"}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
