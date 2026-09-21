"use client";
/**
 * Pairs tab binding of the generic DefinitionTooltip — every column header,
 * stat, chip and flag renders its definition through this, sourced from the
 * pairs metric registry (config-interpolated), never inline strings.
 */
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import { pairMetric, type PairMetricId } from "@/lib/pairs/metric-registry";

export function PairMetricTip({
  id,
  children,
  className,
  style,
  arithmetic,
  label,
}: {
  id: PairMetricId;
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
  /** Per-instance arithmetic line (e.g. this matrix cell's own computation). */
  arithmetic?: string;
  /** Override the registry label (e.g. name the specific pair/cell). */
  label?: string;
}) {
  const base = pairMetric(id);
  const def = arithmetic || label ? { ...base, ...(label ? { label } : {}), arithmetic } : base;
  return (
    <DefinitionTooltip def={def} className={className} style={style}>
      {children}
    </DefinitionTooltip>
  );
}
