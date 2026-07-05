"use client";
/**
 * Engine 1 metric tooltip — the research binding of the generic
 * DefinitionTooltip. Every column header, stat, chip, and score cell across
 * the research tabs renders its definition through this; the text comes from
 * the revision metric registry (config-interpolated), never inline strings.
 */
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import { revMetric, type RevMetricId } from "@/lib/revision/metric-registry";

export function MetricTip({
  id,
  children,
  className,
  style,
}: {
  id: RevMetricId;
  /** Override the displayed term; defaults to the registry label. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <DefinitionTooltip def={revMetric(id)} className={className} style={style}>
      {children}
    </DefinitionTooltip>
  );
}
