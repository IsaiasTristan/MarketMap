"use client";
import { MetricCard } from "@/components/analysis/ui/MetricCard";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { getMetricDef } from "@/lib/factors/definitions/metric-defs";
import { pickPeriodSummary } from "@/lib/factors/attribution/pick-period-summary";
import type { FactorExposureSnapshot, FactorCode } from "@/types/factors";
import { useAnalysisStore, type FactorPeriod } from "@/store/analysis";
import type { AttributionResult } from "@/types/factors";

interface HeaderSummaryProps {
  exposure: FactorExposureSnapshot | null | undefined;
  attribution: AttributionResult | null | undefined;
  selectedPeriod: FactorPeriod;
  loading?: boolean;
}

function fmt(v: number, suffix = "", digits = 2): string {
  return `${v >= 0 ? "+" : ""}${(v * 100).toFixed(digits)}${suffix}`;
}

function fmtBeta(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
}

export function HeaderSummary({ exposure, attribution, selectedPeriod, loading }: HeaderSummaryProps) {
  const attributionMode = useAnalysisStore((s) => s.factorAttributionMode);
  if (loading || !exposure) {
    return (
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            style={{
              height: 90,
              background: "var(--bg-surface)",
              border: "1px solid var(--bg-border)",
              borderRadius: 2,
              animation: "pulse 1.5s ease-in-out infinite",
            }}
          />
        ))}
      </div>
    );
  }

  const topTilt = [...exposure.factors].sort((a, b) => Math.abs(b.beta) - Math.abs(a.beta))[0];

  // Alpha over selected period — mode-aware (log/simple), resolved via the
  // shared picker so the card actually responds to the period + mode controls.
  const picked = pickPeriodSummary(attribution, selectedPeriod, attributionMode);
  const periodAlpha = picked?.alpha;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 12 }}>
      <MetricCard
        label="Market Beta"
        value={fmtBeta(exposure.factors.find((f) => f.code === "MKT_RF")?.beta ?? 1)}
        subValue={`t = ${(exposure.factors.find((f) => f.code === "MKT_RF")?.tStat ?? 0).toFixed(1)}`}
        valueColor={
          Math.abs((exposure.factors.find((f) => f.code === "MKT_RF")?.beta ?? 1) - 1) < 0.2
            ? "neutral"
            : (exposure.factors.find((f) => f.code === "MKT_RF")?.beta ?? 1) > 1.2
              ? "warning"
              : "default"
        }
        tooltip={{
          name: "Market Beta",
          definition:
            "Portfolio sensitivity to broad market moves. Beta = 1 means the portfolio tracks the market. Higher beta amplifies both gains and losses.",
          formula: getMetricDef("marketBeta").howCalculated,
          dataUsed: getMetricDef("marketBeta").dataUsed,
          goodValue: "0.8–1.2 for a market-tracking portfolio.",
        }}
      />

      <MetricCard
        label="Top Factor Tilt"
        value={
          topTilt
            ? `${getFactorDef(topTilt.code as FactorCode).shortLabel} ${fmtBeta(topTilt.beta)}`
            : "—"
        }
        subValue={topTilt ? topTilt.label : undefined}
        valueColor="neutral"
        tooltip={{
          name: "Top Factor Tilt",
          definition:
            "The factor with the largest absolute beta. A strong tilt indicates systematic exposure that may drive returns in trending regimes.",
          formula: getMetricDef("topFactorTilt").howCalculated,
          dataUsed: getMetricDef("topFactorTilt").dataUsed,
        }}
      />

      <MetricCard
        label="Factor Concentration"
        value={`${(exposure.concentrationHHI * 100).toFixed(0)}%`}
        subValue="HHI of risk contribs"
        valueColor={
          exposure.concentrationHHI < 0.3
            ? "positive"
            : exposure.concentrationHHI < 0.6
              ? "warning"
              : "negative"
        }
        tooltip={{
          name: "Factor Concentration (HHI)",
          definition:
            "Herfindahl-Hirschman Index of absolute factor risk contributions. 0% = perfectly diversified across factors; 100% = one factor explains all risk.",
          formula: "Σ sᵢ² where sᵢ is each factor's share of absolute risk contribution.",
          dataUsed: getMetricDef("factorConcentration").dataUsed,
          goodValue: "< 30% for diversified multi-factor exposure.",
        }}
      />

      <MetricCard
        label="Systematic Risk"
        value={`${(exposure.systematicShare * 100).toFixed(0)}%`}
        subValue={`${(exposure.idiosyncraticShare * 100).toFixed(0)}% idiosyncratic`}
        valueColor="default"
        tooltip={{
          name: "Systematic Risk Share",
          definition:
            "Share of total portfolio variance explained by systematic factor tilts. "
            + "The remaining share is idiosyncratic (stock-specific).",
          formula: getMetricDef("systematicRisk").howCalculated,
          dataUsed: getMetricDef("systematicRisk").dataUsed,
          goodValue: "60–85% for diversified long-only equity.",
        }}
      />

      <MetricCard
        label={`Alpha (${selectedPeriod})`}
        value={periodAlpha !== undefined ? fmt(periodAlpha, "%") : "—"}
        subValue={
          periodAlpha !== undefined
            ? picked?.isLog
              ? "log-space residual"
              : "simple residual"
            : `needs attribution data · ann. α ${fmt(exposure.alphaAnnualized, "%")}`
        }
        valueColor={
          periodAlpha === undefined
            ? "neutral"
            : periodAlpha > 0
              ? "positive"
              : periodAlpha < -0.02
                ? "negative"
                : "neutral"
        }
        tooltip={{
          name: "Residual Alpha",
          definition:
            "Return not explained by factor exposures — the potential skill component. "
            + "Interpret cautiously: short periods produce noisy estimates.",
          formula: getMetricDef("alpha").howCalculated,
          dataUsed: getMetricDef("alpha").dataUsed,
          goodValue: "Positive with |t| > 2.",
        }}
      />
    </div>
  );
}
