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
import type { FactorCode } from "@/types/factors";
import { Waterfall, type WaterfallSegment } from "../shared/Waterfall";
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
  onClose?: () => void;
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

export function PerStockDetail({ data, selectedTicker, onClose }: PerStockDetailProps) {
  const [tsMetric, setTsMetric] = useState<"return" | "risk" | "beta">("return");
  const factorTsRollingWindow = useAnalysisStore((s) => s.factorTsRollingWindow);
  const setFactorTsRollingWindow = useAnalysisStore((s) => s.setFactorTsRollingWindow);

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
    arithmeticTotalReturn,
    identitySumGap,
    postBurnObs,
    rollingAlphaToTotalRatio,
  } = useMemo(() => {
    if (!tsData) {
      return {
        returnSegments: [] as WaterfallSegment[],
        windowAlpha: 0,
        sumLogInner: 0,
        geometricTotalReturn: 0,
        arithmeticTotalReturn: 0,
        identitySumGap: 0,
        postBurnObs: 0,
        rollingAlphaToTotalRatio: 0,
      };
    }
    const startIdx = tsData.displayStartIndex ?? 0;
    const n = tsData.dates.length;
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
    };

    const ratio = Math.abs(innerSum) > 1e-9 ? Math.abs(alphaSum) / Math.abs(innerSum) : 0;

    // Single source of truth for the headline display contract — the helper
    // also drives the strict-drop fallback banner when the log path is null.
    const headline = pickHeadlineValue({
      arithmeticSum: simpleSum,
      logSum: useLog ? innerSum : null,
    });

    return {
      returnSegments: [...segs, idioSeg],
      windowAlpha: alphaSum,
      sumLogInner: innerSum,
      geometricTotalReturn: headline.useLog ? headline.geometric! : headline.arithmetic,
      arithmeticTotalReturn: simpleSum,
      identitySumGap: innerSum - (factorContribTotal + alphaSum + idioSum),
      postBurnObs: obs,
      rollingAlphaToTotalRatio: ratio,
    };
  }, [tsData, factors, useLog]);

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
    `Realised ${(row.realizedAnnualizedVol * 100).toFixed(1)}%  ·  ` +
    `model ${(row.modelImpliedAnnualizedVol * 100).toFixed(1)}%  ` +
    `(Δ ${row.varGapPct >= 0 ? "+" : ""}${(row.varGapPct * 100).toFixed(1)}%)  ·  ` +
    `R² ${(row.rSquared * 100).toFixed(0)}%  ·  ` +
    `Euler ${(row.systematicShareEulerAligned * 100).toFixed(0)}%  ·  ` +
    `α ${row.alphaAnnualized >= 0 ? "+" : ""}${(row.alphaAnnualized * 100).toFixed(1)}%`;

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          background: "var(--bb-chrome)",
          color: "#fff",
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: 10,
        }}
      >
        <div style={{ flex: 1, fontWeight: 700, letterSpacing: "0.05em" }}>{row.ticker}</div>
        {onClose && (
          <button
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
        )}
      </div>
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
        {/* Primary: Realised σ (annualised) */}
        <div
          style={{
            padding: "12px 14px",
            borderRight: "1px solid rgba(255,255,255,0.04)",
          }}
          title={
            `Sample √Var(y) × √252 over the regression-aligned dates.\n` +
            `PRIMARY headline volatility per Phase 2/3 lock-in (anchor to realised, model-implied for reconciliation).`
          }
        >
          <div
            style={{
              fontSize: 9,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.08em",
            }}
          >
            Realised σ (ann.)
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
            Model-implied {(row.modelImpliedAnnualizedVol * 100).toFixed(1)}%
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
              R² (in-sample) · Euler share
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
              Variance gap (vs realised)
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
            title={
              `Daily intercept × 252 from the snapshot OLS. t = ${row.alphaTStat.toFixed(2)}.\n` +
              `STATIC (whole-window) — distinct from Σ rolling α_t shown in the return waterfall residual.\n\n` +
              `LARGE α may reflect model misspecification rather than skill — check residual scatter for systematic patterns.`
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
              Static alpha (ann.)
            </div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                fontFamily: "var(--font-mono, monospace)",
                color: row.alphaAnnualized >= 0 ? "var(--color-positive)" : "var(--color-negative)",
                marginTop: 1,
              }}
            >
              {row.alphaAnnualized >= 0 ? "+" : ""}{(row.alphaAnnualized * 100).toFixed(2)}%
              <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>
                t = {row.alphaTStat.toFixed(2)}
              </span>
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
          `Reconciliation strip — primary anchor is realised σ; everything else is reported relative to it.\n` +
          `R² is in-sample fit; Euler is covariance-implied systematic share. They are different concepts (Q1 lock).`
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
              title={`Total Return Decomposition · ${postBurnObs} obs (post burn-in)`}
              subtitle={
                useLog
                  ? "Bars are log contributions Σ(β·ln(1+f)) + Σα + Σε; headline shows compounded realised exp(Σ) − 1"
                  : "Σ (rolling β × daily factor return) + Σ α + Σ ε = total excess return (arithmetic, NOT compounded)"
              }
              total={sumLogInner}
              totalLabel="Total Excess Return"
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
                  <span style={{ display: "inline-flex", alignItems: "center" }}>
                    exp(Σ y_log) − 1
                    <LogModeMethodology
                      sumLog={sumLogInner}
                      geometric={geometricTotalReturn}
                      arithmeticSimple={arithmeticTotalReturn}
                      identityGap={identitySumGap}
                      obsCount={postBurnObs}
                    />
                  </span>
                ) : undefined
              }
            />
            {/* Reconciliation sub-line — log mode shows the inner Σ → exp() chain
                with a green ✓ tick; simple-fallback shows the arithmetic identity. */}
            <div
              style={{
                padding: "6px 4px 0",
                fontSize: 10,
                color: "var(--text-muted)",
                fontFamily: "var(--font-mono, monospace)",
                fontVariantNumeric: "tabular-nums",
              }}
              title={
                useLog
                  ? `Log-space identity:\n` +
                    `Σ y_log − [Σ(β·x_log) + Σα + Σε] = ${(identitySumGap * 100).toFixed(4)}%.\n` +
                    `Should be ≤ 1e-6 (numerical noise). Headline reconciles to compounded realised: ` +
                    `exp(Σ y_log) − 1 = ${(geometricTotalReturn * 100).toFixed(2)}%.`
                  : `Arithmetic identity (fallback path):\n` +
                    `Σy − [Σ(β·r) + Σα + Σε] = ${(identitySumGap * 100).toFixed(4)}%.\n` +
                    `Should be ≤ 1e-6 (numerical noise). Larger gap indicates a bug or burn-in misalignment.`
              }
            >
              {useLog ? (
                <>
                  Σ log contribs = {(sumLogInner * 100).toFixed(2)}%{"  →  "}
                  exp(Σ) − 1 ={" "}
                  <span
                    style={{
                      color:
                        geometricTotalReturn >= 0
                          ? "var(--color-positive)"
                          : "var(--color-negative)",
                      fontWeight: 600,
                    }}
                  >
                    {geometricTotalReturn >= 0 ? "+" : ""}
                    {(geometricTotalReturn * 100).toFixed(2)}%
                  </span>{" "}
                  <span
                    style={{
                      color:
                        Math.abs(identitySumGap) < 1e-6
                          ? "var(--color-positive)"
                          : "#f59e0b",
                    }}
                  >
                    {Math.abs(identitySumGap) < 1e-6 ? "✓" : "⚠"}
                  </span>
                </>
              ) : (
                `Identity: Σy = Σ(β·r) + Σα + Σε  →  residual = ${(identitySumGap * 100).toFixed(4)}%`
              )}
            </div>
            {useLog && (
              <div
                style={{
                  padding: "3px 4px 0",
                  fontSize: 9,
                  fontFamily: "var(--font-mono, monospace)",
                  color: "var(--text-muted)",
                  fontStyle: "italic",
                }}
              >
                Bars are additive in log space only; exp(component) − 1 for an individual factor does NOT sum to the geometric total.
              </div>
            )}
          </div>
        )}

        <div style={{ padding: "8px 14px 4px" }}>
          <Waterfall
            title="Total Risk Decomposition"
            subtitle="Components are share of MODEL-IMPLIED total variance (β'Σβ + σ²_idio); Σ recomputed on regression-aligned sample"
            total={1}
            totalLabel="100% of model variance"
            formatValue={(v) => `${(v * 100).toFixed(1)}%`}
            totalAnnotation={
              `Realised σ ${(row.realizedAnnualizedVol * 100).toFixed(1)}% · ` +
              `model σ ${(row.modelImpliedAnnualizedVol * 100).toFixed(1)}% · ` +
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
