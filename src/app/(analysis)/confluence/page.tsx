"use client";
import { Suspense } from "react";
import { ConfluenceClient } from "@/components/analysis/confluence/ConfluenceClient";

export default function ConfluencePage() {
  return (
    <Suspense
      fallback={<p style={{ padding: "1.5rem", color: "var(--text-muted)" }}>Loading confluence…</p>}
    >
      <ConfluenceClient />
    </Suspense>
  );
}
