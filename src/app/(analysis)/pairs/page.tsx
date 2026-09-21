"use client";
import { PairsShell } from "@/components/analysis/pairs/PairsShell";
import { PairMap } from "@/components/analysis/pairs/PairMap";

export default function PairsPage() {
  return (
    <PairsShell
      title="Pairs"
      subtitle="Groups whose signals are diverging while their price ratio hasn't reacted yet."
    >
      <PairMap />
    </PairsShell>
  );
}
