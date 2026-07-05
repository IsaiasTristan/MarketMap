"use client";
import { Suspense } from "react";
import { FlowsClient } from "@/components/analysis/flows/FlowsClient";

export default function FlowsPage() {
  return (
    <Suspense fallback={<p style={{ padding: "1.5rem", color: "var(--text-muted)" }}>Loading flows…</p>}>
      <FlowsClient />
    </Suspense>
  );
}
