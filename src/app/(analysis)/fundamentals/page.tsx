"use client";
import { Suspense } from "react";
import { FundamentalsClient } from "@/components/analysis/fundamentals/FundamentalsClient";

export default function FundamentalsPage() {
  return (
    <Suspense fallback={<p style={{ padding: "1.5rem", color: "var(--text-muted)" }}>Loading fundamentals…</p>}>
      <FundamentalsClient />
    </Suspense>
  );
}
