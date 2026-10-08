"use client";
import { use } from "react";
import { RevisionShell } from "@/components/analysis/research/screens/RevisionShell";
import { NameScreen } from "@/components/analysis/research/screens/NameScreen";

export default function RevisionNamePage({ params }: { params: Promise<{ ticker: string }> }) {
  const { ticker } = use(params);
  const symbol = decodeURIComponent(ticker).toUpperCase();
  return (
    <RevisionShell title={symbol} subtitle="Every price target behind this name's score.">
      <NameScreen ticker={symbol} />
    </RevisionShell>
  );
}
