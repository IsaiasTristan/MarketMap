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
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";
import { useAnalysisStore } from "@/store/analysis";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { pickHeadlineValue } from "@/lib/factors/attribution/headline-picker";
import { resolvePeriodSlice } from "@/lib/factors/attribution/period";
import { StockPriceChart } from "./StockPriceChart";
import type { FactorCode } from "@/types/factors";
import { Waterfall, type WaterfallSegment } from "../shared/Waterfall";
import { FactorInfoIcon } from "../shared/FactorInfoIcon";
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

export function PerStockDetail({ data, selectedTicker }: PerStockDetailProps) {
  const [tsMetric, setTsMetric] = useState<"return" | "risk" | "beta">("return");
  const factorTsRollingWindow = useAnalysisStore((s) => s.factorTsRollingWindow);
  const setFactorTsRollingWindow = useAnalysisStore((s) => s.setFactorTsRollingWindow);
  const attributionMode = useAnalysisStore((s) => s.factorAttributionMode);
  const attributionPeriod = useAnalysisStore((s) => s.factorPeriod);

  const row = selectedTicker ? data.rows.find((r) => r.ticker === selectedTicker) : null;
  const factors = data.usableFactors;
  const tsRollingWindow = factorTsRollingWindow === "match" ? data.regressionWindow : factorTsRollingWindow;

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

  // Identity sums (Q2 lock-in: skip burn-in i < displayStartIndex).
  // Path B (default when log series present): bars are decomposed in log
  // space (Σ y_log = Σ(β·x_log) + Σα + Σε); the headline value is the
  // compounded geometric reconciliation exp(Σ y_log) − 1, which ties to
  // realised performance over the visible window.
  // Path A (fallback): used only when the log path was strict-dropped (any
  // 1+r ≤ 0 in the visible window). Identity Σy = Σ(β·r) + Σα + Σε holds
  // daily, but the cumulative arithmetic sum is NOT a compounded total.
  const useLog = tsData?.log != null;
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
    if (!tsData) {
      return {
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
    }
    const displayStartIdx = tsData.displayStartIndex ?? 0;
    const n = tsData.dates.length;
    // Attribution Period slice: restrict the waterfall sums to a trailing
    // sub-window of the visible (post burn-in) range. resolvePeriodSlice over
    // the full chart dates can return an index before the burn-in cut for long
    // periods, so we clamp to displayStartIndex.
    const periodSlice = resolvePeriodSlice(tsData.dates, attributionPeriod);
    const startIdx = Math.max(displayStartIdx, periodSlice.startIndex < 0 ? displayStartIdx : periodSlice.startIndex);
    const isFullVisibleWindow = startIdx === displayStartIdx;
    const factorContrib = useLog ? tsData.log!.factorLogContrib : tsData.factorContrib;
    const alphaSeries = useLog ? tsData.log!.alphaLog : tsData.alpha;
    const residSeries = useLog ? tsData.log!.residualLog : tsData.residual;
    const excessSeries = useLog ? tsData.log!.excessLogReturn : tsData.excessReturn;

    const segs: WaterfallSegment[] = [];
    let factorContribTotal = 0;
    for (const code of factors) {
      const arr = factorContrib[code];
      if (!arr) continue;
      let sum = 0;
      for (let i = startIdx; i < n; i++) sum += num(arr[i]);
      factorContribTotal += sum;
      const def = getFactorDef(code);
      const lastBeta = useLog
        ? num(tsData.log!.rollingBetasLog[code]?.[n - 1] ?? tsData.log!.betasLog[code] ?? 0)
        : num(tsData.rollingBetas[code]?.[n - 1] ?? tsData.betas[code] ?? 0);
      segs.push({
        key: `ret-${code}`,
        label: def.label,
        value: sum,
        color: def.color,
        sub: `Latest rolling β = ${lastBeta >= 0 ? "+" : ""}${lastBeta.toFixed(2)}`,
        info: { name: def.label, definition: def.description, howCalculated: def.howCalculated },
      });
    }
    segs.sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    let alphaSum = 0;
    let idioSum = 0;
    let innerSum = 0;
    let obs = 0;
    for (let i = startIdx; i < n; i++) {
      alphaSum += num(alphaSeries[i]);
      idioSum += num(residSeries[i]);
      innerSum += excessSeries[i] ?? 0;
      obs++;
    }

    // Always compute the legacy arithmetic Σ y_simple over the same window
    // — even in log mode — so the methodology popover can disclose what the
    // old headline used to be without changing the primary view.
    let simpleSum = 0;
    for (let i = startIdx; i < n; i++) {
      simpleSum += tsData.excessReturn[i] ?? 0;
    }

    const idioSeg: WaterfallSegment = {
      key: "idio-ret",
      label: "Unexplained Residual",
      value: idioSum,
      color: "#94a3b8",
      sub: useLog
        ? "Σ ε_log_t = Σ (y_log − ŷ_log) over post burn-in"
        : "Σ ε_t = Σ (actual − predicted) over post burn-in",
      info: {
        name: "Unexplained Residual",
        definition:
          "The part of the stock's return not explained by any factor — the regression residual summed over the window. Large unexplained residual means the factor model captures little of this stock's behavior.",
        howCalculated: "Σ (actual return − predicted return) over the post-burn-in window.",
      },
    };

    const ratio = Math.abs(innerSum) > 1e-9 ? Math.abs(alphaSum) / Math.abs(innerSum) : 0;

    // Single source of truth for the headline display contract — the helper
    // also drives the strict-drop fallback banner when the log path is null.
    const headline = pickHeadlineValue({
      arithmeticSum: simpleSum,
      logSum: useLog ? innerSum : null,
    });

    // Geometric TOTAL return (excess + RF compounded) — directly comparable
    // to broker / Google "1Y return" figures. Only computed in log mode
    // (where the server populated `sumLogTotalVisible` over the same
    // [displayStartIndex, n) window we sum here). Null in fallback Path A
    // where mixing arithmetic excess with RF would not be a valid identity.
    // `sumLogTotalVisible` is precomputed over the FULL visible window only,
    // so the RF-inclusive total is valid only when the period slice spans that
    // whole window. For shorter periods we can't reconstruct the per-day RF
    // here, so we suppress the Total ≈ sub-line.
    const geomTotalIncRf =
      isFullVisibleWindow &&
      useLog &&
      tsData.log != null &&
      Number.isFinite(tsData.log.sumLogTotalVisible)
        ? Math.exp(tsData.log.sumLogTotalVisible) - 1
        : null;

    return {
      returnSegments: [...segs, idioSeg],
      windowAlpha: alphaSum,
      sumLogInner: innerSum,
      geometricTotalReturn: headline.useLog ? headline.geometric! : headline.arithmetic,
      geometricTotalReturnIncRf: geomTotalIncRf,
      arithmeticTotalReturn: simpleSum,
      identitySumGap: innerSum - (factorContribTotal + alphaSum + idioSum),
      postBurnObs: obs,
      rollingAlphaToTotalRatio: ratio,
      windowStartDate: tsData.dates[startIdx] ?? "",
      windowEndDate: tsData.dates[n - 1] ?? "",
    };
  }, [tsData, factors, useLog, attributionPeriod]);

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

  const returnWaterfallReady = tsData !== null && returnSegments.length > 0;

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
                `Daily intercept × 252 from the snapshot OLS in ${attributionMode} space. t = ${Number.isFinite(tNum) ? tNum.toFixed(2) : "—"}.\n` +
                `STATIC (whole-window) — distinct from Σ rolling α_t shown in the waterfall residual.\n\n` +
                `95 % CI = α ± 1.96 × SE(α) × 252 = ` +
                `${Number.isFinite(annNum) ? (annNum * 100).toFixed(2) : "—"}% ± ${Number.isFinite(ciNum) ? (ciNum * 100).toFixed(2) : "—"}%.\n` +
                `Factor z-scoring does not affect this band — α and SE(α) are in y-units (excess return), and the studentised statistic is invariant to factor reparameterisation. With our typical DOF (≈ 250–365) the exact t-critical ≈ 1.97, so z = 1.96 is essentially equivalent.\n\n` +
                (attributionMode === "log"
                  ? `Log space: matches the waterfall's Σ α_t (log) segment in scale (rolling sum vs annualised intercept differ by horizon).`
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
            Loading return decomposition (aligned to rolling factor time series)…
          </div>
        )}
        {!tsLoading && !tsData && (
          <div style={{ padding: "16px 14px", fontSize: 11, color: "var(--color-negative)" }}>
            Could not load factor time series for this window — return waterfall unavailable.
          </div>
        )}

        {returnWaterfallReady && (
          <div style={{ padding: "12px 14px 4px" }}>
            {!useLog && (
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
                <>
                  Excess return attribution
                  <FactorInfoIcon
                    tip={
                      `Window: ${postBurnObs} / ${data.regressionWindow} trading days (post burn-in).\n\n` +
                      (postBurnObs < data.regressionWindow
                        ? `${data.regressionWindow - postBurnObs} day(s) dropped from the requested ${data.regressionWindow}-day display window. ` +
                          `Strict drop-row policy: dates with any missing factor cell are removed (run scripts/factor-window-coverage.ts ${row.ticker} to inspect).\n\n`
                        : ``) +
                      `The first observations of the chart are reserved as a burn-in prefix so the ` +
                      `rolling regression and factor normalization have a full history before the ` +
                      `attribution series begins. The chart and this decomposition use the same cut, ` +
                      `so the bars sum to the value displayed for the visible date range below.\n\n` +
                      (useLog
                        ? `Headline = exp(Σ y_log) − 1 = compounded geometric excess return over ` +
                          `the window. The per-factor bars are additive in log space only — ` +
                          `exp(component) − 1 of an individual factor does NOT sum to the geometric total.`
                        : `Headline = Σ y_simple — arithmetic sum of daily simple excess returns. ` +
                          `Identity holds daily but the multi-period sum is NOT a compounded total.`)
                    }
                    ariaLabel="Attribution window methodology"
                  />
                </>
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
                label: useLog ? "Σ α_t (log)" : "Σ rolling α_t",
                value: windowAlpha,
                color: "#f1f5f9",
                sub:
                  rollingAlphaToTotalRatio > 0.5
                    ? `⚠ |Σα|/|Σy| = ${(rollingAlphaToTotalRatio * 100).toFixed(0)}% — large rolling-α drift (possible model misspecification or β instability)`
                    : `Σ rolling intercepts (post burn-in). Static α (ann.) = ${(row.alphaAnnualized * 100).toFixed(2)}%.`,
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
                          `Total return ≈ exp(Σ ln(1 + r_stock)) − 1 over the visible ` +
                          `${postBurnObs}-day window.\n\n` +
                          `Identity: Σ ln(1 + r_stock) = Σ y_log + Σ ln(1 + r_f).\n` +
                          `So this number compounds the per-day RF back onto the ` +
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
                  ? `Log-space daily identity:\n` +
                    `  Σ y_log − [Σ(β·x_log) + Σα + Σε] = ${(identitySumGap * 100).toFixed(4)}%\n` +
                    `Should be ≤ 1e-6 (numerical noise).\n\n` +
                    `Headline reconciliation:\n` +
                    `  Σ y_log = ${(sumLogInner * 100).toFixed(2)}%\n` +
                    `  exp(Σ y_log) − 1 = ${(geometricTotalReturn * 100).toFixed(2)}% (compounded realized excess)\n\n` +
                    `Bars are additive in log space only; exp(component) − 1 of an ` +
                    `individual factor does NOT sum to the geometric headline.`
                  : `Arithmetic identity (fallback path):\n` +
                    `  Σy − [Σ(β·r) + Σα + Σε] = ${(identitySumGap * 100).toFixed(4)}%\n` +
                    `Should be ≤ 1e-6 (numerical noise). Larger gap indicates a bug or ` +
                    `burn-in misalignment.`
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
                Daily identity {Math.abs(identitySumGap) < 1e-6 ? "closes" : "open"}
                {" "}
                {useLog
                  ? `(log space; bars sum to inner Σ y_log)`
                  : `(arithmetic; residual ${(identitySumGap * 100).toFixed(4)}%)`}
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
