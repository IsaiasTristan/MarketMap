"use client";

import { useState } from "react";
import { BloombergTabStrip, type BloombergTabItem } from "@/components/analysis/BloombergTabStrip";
import { useIsAdmin } from "@/lib/api/useMe";
import { MasterRankTable } from "./MasterRankTable";
import { RevisionTrajectory } from "./RevisionTrajectory";
import { RotationFlow } from "./RotationFlow";
import { BreadthHeatmap } from "./BreadthHeatmap";

type ResearchTab = "rank" | "trajectory" | "rotation" | "heatmap";

const TABS: BloombergTabItem[] = [
  { key: "rank", label: "Master Rank" },
  { key: "trajectory", label: "Revision Trajectory" },
  { key: "rotation", label: "Rotation Flow" },
  { key: "heatmap", label: "Breadth Heatmap" },
];

export function ResearchClient() {
  const [tab, setTab] = useState<ResearchTab>("rank");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const isAdmin = useIsAdmin();

  const openTrajectory = (ticker: string) => {
    setSelectedTicker(ticker);
    setTab("trajectory");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-primary)" }}>
            ANALYST REVISION DETECTOR
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Engine 1 — where analysts are changing their minds, before price reflects it. Research queue, not a trader.
          </div>
        </div>
        {isAdmin ? <IngestButton /> : null}
      </div>

      <BloombergTabStrip tabs={TABS} activeKey={tab} onChange={(k) => setTab(k as ResearchTab)} />

      <div>
        {tab === "rank" && <MasterRankTable onSelectTicker={openTrajectory} />}
        {tab === "trajectory" && (
          <RevisionTrajectory ticker={selectedTicker} onPickTicker={setSelectedTicker} />
        )}
        {tab === "rotation" && <RotationFlow />}
        {tab === "heatmap" && <BreadthHeatmap />}
      </div>
    </div>
  );
}

function IngestButton() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await fetch("/api/analysis/research/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      setMsg(r.ok ? `Done: ${j.ingest?.snapshotsWritten ?? 0} snapshots, ${j.scoring?.scored ?? 0} scored` : j.error ?? "Failed");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {msg ? <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{msg}</span> : null}
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="bb-tab"
        style={{ border: "1px solid var(--chrome-border)", opacity: busy ? 0.6 : 1 }}
        title="Run the weekly ingestion + scoring now (admin). Heavy; prefer the scheduled job."
      >
        {busy ? "Running…" : "Run weekly ingest"}
      </button>
    </div>
  );
}
