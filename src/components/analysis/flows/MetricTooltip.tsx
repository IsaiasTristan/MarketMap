"use client";
/**
 * Metric definition tooltip (Fund Overview Part 4c) — flows binding of the
 * generic DefinitionTooltip. This is the single tooltip surface for every
 * metric label across the flows tabs — text comes from the institutional
 * metric registry, never inline strings, so definitions can't drift.
 */
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import { metric, type MetricId } from "@/lib/institutional/metric-registry";

export function MetricTooltip({
  id,
  children,
  className,
  style,
}: {
  id: MetricId;
  /** Override the displayed term; defaults to the registry label. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <DefinitionTooltip def={metric(id)} className={className} style={style}>
      {children}
    </DefinitionTooltip>
  );
}
