"use client";
/**
 * PortfolioTotalsPanel — explicit "Total Return" and "Total Risk" waterfalls
 * for the portfolio-level view, shown above the tab strip in the Exposure
 * tab so the headline number is always visible alongside its decomposition.
 *
 * Total Return  = Σ (factor return contributions over `selectedPeriod`) + Alpha
 * Total Risk    = factor variance shares + idiosyncratic share (sums to 100%)
 *                 with the headline showing total annualised volatility.
 */
import { useMemo } from "react";
import { Waterfall, type WaterfallSegment } from "../shared/Waterfall";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type {
  FactorExposureSnapshot,
  AttributionResult,
  RiskDecomposition,
  FactorCode,
} from "@/types/factors";
import type { FactorPeriod } from "@/store/analysis";

interface PortfolioTotalsPanelProps {
  exposure: FactorExposureSnapshot | null | undefined;
  attribution: AttributionResult | null | undefined;
  risk: RiskDecomposition | null | undefined;
  selectedPeriod: FactorPeriod;
}

export function PortfolioTotalsPanel({
  exposure,
  attribution,
  risk,
  selectedPeriod,
}: PortfolioTotalsPanelProps) {
  // Total Return waterfall — pull from the period attribution summary if
  // available; otherwise fall back to per-factor "% return contribution"
  // numbers stored on the exposure snapshot (those are decimals over the
  // exposure window — best-effort fallback, clearly labelled in the title).
  const returnWaterfall = useMemo(() => {
    if (!exposure) return null;
    const periodSummary = attribution?.periods?.find((p) => p.label === selectedPeriod);
    if (periodSummary && periodSummary.byFactor.length > 0) {
      const segments: WaterfallSegment[] = periodSummary.byFactor
        .map((b) => {
          const def = getFactorDef(b.code as FactorCode);
          return {
            key: `pret-${b.code}`,
            label: def.label,
            value: b.contribution,
            color: def.color,
          };
        })
        .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
      return {
        title: `Total Return Decomposition · ${selectedPeriod}`,
        subtitle:
          "Components add up to total return: Σ (β × cumulative factor return) + alpha + risk-free",
        total: periodSummary.totalReturn,
        residual: {
          key: "alpha",
          label: "Alpha (Residual)",
          value: periodSummary.alpha,
          color: "#f1f5f9",
        } as WaterfallSegment,
        segments,
      };
    }
    // Fallback: synthesize from exposure.pctReturnContrib (whole-window).
    const segments: WaterfallSegment[] = exposure.factors
      .map((f) => ({
        key: `pret-${f.code}`,
        label: f.label,
        value: f.pctReturnContrib,
        color: getFactorDef(f.code as FactorCode).color,
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
    const total = segments.reduce((s, x) => s + x.value, 0) + exposure.alphaAnnualized;
    return {
      title: `Total Return Decomposition · ${exposure.window}D window`,
      subtitle:
        "Period attribution unavailable yet — showing whole-window factor return contributions plus annualised alpha.",
      total,
      residual: {
        key: "alpha",
        label: "Alpha (Residual)",
        value: exposure.alphaAnnualized,
        color: "#f1f5f9",
      } as WaterfallSegment,
      segments,
    };
  }, [exposure, attribution, selectedPeriod]);

  // Total Risk waterfall — variance shares (sum to 100%) with headline
  // showing total annualised volatility.
  // Phase 3 §2.8 (Q4 lock): primary anchor is realised σ; model-implied σ
  // + var-gap badge are reconciliation. Mirrors per-stock hierarchy so the
  // user sees the same label structure on portfolio and per-stock views.
  const riskWaterfall = useMemo(() => {
    if (!risk && !exposure) return null;
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
      .map((f) => ({
        key: `prisk-${f.code}`,
        label: f.label,
        value: f.value,
        color: getFactorDef(f.code as FactorCode).color,
      }))
      .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));

    return {
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
  }, [risk, exposure]);

  if (!returnWaterfall && !riskWaterfall) return null;

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
          title={returnWaterfall.title}
          subtitle={returnWaterfall.subtitle}
          total={returnWaterfall.total}
          totalLabel="Total Return"
          segments={returnWaterfall.segments}
          residual={returnWaterfall.residual}
        />
      )}
      {riskWaterfall && (
        <Waterfall
          title="Variance decomposition (model)"
          subtitle="Components are share of MODEL-IMPLIED total variance (β'Σβ + σ²_idio); realized vol shown above for reconciliation"
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
