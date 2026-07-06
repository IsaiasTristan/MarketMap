"use client";
/**
 * CONFLUENCE metric tooltip — the confluence binding of the generic
 * DefinitionTooltip. Every column header, stack cell, stage chip, and stamp on
 * the confluence board renders its definition through this; the text comes
 * from the confluence metric registry (config-interpolated), never inline
 * strings.
 */
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import {
  confluenceMetric,
  type ConfluenceMetricId,
} from "@/lib/analysis/confluence/metric-registry";

export function ConfluenceMetricTip({
  id,
  children,
  className,
  style,
}: {
  id: ConfluenceMetricId;
  /** Override the displayed term; defaults to the registry label. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <DefinitionTooltip def={confluenceMetric(id)} className={className} style={style}>
      {children}
    </DefinitionTooltip>
  );
}
