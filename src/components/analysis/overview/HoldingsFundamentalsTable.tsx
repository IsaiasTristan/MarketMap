"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { DiscoveryRankTable } from "@/components/analysis/fundamentals/DiscoveryRankTable";
import { DiligencePanel } from "@/components/analysis/fundamentals/DiligencePanel";
import type { DiscoveryPayload } from "@/components/analysis/fundamentals/types";

export interface HoldingsFundamentalsTableProps {
  /** The active portfolio's holding tickers. */
  tickers: string[];
  loading?: boolean;
}

export function HoldingsFundamentalsTable({
  tickers,
  loading = false,
}: HoldingsFundamentalsTableProps) {
  const [sectorFilter, setSectorFilter] = useState<string | null>(null);
  const [subsectorFilter, setSubsectorFilter] = useState<string | null>(null);
  const [excludeSectorFilter, setExcludeSectorFilter] = useState<string | null>(null);
  const [excludeSubsectorFilter, setExcludeSubsectorFilter] = useState<string | null>(null);
  const [selectedTicker, setSelectedTicker] = useState<string | null>(null);

  // Shared cache with the Fundamentals tab (same query key + endpoint).
  const { data, isLoading: discoveryLoading, error } = useQuery<DiscoveryPayload>({
    queryKey: ["fundamentals-discovery"],
    queryFn: async () => {
      const r = await fetch("/api/analysis/fundamentals/discovery?limit=3000");
      if (!r.ok) {
        throw new Error(
          (await r.json().catch(() => ({}))).reason ?? "Failed to load discovery queue",
        );
      }
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const universeRows = useMemo(() => data?.rows ?? [], [data]);

  const portfolioRows = useMemo(() => {
    const set = new Set(tickers.map((t) => t.toUpperCase()));
    return universeRows.filter((r) => set.has(r.ticker.toUpperCase()));
  }, [universeRows, tickers]);

  const busy = loading || discoveryLoading;
  const subtitle = `9-box discovery scores per holding · recomputed weekly (Sat) · as of ${
    data?.snapshotDate ?? "—"
  }`;

  return (
    <>
      <ChartCard title="Fundamentals" subtitle={subtitle}>
        {busy ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: 12,
            }}
          >
            Loading fundamentals…
          </div>
        ) : error ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--color-negative)",
              fontSize: 12,
            }}
          >
            {error instanceof Error ? error.message : "Failed to load fundamentals."}
          </div>
        ) : portfolioRows.length === 0 ? (
          <div
            style={{
              padding: 32,
              textAlign: "center",
              color: "var(--text-secondary)",
              fontSize: 12,
            }}
          >
            None of this portfolio&apos;s holdings have a fundamental score yet.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "0 2px" }}>
              {portfolioRows.length} of {tickers.length} holdings scored · scores, rank &amp;
              decile are universe-relative
            </div>
            <DiscoveryRankTable
              rows={portfolioRows}
              heatReferenceRows={universeRows}
              snapshotDate={data?.snapshotDate}
              onSelectTicker={setSelectedTicker}
              sectorFilter={sectorFilter}
              subsectorFilter={subsectorFilter}
              excludeSectorFilter={excludeSectorFilter}
              excludeSubsectorFilter={excludeSubsectorFilter}
              onSectorFilterChange={setSectorFilter}
              onSubsectorFilterChange={setSubsectorFilter}
              onExcludeSectorFilterChange={setExcludeSectorFilter}
              onExcludeSubsectorFilterChange={setExcludeSubsectorFilter}
            />
          </div>
        )}
      </ChartCard>

      {selectedTicker && (
        <DiligenceModal
          ticker={selectedTicker}
          onPickTicker={setSelectedTicker}
          onClose={() => setSelectedTicker(null)}
        />
      )}
    </>
  );
}

function DiligenceModal({
  ticker,
  onPickTicker,
  onClose,
}: {
  ticker: string;
  onPickTicker: (t: string) => void;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose();
    },
    [onClose],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!mounted) return null;

  const node = (
    <div
      role="presentation"
      onClick={handleBackdropClick}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 200,
        background: "rgba(0,0,0,0.65)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 24,
        overflowY: "auto",
      }}
    >
      <div
        role="dialog"
        aria-label={`${ticker} diligence`}
        style={{
          width: "100%",
          maxWidth: 960,
          background: "var(--bg-surface)",
          border: "1px solid var(--bg-border)",
          boxShadow: "0 12px 32px rgba(0,0,0,0.55)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            background: "var(--bb-chrome)",
            color: "#fff",
            padding: "6px 12px",
            display: "flex",
            alignItems: "center",
            gap: 10,
            height: 28,
            flexShrink: 0,
          }}
        >
          <div style={{ flex: 1, fontWeight: 700, letterSpacing: "0.05em" }}>
            {ticker} · Diligence
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              color: "#fff",
              fontSize: 14,
              cursor: "pointer",
              padding: 0,
              lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
        </div>
        <div style={{ padding: 10 }}>
          <DiligencePanel ticker={ticker} onPickTicker={onPickTicker} />
        </div>
      </div>
    </div>
  );

  return createPortal(node, document.body);
}
