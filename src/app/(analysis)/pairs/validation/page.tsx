"use client";
import { PairsShell } from "@/components/analysis/pairs/PairsShell";
import { ValidationView } from "@/components/analysis/pairs/ValidationView";

export default function PairsValidationPage() {
  return (
    <PairsShell
      title="Validation"
      subtitle="A pooled event study on the tab's own premise — does an unpriced signal gap subsequently get paid? Gated on effective sample, not raw event count."
    >
      <ValidationView />
    </PairsShell>
  );
}
