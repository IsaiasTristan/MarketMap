"use client";
/**
 * Engine 3 — Institutional Capital-Flow (Flows) dashboard shell.
 *
 * Where institutional money is accumulating/distributing, how crowded and
 * high-conviction each trade is, and where capital rotates across sectors —
 * from quarterly 13F filings of a curated watchlist. Lagging confirmation
 * signal; every view is timestamped with the filing as-of date. Not a
 * trade-recommendation system.
 */
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { BloombergTabStrip, type BloombergTabItem } from "@/components/analysis/BloombergTabStrip";
import { useIsAdmin } from "@/lib/api/useMe";
import { useFlows } from "./useFlows";
import { AsOfBanner, quarterLabel } from "./flowsUi";
import { OverviewPanel } from "./OverviewPanel";
import { QuadrantPanel } from "./QuadrantPanel";
import { TrajectoryGridPanel } from "./TrajectoryGridPanel";
import { RotationPanel } from "./RotationPanel";
import { SignalsPanel } from "./SignalsPanel";
import { WatchlistPanel } from "./WatchlistPanel";
import { LedgerPanel } from "./LedgerPanel";

type FlowTab = "overview" | "quadrant" | "trajectories" | "rotation" | "signals" | "watchlist";
const TABS: BloombergTabItem[] = [
  { key: "overview", label: "Overview" },
  { key: "quadrant", label: "Crowding × Conviction" },
  { key: "trajectories", label: "Trajectories" },
  { key: "rotation", label: "Sector Rotation" },
  { key: "signals", label: "First-Mover / Exits" },
  { key: "watchlist", label: "Watchlist" },
];

export function FlowsClient() {
  const isAdmin = useIsAdmin();
  const qc = useQueryClient();
  const [tab, setTab] = useState<FlowTab>("overview");
  const [period, setPeriod] = useState<string | null>(null);
  const [ticker, setTicker] = useState<string | null>(null);
  const [ingesting, setIngesting] = useState(false);
  const [ingestMsg, setIngestMsg] = useState<string | null>(null);

  const { data: periodsData } = useFlows<{ periods: string[] }>(["flows-periods"], "/api/analysis/flows/periods");
  const periods = periodsData?.periods ?? [];
  const activePeriod = period ?? periods[0] ?? null;

  const select = (t: string) => setTicker(t.toUpperCase());

  async function refresh() {
    setIngesting(true);
    setIngestMsg(null);
    try {
      const r = await fetch("/api/analysis/flows/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: "refresh" }) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Ingest failed");
      // Only refetch Flows queries — not every engine's cache in the shared client.
      await qc.invalidateQueries({
        predicate: (q) => typeof q.queryKey[0] === "string" && (q.queryKey[0] as string).startsWith("flows-"),
      });
      setIngestMsg("Refreshed latest quarter.");
    } catch (e) {
      setIngestMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setIngesting(false);
    }
  }

  const content = useMemo(() => {
    switch (tab) {
      case "overview": return <OverviewPanel period={activePeriod} onSelectTicker={select} />;
      case "quadrant": return <QuadrantPanel period={activePeriod} onSelectTicker={select} />;
      case "trajectories": return <TrajectoryGridPanel period={activePeriod} onSelectTicker={select} />;
      case "rotation": return <RotationPanel period={activePeriod} />;
      case "signals": return <SignalsPanel period={activePeriod} onSelectTicker={select} />;
      case "watchlist": return <WatchlistPanel isAdmin={isAdmin} />;
    }
  }, [tab, activePeriod, isAdmin]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.4px", color: "var(--text-primary)" }}>FLOWS — INSTITUTIONAL CAPITAL FLOW</div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            Engine 3 · where smart money is accumulating, how crowded, how fast, and where it rotates. Confirmation signal — the system surfaces candidates; you confirm the thesis.
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {periods.length > 0 && (
            <select value={activePeriod ?? ""} onChange={(e) => setPeriod(e.target.value)} style={{ height: 22, padding: "0 6px", background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", color: "var(--text-primary)", fontSize: 11, borderRadius: 0 }}>
              {periods.map((p) => <option key={p} value={p}>{quarterLabel(p)} · {p}</option>)}
            </select>
          )}
          {isAdmin && (
            <button type="button" onClick={refresh} disabled={ingesting} style={{ padding: "3px 10px", border: "1px solid var(--chrome-border)", background: "var(--bg-base)", color: "var(--text-secondary)", fontSize: 11, cursor: ingesting ? "wait" : "pointer", borderRadius: 0 }}>
              {ingesting ? "Refreshing…" : "↻ Refresh 13F"}
            </button>
          )}
        </div>
      </div>

      <AsOfBanner period={activePeriod} extra={ingestMsg ? <span style={{ opacity: 0.9 }}>· {ingestMsg}</span> : undefined} />

      <BloombergTabStrip tabs={TABS} activeKey={tab} onChange={(k) => { setTab(k as FlowTab); setTicker(null); }} />

      {ticker && (
        <div style={{ marginBottom: 4 }}>
          <LedgerPanel ticker={ticker} period={activePeriod} onClose={() => setTicker(null)} />
        </div>
      )}

      <div>{content}</div>
    </div>
  );
}
