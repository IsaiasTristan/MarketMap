"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BloombergTabStrip, type BloombergTabItem } from "@/components/analysis/BloombergTabStrip";
import type { DiscoveryPayload } from "./types";
import { DiscoveryRankTable } from "./DiscoveryRankTable";
import { DiligencePanel } from "./DiligencePanel";
import { FinancialsTable } from "./FinancialsTable";

type FundTab = "rank" | "diligence" | "financials";

const TABS: BloombergTabItem[] = [
  { key: "rank", label: "Discovery Rank" },
  { key: "diligence", label: "Diligence" },
  { key: "financials", label: "Financials" },
];

export function FundamentalsClient() {
  const [tab, setTab] = useState<FundTab>("rank");
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);
  const [subsectorFilter, setSubsectorFilter] = useState<string | null>(null);
  const [excludeSectorFilter, setExcludeSectorFilter] = useState<string | null>(null);
  const [excludeSubsectorFilter, setExcludeSubsectorFilter] = useState<string | null>(null);

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
      </div>

      <BloombergTabStrip tabs={TABS} activeKey={tab} onChange={(k) => setTab(k as FundTab)} />

      {tab !== "diligence" && tab !== "financials" && dataState !== "ready" ? (
        <DataNotice state={dataState} snapshotDate={data?.snapshotDate} />
      ) : null}

      <div>
        {tab === "rank" && (
          <DiscoveryRankTable
            rows={rows}
            snapshotDate={data?.snapshotDate}
            onSelectTicker={openDiligence}
            sectorFilter={sectorFilter}
            subsectorFilter={subsectorFilter}
            excludeSectorFilter={excludeSectorFilter}
            excludeSubsectorFilter={excludeSubsectorFilter}
            onSectorFilterChange={setSectorFilter}
            onSubsectorFilterChange={setSubsectorFilter}
            onExcludeSectorFilterChange={setExcludeSectorFilter}
            onExcludeSubsectorFilterChange={setExcludeSubsectorFilter}
          />
        )}
        {tab === "diligence" && <DiligencePanel ticker={selectedTicker} onPickTicker={setSelectedTicker} />}
        {tab === "financials" && <FinancialsTable ticker={selectedTicker} onPickTicker={setSelectedTicker} />}
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
      No discovery data yet — it populates automatically once the fundamentals job has run (runs on server
      boot and weekly). To force a manual backfill from the ~9-year statement history, run
      <code style={{ margin: "0 4px" }}>npm run job:fundamental -- --backfill</code>. {snapshotDate ? `(last: ${snapshotDate})` : ""}
    </div>
  );
}

