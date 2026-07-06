"use client";
/**
 * Overview SIGNAL BRIEF metric tooltip — the signal-brief binding of the
 * generic DefinitionTooltip. Every axis label, chip, and stamp across the
 * portfolio-lens signal modules renders its definition through this; the text
 * comes from the signal-brief metric registry (config-interpolated), never
 * inline strings.
 */
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import { signalMetric, type SignalMetricId } from "@/lib/analysis/signal-brief/metric-registry";

export function SignalMetricTip({
  id,
  children,
  className,
  style,
}: {
  id: SignalMetricId;
  /** Override the displayed term; defaults to the registry label. */
  children?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}) {
  return (
    <DefinitionTooltip def={signalMetric(id)} className={className} style={style}>
      {children}
    </DefinitionTooltip>
  );
}
