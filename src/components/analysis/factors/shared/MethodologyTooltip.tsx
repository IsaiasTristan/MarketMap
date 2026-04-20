"use client";
import { InfoTooltip } from "@/components/analysis/ui/InfoTooltip";
import { getExplanation } from "@/lib/factors/formatting/explanations";

interface MethodologyTooltipProps {
  metricKey: string;
  currentValue?: string;
  passing?: boolean;
}

/**
 * Wraps InfoTooltip with pre-filled content from the explanations registry.
 * All factor metrics should use this instead of hardcoding tooltip text.
 */
export function MethodologyTooltip({
  metricKey,
  currentValue,
  passing,
}: MethodologyTooltipProps) {
  const expl = getExplanation(metricKey);
  return (
    <InfoTooltip
      name={expl.name}
      definition={`${expl.plainEnglish}\n\n${expl.definition}`}
      formula={expl.formula}
      goodValue={expl.goodValue}
      currentValue={currentValue}
      passing={passing}
    />
  );
}
