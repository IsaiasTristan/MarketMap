"use client";
import { Suspense } from "react";
import { RevisionShell } from "@/components/analysis/research/screens/RevisionShell";
import { QueueScreen } from "@/components/analysis/research/screens/QueueScreen";

export default function RevisionQueuePage() {
  return (
    <RevisionShell
      title="Research queue"
      subtitle="Ranked on one signal: how much analysts raised price targets this week, beyond what the stock already moved."
    >
      {/* Only the table reads the URL filters, so the searchParams bail-out stays scoped to it. */}
      <Suspense fallback={<p style={{ padding: 20, color: "var(--text-muted)" }}>Loading queue…</p>}>
        <QueueScreen />
      </Suspense>
    </RevisionShell>
  );
}
