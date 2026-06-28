"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { heatSignedBloomberg } from "@/components/analysis/ui/heat";

interface QueueRow {
  ticker: string;
  companyName: string;
  sector: string | null;
  subsector: string | null;
  composite: number | null;
  rank: number | null;
  subsectorDecile: number | null;
  sectorDecile: number | null;
  newArrival: boolean;
  signals: Record<string, number | null>;
  z: Record<string, number | null>;
  nextEarningsDate: string | null;
}

interface QueuePayload {
  snapshotDate: string;
  generatedAt: string;
  count: number;
  rows: QueueRow[];
}

const SIGNAL_COLS: Array<{ key: string; label: string; title: string }> = [
  { key: "epsRevision", label: "EPS", title: "Leg A: forward EPS estimate revision (z)" },
  { key: "revenueRevision", label: "Rev", title: "Leg A: forward revenue estimate revision (z)" },
  { key: "estimateBreadth", label: "Brd", title: "Leg A: estimate-revision breadth (up-down)/total (z)" },
  { key: "ratingMomentum", label: "Rtg", title: "Leg B: net rating-change momentum (z)" },
  { key: "ptRevision", label: "PT", title: "Leg B: price-target revision (z)" },
];

function SignalBar({ z, title }: { z: number | null; title: string }) {
  if (z === null || !Number.isFinite(z)) {
    return <span title={`${title}: n/a`} style={{ color: "var(--text-muted)", fontSize: 10 }}>·</span>;
  }
  const color = heatSignedBloomberg(z, 2);
  const width = Math.min(100, Math.abs(z) * 35);
  return (
    <span
      title={`${title}: ${z.toFixed(2)}`}
      style={{ display: "inline-flex", alignItems: "center", width: 42, height: 12, background: "var(--bg-surface)" }}
    >
      <span style={{ width: `${width}%`, height: 10, background: color, marginLeft: z < 0 ? 0 : 2 }} />
    </span>
  );
}

export function MasterRankTable({ onSelectTicker }: { onSelectTicker: (t: string) => void }) {
  const [onlyNew, setOnlyNew] = useState(false);
  const [query, setQuery] = useState("");

  const { data, isLoading, error } = useQuery<QueuePayload>({
    queryKey: ["research-queue"],
    queryFn: async () => {
      const r = await fetch("/api/analysis/research/queue?limit=500");
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Failed to load queue");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = query.trim().toUpperCase();
    return all.filter((r) => {
      if (onlyNew && !r.newArrival) return false;
      if (q && !r.ticker.includes(q) && !(r.companyName ?? "").toUpperCase().includes(q)) return false;
      return true;
    });
  }, [data, onlyNew, query]);

  if (isLoading) return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading queue…</div>;
  if (error) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
        No research queue yet. Run the weekly job (admin: &quot;Run weekly ingest&quot;, or `npm run job:revision`).
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>as of {data?.snapshotDate} · {rows.length} names</span>
        <label style={{ display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
          <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
          New arrivals only
        </label>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter ticker / name"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11, padding: "2px 6px" }}
        />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "3px 6px" }}>#</th>
              <th style={{ padding: "3px 6px" }}>Ticker</th>
              <th style={{ padding: "3px 6px" }}>Company</th>
              <th style={{ padding: "3px 6px" }}>Subsector</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Composite</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Decile</th>
              {SIGNAL_COLS.map((c) => (
                <th key={c.key} style={{ padding: "3px 6px" }} title={c.title}>{c.label}</th>
              ))}
              <th style={{ padding: "3px 6px" }}>Next ER</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ticker} style={{ borderTop: "1px solid var(--chrome-border)" }}>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)" }}>{r.rank ?? ""}</td>
                <td style={{ padding: "2px 6px" }}>
                  <button
                    type="button"
                    onClick={() => onSelectTicker(r.ticker)}
                    style={{ color: "var(--color-accent)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                  >
                    {r.ticker}
                  </button>
                  {r.newArrival ? (
                    <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, color: "#000", background: "var(--color-positive)", padding: "0 3px" }}>NEW</span>
                  ) : null}
                </td>
                <td style={{ padding: "2px 6px", color: "var(--text-primary)", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.companyName}</td>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subsector ?? r.sector ?? "—"}</td>
                <td style={{ padding: "2px 6px", textAlign: "right", color: r.composite != null ? heatSignedBloomberg(r.composite, 1.5) : "var(--text-muted)", fontWeight: 600 }} className="bb-num">
                  {r.composite != null ? r.composite.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "2px 6px", textAlign: "right" }} className="bb-num">{r.subsectorDecile ?? r.sectorDecile ?? "—"}</td>
                {SIGNAL_COLS.map((c) => (
                  <td key={c.key} style={{ padding: "2px 6px" }}>
                    <SignalBar z={r.z?.[c.key] ?? null} title={c.title} />
                  </td>
                ))}
                <td style={{ padding: "2px 6px", color: "var(--text-muted)" }}>{r.nextEarningsDate ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
