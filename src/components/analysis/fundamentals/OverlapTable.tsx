"use client";

import { useQuery } from "@tanstack/react-query";
import { heatSignedBloomberg } from "@/components/analysis/ui/heat";

interface OverlapRow {
  ticker: string;
  companyName: string | null;
  sector: string | null;
  subsector: string | null;
  fundamentalComposite: number | null;
  fundamentalRank: number | null;
  fundamentalDecile: number | null;
  revisionComposite: number | null;
  revisionRank: number | null;
  revisionDecile: number | null;
  trapFlag: boolean;
  bothFlagged: boolean;
}

interface OverlapPayload {
  fundamentalDate: string | null;
  revisionDate: string | null;
  rows: OverlapRow[];
}

export function OverlapTable({ onSelectTicker }: { onSelectTicker: (t: string) => void }) {
  const { data, isLoading, error } = useQuery<OverlapPayload>({
    queryKey: ["fundamentals-overlap"],
    queryFn: async () => {
      const r = await fetch("/api/analysis/fundamentals/overlap?topDecile=8");
      if (!r.ok) throw new Error("Failed to load overlap");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading overlap…</div>;
  if (error || !data) return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Overlap unavailable.</div>;

  if (!data.revisionDate) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
        No Engine 1 (revision) scores found to overlap. Run the revision job (npm run job:revision) to enable the
        highest-conviction cross-engine view.
      </div>
    );
  }

  const both = data.rows.filter((r) => r.bothFlagged);
  const shown = data.rows.slice(0, 400);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
        Engine 1 (revisions, {data.revisionDate}) × Engine 2 (fundamentals, {data.fundamentalDate}). Names top-decile on
        BOTH and not trap-flagged are highest-conviction ({both.length} flagged). Engine 2-only = earliest,
        least-crowded.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "3px 6px" }}>Ticker</th>
              <th style={{ padding: "3px 6px" }}>Company</th>
              <th style={{ padding: "3px 6px" }}>Subsector</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Fund. comp</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Fund. dec</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Rev. comp</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Rev. dec</th>
              <th style={{ padding: "3px 6px" }}>Flag</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={r.ticker} style={{ borderTop: "1px solid var(--chrome-border)", background: r.bothFlagged ? "rgba(90,160,90,0.08)" : undefined }}>
                <td style={{ padding: "2px 6px" }}>
                  <button type="button" onClick={() => onSelectTicker(r.ticker)} style={{ color: "var(--color-accent)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0 }}>{r.ticker}</button>
                  {r.trapFlag ? <span style={{ marginLeft: 4, fontSize: 8, fontWeight: 700, color: "#fff", background: "var(--bb-red)", padding: "0 3px" }}>TRAP</span> : null}
                </td>
                <td style={{ padding: "2px 6px", color: "var(--text-primary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.companyName ?? "—"}</td>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)", maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.subsector ?? r.sector ?? "—"}</td>
                <td style={{ padding: "2px 6px", textAlign: "right", color: r.fundamentalComposite != null ? heatSignedBloomberg(r.fundamentalComposite, 1.5) : "var(--text-muted)" }} className="bb-num">{r.fundamentalComposite != null ? r.fundamentalComposite.toFixed(2) : "—"}</td>
                <td style={{ padding: "2px 6px", textAlign: "right" }} className="bb-num">{r.fundamentalDecile ?? "—"}</td>
                <td style={{ padding: "2px 6px", textAlign: "right", color: r.revisionComposite != null ? heatSignedBloomberg(r.revisionComposite, 1.5) : "var(--text-muted)" }} className="bb-num">{r.revisionComposite != null ? r.revisionComposite.toFixed(2) : "—"}</td>
                <td style={{ padding: "2px 6px", textAlign: "right" }} className="bb-num">{r.revisionDecile ?? "—"}</td>
                <td style={{ padding: "2px 6px" }}>{r.bothFlagged ? <span style={{ fontSize: 8, fontWeight: 700, color: "#000", background: "var(--color-positive)", padding: "0 3px" }}>BOTH</span> : null}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
