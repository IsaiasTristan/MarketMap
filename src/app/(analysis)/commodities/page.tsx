"use client";
import { Suspense } from "react";
import { CommoditiesClient } from "@/components/analysis/commodities/CommoditiesClient";

export default function CommoditiesPage() {
  return (
    <Suspense
      fallback={<p style={{ padding: "1.5rem", color: "var(--text-muted)" }}>Loading commodities…</p>}
    >
      <CommoditiesClient />
    </Suspense>
  );
}
