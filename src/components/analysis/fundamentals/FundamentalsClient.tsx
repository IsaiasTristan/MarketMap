"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BloombergTabStrip, type BloombergTabItem } from "@/components/analysis/BloombergTabStrip";
import { useIsAdmin } from "@/lib/api/useMe";
import type { DiscoveryPayload } from "./types";
import { DiscoveryRankTable } from "./DiscoveryRankTable";
import { DiscoverySummary } from "./DiscoverySummary";
import { MarginInflectionDumbbell } from "./MarginInflectionDumbbell";
import { QualityValueScatter } from "./QualityValueScatter";
import { AccrualsScreen } from "./AccrualsScreen";
import { CompounderScatter } from "./CompounderScatter";
import { DiligencePanel } from "./DiligencePanel";
import { FinancialsTable } from "./FinancialsTable";
import { OverlapTable } from "./OverlapTable";

type FundTab = "rank" | "margin" | "qv" | "accruals" | "compounder" | "diligence" | "financials" | "overlap";

const TABS: BloombergTabItem[] = [
  { key: "rank", label: "Discovery Rank" },
  { key: "margin", label: "Margin Inflection" },
  { key: "qv", label: "Quality / Value" },
  { key: "accruals", label: "Accruals Screen" },
  { key: "compounder", label: "Compounders" },
  { key: "diligence", label: "Diligence" },
  { key: "financials", label: "Financials" },
  { key: "overlap", label: "Overlap" },
];

export function FundamentalsClient() {
  const [tab, setTab] = useState<FundTab>("rank");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);
  const [subsectorFilter, setSubsectorFilter] = useState<string | null>(null);
  const isAdmin = useIsAdmin();

  const { data, isLoading, error } = useQuery<DiscoveryPayload>({
    queryKey: ["fundamentals-discovery"],
    queryFn: async () => {
      const r = await fetch("/api/analysis/fundamentals/discovery?limit=3000");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Failed to load discovery queue");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const openDiligence = (ticker: string) => {
    setSelectedTicker(ticker);
    setTab("diligence");
  };

  const rows = data?.rows ?? [];
  const dataState = isLoading
    ? "loading"
    : error
      ? "error"
      : rows.length === 0
        ? "empty"
        : "ready";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-primary)" }}>
            FUNDAMENTAL-INFLECTION DISCOVERY
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Engine 2 — where the business is changing (margins, growth, returns) from the statements, before
            analysts react. Quality filters kill traps. Discovery + diligence, not a trader.
          </div>
        </div>
        {isAdmin ? <IngestButton /> : null}
      </div>

      <BloombergTabStrip tabs={TABS} activeKey={tab} onChange={(k) => setTab(k as FundTab)} />

      {tab !== "diligence" && tab !== "financials" && tab !== "overlap" && dataState !== "ready" ? (
        <DataNotice state={dataState} snapshotDate={data?.snapshotDate} />
      ) : null}

      <div>
        {tab === "rank" && (
          <>
            <DiscoverySummary
              rows={rows}
              sectorFilter={sectorFilter}
              subsectorFilter={subsectorFilter}
              onFilterChange={(sector, sub) => {
                setSectorFilter(sector);
                setSubsectorFilter(sub);
              }}
            />
            <DiscoveryRankTable
              rows={rows}
              snapshotDate={data?.snapshotDate}
              onSelectTicker={openDiligence}
              sectorFilter={sectorFilter}
              subsectorFilter={subsectorFilter}
              onSectorFilterChange={setSectorFilter}
              onSubsectorFilterChange={setSubsectorFilter}
            />
          </>
        )}
        {tab === "margin" && <MarginInflectionDumbbell rows={rows} onSelectTicker={openDiligence} />}
        {tab === "qv" && <QualityValueScatter rows={rows} onSelectTicker={openDiligence} />}
        {tab === "accruals" && <AccrualsScreen rows={rows} onSelectTicker={openDiligence} />}
        {tab === "compounder" && <CompounderScatter rows={rows} onSelectTicker={openDiligence} />}
        {tab === "diligence" && <DiligencePanel ticker={selectedTicker} onPickTicker={setSelectedTicker} />}
        {tab === "financials" && <FinancialsTable ticker={selectedTicker} onPickTicker={setSelectedTicker} />}
        {tab === "overlap" && <OverlapTable onSelectTicker={openDiligence} />}
      </div>
    </div>
  );
}

function DataNotice({ state, snapshotDate }: { state: string; snapshotDate?: string }) {
  if (state === "loading") {
    return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading discovery screen…</div>;
  }
  return (
    <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
      No discovery data yet. Run the fundamentals weekly job (admin: &quot;Run weekly ingest&quot;, or
      <code style={{ margin: "0 4px" }}>npm run job:fundamental -- --backfill</code>) to populate signals from the
      ~9-year statement history. {snapshotDate ? `(last: ${snapshotDate})` : ""}
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
      const r = await fetch("/api/analysis/fundamentals/ingest", {
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
        title="Run the weekly fundamentals ingest + scoring now (admin). Heavy; prefer the scheduled job."
      >
        {busy ? "Running…" : "Run weekly ingest"}
      </button>
    </div>
  );
}
