"use client";
import { Suspense } from "react";
import { ResearchClient } from "@/components/analysis/research/ResearchClient";

export default function ResearchPage() {
  return (
    <Suspense fallback={<p style={{ padding: "1.5rem", color: "var(--text-muted)" }}>Loading research…</p>}>
      <ResearchClient />
    </Suspense>
  );
}
