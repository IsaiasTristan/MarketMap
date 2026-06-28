"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { heatSignedBloomberg } from "@/components/analysis/ui/heat";

type GroupType = "SECTOR" | "SUBSECTOR";

interface HeatmapPayload {
  groupType: GroupType;
  dates: string[];
  groups: string[];
  cells: Array<{ groupKey: string; values: Array<number | null> }>;
}

export function BreadthHeatmap() {
  const [groupType, setGroupType] = useState<GroupType>("SECTOR");

  const { data, isLoading, error } = useQuery<HeatmapPayload>({
    queryKey: ["research-heatmap", groupType],
    queryFn: async () => {
      const r = await fetch(`/api/analysis/research/heatmap?groupType=${groupType}&weeks=52`);
      if (!r.ok) throw new Error("Failed to load heatmap");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>Group</span>
        {(["SECTOR", "SUBSECTOR"] as GroupType[]).map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => setGroupType(g)}
            className={`bb-tab${groupType === g ? " bb-tab--active" : ""}`}
            style={{ border: "1px solid var(--chrome-border)" }}
          >
            {g === "SECTOR" ? "Sector" : "Subsector"}
          </button>
        ))}
        <span style={{ color: "var(--text-muted)" }}>estimate-revision breadth, groups × weeks</span>
      </div>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading heatmap…</div>
      ) : error || !data || data.dates.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
          No breadth history yet — accrues as weekly snapshots accumulate.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 10 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: "var(--bg-base)", padding: "2px 6px", textAlign: "left", color: "var(--text-muted)" }}>
                  Group
                </th>
                {data.dates.map((d) => (
                  <th key={d} style={{ padding: "2px 3px", color: "var(--text-muted)", fontWeight: 400, writingMode: "vertical-rl", transform: "rotate(180deg)", height: 56 }}>
                    {d.slice(2)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.cells.map((row) => (
                <tr key={row.groupKey}>
                  <td style={{ position: "sticky", left: 0, background: "var(--bg-base)", padding: "2px 6px", color: "var(--text-primary)", whiteSpace: "nowrap", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {row.groupKey}
                  </td>
                  {row.values.map((v, i) => (
                    <td
                      key={i}
                      title={v != null ? `${row.groupKey} ${data.dates[i]}: breadth ${v.toFixed(2)}` : "n/a"}
                      style={{ width: 14, height: 14, background: v != null ? heatSignedBloomberg(v, 0.5) : "var(--bg-surface)", border: "1px solid var(--bg-base)" }}
                    />
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
