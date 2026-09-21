"use client";
import { PairsShell } from "@/components/analysis/pairs/PairsShell";
import { HedgeFinder } from "@/components/analysis/pairs/HedgeFinder";

export default function PairsHedgePage() {
  return (
    <PairsShell
      title="Hedge Finder"
      subtitle="Build a risk-only short basket that neutralises a long's factor exposure — then check it against the tape."
    >
      <HedgeFinder />
    </PairsShell>
  );
}
