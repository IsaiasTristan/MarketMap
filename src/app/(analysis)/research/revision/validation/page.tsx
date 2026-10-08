"use client";
import { RevisionShell } from "@/components/analysis/research/screens/RevisionShell";
import { ValidationCanvas } from "@/components/analysis/research/screens/ValidationCanvas";

export default function RevisionValidationPage() {
  return (
    <RevisionShell
      title="Validation"
      subtitle="Does the queue work? Measured on the same rank the screens serve."
    >
      <ValidationCanvas />
    </RevisionShell>
  );
}
