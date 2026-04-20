import type { ReactNode } from "react";
import { InfoTooltip } from "./InfoTooltip";
import type { InfoTooltipProps } from "./InfoTooltip";
import { Sparkline } from "./Sparkline";

interface MetricCardProps {
  label: string;
  value: string | number;
  subValue?: string;
  valueColor?: "positive" | "negative" | "warning" | "neutral" | "default";
  sparklineData?: number[];
  tooltip?: Omit<InfoTooltipProps, "currentValue" | "passing">;
  tooltipCurrentValue?: string;
  tooltipPassing?: boolean;
}

export type { InfoTooltipProps };

const VALUE_COLORS = {
  positive: "var(--color-positive)",
  negative: "var(--color-negative)",
  warning: "var(--color-warning)",
  neutral: "var(--color-neutral)",
  default: "var(--text-primary)",
};

export function MetricCard({
  label,
  value,
  subValue,
  valueColor = "default",
  sparklineData,
  tooltip,
  tooltipCurrentValue,
  tooltipPassing,
}: MetricCardProps) {
  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 12,
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minWidth: 0,
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: "var(--text-secondary)",
            textTransform: "uppercase",
            letterSpacing: "0.06em",
          }}
        >
          {label}
        </div>
        {tooltip && (
          <InfoTooltip
            name={tooltip.name}
            definition={tooltip.definition}
            formula={tooltip.formula}
            goodValue={tooltip.goodValue}
            currentValue={tooltipCurrentValue}
            passing={tooltipPassing}
          />
        )}
      </div>

      {/* Value */}
      <div
        style={{
          fontSize: 28,
          fontWeight: 700,
          fontFamily: "var(--font-jetbrains-mono, monospace)",
          color: VALUE_COLORS[valueColor],
          lineHeight: 1.1,
        }}
      >
        {value}
      </div>

      {/* Sub-value */}
      {subValue && (
        <div
          style={{
            fontSize: 14,
            color: "var(--text-secondary)",
            fontFamily: "var(--font-jetbrains-mono, monospace)",
          }}
        >
          {subValue}
        </div>
      )}

      {/* Sparkline */}
      {sparklineData && sparklineData.length > 0 && (
        <div style={{ marginTop: 8, height: 40 }}>
          <Sparkline
            data={sparklineData}
            positive={typeof value === "number" ? value >= 0 : undefined}
          />
        </div>
      )}
    </div>
  );
}
