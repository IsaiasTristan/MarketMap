"use client";
/**
 * PortfolioTotalsPanel — explicit "Total Return" and "Variance" waterfalls
 * for the portfolio-level view, shown above the tab strip in the Exposure
 * tab so the headline number is always visible alongside its decomposition.
 *
 * Both waterfalls are period-aware (driven by the Attribution Period control):
 *
 *   Total Return  = Σ (β × cumulative factor return over `selectedPeriod`)
 *                 + α  — resolved via `pickPeriodSummary`.
 *   Variance      = Σ contrib_f,t² / SS_total per factor, + α_t² / SS_total
 *                 idiosyncratic share, on the same daily slice as the
 *                 return waterfall (resolved via `pickPeriodRiskSummary`).
 *                 Headline shows the slice's annualised realised σ.
 *
 * The HORIZON preset (selected `factorWindow` — 63/252/504/756) drives the
 * betas + end-fit; titles always show the selected horizon preset, not the
 * aligned-obs count, so a 484-aligned-vs-504-requested mismatch doesn't make
 * the labels read as a broken control.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Waterfall, type WaterfallSegment } from "../shared/Waterfall";
import { FactorFreshnessBadge, type FactorFreshnessMode } from "../shared/FactorFreshnessBadge";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import {
  mergeLive1DPeriodSummary,
  pickPeriodSummary,
  type PortfolioLive1DResponse,
} from "@/lib/factors/attribution/pick-period-summary";
import { todayEtIsoDate } from "@/lib/factors/attribution/today-et";
import { pickPeriodRiskSummary } from "@/lib/factors/attribution/pick-period-risk";
import { getHorizonPreset } from "@/lib/factors/definitions/horizon-presets";
import type {
  FactorExposureSnapshot,
  AttributionResult,
  RiskDecomposition,
  FactorCode,
} from "@/types/factors";
import {
  useAnalysisStore,
  type FactorPeriod,
  type FactorWindow,
} from "@/store/analysis";

/** Hover-popup content for the Alpha residual row in return waterfalls. */
const ALPHA_RESIDUAL_INFO = {
  name: "Alpha (Residual)",
  definition:
    "The portion of return not explained by any factor — the regression intercept plus the unmodeled residual. Positive alpha is return earned beyond the factor exposures.",
  howCalculated: "Realized return minus the sum of all factor contributions (β × factor return).",
  dataUsed:
    "Portfolio daily returns (Yahoo prices) and the MACRO14 factor return series used in the regression.",
};

const IDIO_RESIDUAL_INFO = {
  name: "Idiosyncratic (Stock-specific)",
  definition:
    "Share of realised return variance not explained by any factor — purely stock-specific noise on the period slice.",
  howCalculated: "Σ α_t² / (Σ contrib_f,t² + Σ α_t²) over the selected attribution period.",
  dataUsed:
    "Daily factor contributions and residuals from the portfolio regression over the period slice.",
};

type PortfolioLive1DQuery =
  | PortfolioLive1DResponse
  | { live: false; reason: string }
  | null;

function isPortfolioLive1D(x: unknown): x is PortfolioLive1DQuery {
  if (!x || typeof x !== "object") return false;
  const o = x as { live?: unknown };
  return o.live === true || o.live === false;
}

interface PortfolioTotalsPanelProps {
  exposure: FactorExposureSnapshot | null | undefined;
  attribution: AttributionResult | null | undefined;
  risk: RiskDecomposition | null | undefined;
  selectedPeriod: FactorPeriod;
  /** Selected HORIZON preset (training window in trading days). */
  regressionWindow: FactorWindow;
}

export function PortfolioTotalsPanel({
  exposure,
  attribution,
  risk,
  selectedPeriod,
  regressionWindow,
}: PortfolioTotalsPanelProps) {
  const {
    activePortfolioId,
    factorModel,
    factorWindow,
    factorAttributionMode: attributionMode,
  } = useAnalysisStore();
  const horizon = getHorizonPreset(regressionWindow);
  const horizonLabel = `${horizon.label} · ${horizon.value}d horizon`;

  const isOneDay = selectedPeriod === "1D";
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!isOneDay) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [isOneDay]);

  const sessionNow = getUsMarketSession(new Date(now));
  const pollIntervalMs = sessionNow === "REGULAR" ? 30_000 : 5 * 60_000;
  const liveEnabled = isOneDay && !!activePortfolioId;

  const { data: liveRaw, isFetching: liveFetching } = useQuery<PortfolioLive1DQuery>({
    queryKey: [
      "factor-attribution-live-1d",
      activePortfolioId,
      factorModel,
      factorWindow,
    ],
    queryFn: () =>
      fetch(
        `/api/analysis/factors/attribution/live-1d?portfolioId=${encodeURIComponent(
          activePortfolioId!,
        )}&model=${factorModel}&window=${factorWindow}`,
      )
        .then((r) => r.json())
        .then((d) => (isPortfolioLive1D(d) ? d : null)),
    enabled: liveEnabled,
    refetchInterval: liveEnabled ? pollIntervalMs : false,
    staleTime: pollIntervalMs - 5_000,
  });

  const livePoll =
    liveRaw && liveRaw.live === true ? (liveRaw as PortfolioLive1DResponse) : null;
  const livePollFailure =
    liveRaw && liveRaw.live === false ? liveRaw.reason : null;

  // Total Return waterfall — resolve the selected period + attribution mode
  // into one normalized summary. In log mode the headline is the geometric
  // exp(Σy_log) − 1 and the bars are additive log contributions; in simple
  // mode it is the arithmetic Σ y_simple. Falls back to a whole-window
  // exposure snapshot (clearly labelled) when no period bucket is available.
  const returnWaterfall = useMemo(() => {
    if (!exposure) return null;
    const basePicked = pickPeriodSummary(attribution, selectedPeriod, attributionMode);
    const picked = mergeLive1DPeriodSummary(
      basePicked,
      selectedPeriod,
      attributionMode,
      livePoll,
    );
    if (picked) {
      const segments: WaterfallSegment[] = picked.byFactor
        .map((b) => {
          const def = getFactorDef(b.code as FactorCode);
          return {
            key: `pret-${b.code}`,
            label: def.label,
            value: b.contribution,
            color: def.color,
            info: {
              name: def.label,
              definition: def.description,
              howCalculated: def.howCalculated,
              dataUsed: def.dataSource,
            },
          };
        })
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      const innerTotal = picked.isLog && picked.totalLogReturn != null
        ? picked.totalLogReturn
        : picked.totalReturn;
      return {
        title: `Total Return Decomposition · ${selectedPeriod}`,
        subtitle: picked.isLog
          ? `${horizonLabel} · geometric total exp(Σ y_log) − 1 over ${selectedPeriod}; bars are additive log contributions (β × factor log return) + alpha. ${picked.startDate} — ${picked.endDate}.`
          : `${horizonLabel} · components add up to total return: Σ (β × cumulative factor return) + alpha + risk-free. ${picked.startDate} — ${picked.endDate}.`,
        total: innerTotal,
        residual: {
          key: "alpha",
          label: "Alpha (Residual)",
          value: picked.alpha,
          color: "#f1f5f9",
          info: ALPHA_RESIDUAL_INFO,
        } as WaterfallSegment,
        segments,
        headlineOverride: picked.isLog
          ? { value: picked.totalReturn }
          : undefined,
      };
    }
    const segments: WaterfallSegment[] = exposure.factors
      .map((f) => {
        const def = getFactorDef(f.code as FactorCode);
        return {
          key: `pret-${f.code}`,
          label: f.label,
          value: f.pctReturnContrib,
          color: def.color,
          info: {
            name: f.label,
            definition: def.description,
            howCalculated: def.howCalculated,
            dataUsed: def.dataSource,
          },
        };
      })
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const total = segments.reduce((s, x) => s + x.value, 0) + exposure.alphaAnnualized;
    return {
      title: `Total Return Decomposition · ${horizon.label}`,
      subtitle:
        `⚠ Attribution unavailable for ${selectedPeriod} — not enough overlapping factor history for a ${horizon.value}-day rolling attribution. Showing the whole-window snapshot (period control does not apply here). Refresh the factor pipeline if this persists.`,
      total,
      residual: {
        key: "alpha",
        label: "Alpha (Residual)",
        value: exposure.alphaAnnualized,
        color: "#f1f5f9",
        info: ALPHA_RESIDUAL_INFO,
      } as WaterfallSegment,
      segments,
      headlineOverride: undefined as undefined,
    };
  }, [
    exposure,
    attribution,
    selectedPeriod,
    attributionMode,
    horizonLabel,
    horizon.label,
    horizon.value,
    livePoll,
  ]);

  // Variance waterfall — period-sliced realised variance decomposition on the
  // same daily slice as the return waterfall (`pickPeriodRiskSummary`).
  // Shares sum to 100 % by construction. Headline is the slice's annualised
  // realised σ. Falls back to the whole-window Euler model shares (current
  // behaviour) when the period slice is too short (< 2 obs) or attribution
  // is unavailable — the title makes the fallback explicit.
  const riskWaterfall = useMemo(() => {
    if (!risk && !exposure) return null;

    const factorCodes = (exposure?.factors?.map((f) => f.code) ??
      risk?.factors?.map((f) => f.code) ??
      []) as FactorCode[];
    const periodRisk = pickPeriodRiskSummary(attribution, selectedPeriod, factorCodes);

    if (periodRisk) {
      const segments: WaterfallSegment[] = periodRisk.byFactor
        .map((f) => {
          const def = getFactorDef(f.code);
          return {
            key: `prisk-${f.code}`,
            label: f.label,
            value: f.share,
            color: def.color,
            info: {
              name: def.label,
              definition: def.description,
              howCalculated: `Share of realised portfolio variance attributed to this factor over the ${selectedPeriod} slice (Σ contrib² decomposition).`,
              dataUsed: def.dataSource,
            },
          };
        })
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

      const sysShare = periodRisk.systematicShare;
      const idioShare = periodRisk.idioShare;
      const realisedVol = periodRisk.realizedAnnualizedVol;

      return {
        kind: "period" as const,
        title: `Variance Decomposition · ${selectedPeriod}`,
        subtitle: `${horizonLabel} · realised variance shares (Σ contrib² + Σ α²) on the ${selectedPeriod} slice. ${periodRisk.startDate} — ${periodRisk.endDate} (${periodRisk.observations} obs).`,
        total: 1,
        totalLabel: "Total Variance (period)",
        annotation: `Realised vol ${(realisedVol * 100).toFixed(1)}% · systematic ${(sysShare * 100).toFixed(0)}% / idio ${(idioShare * 100).toFixed(0)}%`,
        segments,
        residual: {
          key: "idio",
          label: "Idiosyncratic (Stock-specific)",
          value: idioShare,
          color: "#94a3b8",
          info: IDIO_RESIDUAL_INFO,
        } as WaterfallSegment,
      };
    }

    const totalVol = risk?.totalVolatility ?? 0;
    const realisedVol = exposure?.realizedAnnualizedVol ?? 0;
    const varGapPct = exposure?.varGapPct ?? 0;
    const sysShare = risk?.systematicShare ?? exposure?.systematicShare ?? 0;
    const idioShare = risk?.idiosyncraticShare ?? exposure?.idiosyncraticShare ?? 1 - sysShare;
    const absGap = Math.abs(varGapPct);
    const showGap = realisedVol > 0 && absGap >= 0.02;
    const isAmberGap = absGap >= 0.05;
    const sign = varGapPct >= 0 ? "+" : "";
    const annotation =
      realisedVol > 0
        ? `Realized vol ${(realisedVol * 100).toFixed(1)}% · model vol ${(totalVol * 100).toFixed(1)}%${
            showGap
              ? ` (Δσ² ${sign}${(varGapPct * 100).toFixed(1)}%${isAmberGap ? " ⚠" : ""})`
              : ""
          } · systematic ${(sysShare * 100).toFixed(0)}% / idio ${(idioShare * 100).toFixed(0)}%`
        : `Model vol ${(totalVol * 100).toFixed(1)}% · systematic ${(sysShare * 100).toFixed(0)}% / idio ${(idioShare * 100).toFixed(0)}%`;

    const fromRisk = risk?.factors ?? [];
    const factorShares =
      fromRisk.length > 0
        ? fromRisk.map((f) => ({
            code: f.code,
            label: f.label,
            value: f.pctVarianceContrib,
          }))
        : exposure?.factors.map((f) => ({
            code: f.code,
            label: f.label,
            value: f.pctRiskContrib,
          })) ?? [];

    const segments: WaterfallSegment[] = factorShares
      .map((f) => {
        const def = getFactorDef(f.code as FactorCode);
        return {
          key: `prisk-${f.code}`,
          label: f.label,
          value: f.value,
          color: def.color,
          info: {
            name: f.label,
            definition: def.description,
            howCalculated:
              "Share of portfolio variance attributed to this factor via the whole-window Euler decomposition (β'Σβ).",
            dataUsed: def.dataSource,
          },
        };
      })
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    const fallbackReason =
      selectedPeriod === "1D"
        ? `A single observation (1D) has no realised variance to decompose`
        : `Not enough daily attribution points on the ${selectedPeriod} slice`;
    return {
      kind: "fallback" as const,
      title: `Variance Decomposition · ${horizon.label}`,
      subtitle:
        `⚠ ${fallbackReason}. Showing whole-window Euler-decomposition shares (β'Σβ + σ²_idio); the attribution period does not apply to this view.`,
      total: 1,
      totalLabel: "Total Volatility (ann.)",
      annotation,
      segments,
      residual: {
        key: "idio",
        label: "Idiosyncratic (Stock-specific)",
        value: idioShare,
        color: "#94a3b8",
      } as WaterfallSegment,
    };
  }, [risk, exposure, attribution, selectedPeriod, horizonLabel, horizon.label]);

  if (!returnWaterfall && !riskWaterfall) return null;

  const liveOverlay = livePoll?.live1D ?? attribution?.live1D ?? null;
  const liveSession = liveOverlay
    ? liveOverlay.session ?? getUsMarketSession(new Date(liveOverlay.asOf))
    : null;
  const staticOneDayEnd =
    attribution?.periodsLog?.find((p) => p.label === "1D")?.endDate ??
    attribution?.periods?.find((p) => p.label === "1D")?.endDate ??
    null;
  const todayEt = todayEtIsoDate();
  const staticStale =
    isOneDay &&
    !liveOverlay &&
    staticOneDayEnd != null &&
    staticOneDayEnd !== todayEt;
  const failureReason =
    livePollFailure ??
    attribution?.live1DFailureReason ??
    null;

  let badgeMode: FactorFreshnessMode;
  if (liveOverlay) {
    badgeMode = liveSession === "REGULAR" ? "live" : "today-close";
  } else if (liveFetching && liveEnabled) {
    badgeMode = "loading";
  } else {
    badgeMode = "at-close";
  }

  const returnTitleWithBadge = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
      {returnWaterfall?.title}
      {isOneDay && (
        <FactorFreshnessBadge
          mode={badgeMode}
          asOf={
            liveOverlay
              ? liveOverlay.asOf
              : staticOneDayEnd
          }
          surface="portfolio"
          staleLiveReason={
            staticStale && failureReason ? failureReason : null
          }
          trailing={
            liveOverlay
              ? `· ${liveOverlay.factorsUsed.length} factors` +
                (liveOverlay.missingHoldings.length > 0
                  ? ` · ${liveOverlay.missingHoldings.length} holding(s) missing`
                  : "")
              : null
          }
        />
      )}
    </span>
  );

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 12,
      }}
    >
      {returnWaterfall && (
        <Waterfall
          title={returnTitleWithBadge}
          subtitle={returnWaterfall.subtitle}
          total={returnWaterfall.total}
          totalLabel="Total Return"
          segments={returnWaterfall.segments}
          residual={returnWaterfall.residual}
          headlineOverride={returnWaterfall.headlineOverride}
        />
      )}
      {riskWaterfall && (
        <Waterfall
          title={riskWaterfall.title}
          subtitle={riskWaterfall.subtitle}
          total={riskWaterfall.total}
          totalLabel={riskWaterfall.totalLabel}
          formatValue={(v) => `${(v * 100).toFixed(1)}%`}
          totalAnnotation={riskWaterfall.annotation}
          segments={riskWaterfall.segments}
          residual={riskWaterfall.residual}
        />
      )}
    </div>
  );
}
