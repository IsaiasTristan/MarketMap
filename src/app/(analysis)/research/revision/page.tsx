"use client";
import { RevisionShell } from "@/components/analysis/research/screens/RevisionShell";
import { UniverseScreen } from "@/components/analysis/research/screens/UniverseScreen";

export default function RevisionUniversePage() {
  return (
    <RevisionShell
      title="Analyst revision detector"
      subtitle="Where analysts are changing their minds, and whether price has reacted yet."
    >
      <UniverseScreen />
    </RevisionShell>
  );
}
