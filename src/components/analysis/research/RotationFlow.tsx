"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

type GroupType = "SECTOR" | "SUBSECTOR";

interface RotationPayload {
  groupType: GroupType;
  dates: string[];
  series: Array<{ groupKey: string; points: Array<{ date: string; compositeMean: number | null; breadth: number | null }> }>;
}

const PALETTE = [
  "#fa8000", "#00c800", "#5aa0ff", "#d8a0ff", "#ffd24a", "#ff6f6f",
  "#4ad6c0", "#b0b0b0", "#9ae86a", "#ff9ad2", "#7a9cff", "#e0c060",
];

export function RotationFlow() {
  const [groupType, setGroupType] = useState<GroupType>("SECTOR");

  const { data, isLoading, error } = useQuery<RotationPayload>({
    queryKey: ["research-rotation", groupType],
    queryFn: async () => {
      const r = await fetch(`/api/analysis/research/rotation?groupType=${groupType}&weeks=52`);
      if (!r.ok) throw new Error("Failed to load rotation");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const { chartData, groups } = useMemo(() => {
    if (!data) return { chartData: [] as Array<Record<string, unknown>>, groups: [] as string[] };
    // Rank groups by latest composite mean; cap to top 12 for legibility.
    const ranked = [...data.series]
      .map((s) => ({ key: s.groupKey, last: s.points[s.points.length - 1]?.compositeMean ?? -Infinity }))
      .sort((a, b) => b.last - a.last)
      .slice(0, 12)
      .map((g) => g.key);
    const set = new Set(ranked);
    const byDate = new Map<string, Record<string, unknown>>();
    for (const d of data.dates) byDate.set(d, { date: d });
    for (const s of data.series) {
      if (!set.has(s.groupKey)) continue;
      for (const p of s.points) {
        const row = byDate.get(p.date);
        if (row) row[s.groupKey] = p.compositeMean;
      }
    }
    return { chartData: [...byDate.values()], groups: ranked };
  }, [data]);

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
        <span style={{ color: "var(--text-muted)" }}>composite mean over time — which groups are turning</span>
      </div>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading rotation…</div>
      ) : error || !data || data.dates.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
          No rotation history yet — accrues as weekly snapshots accumulate.
        </div>
      ) : (
        <div style={{ height: 360, background: "var(--bg-surface)", padding: 6 }}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
              <CartesianGrid stroke="var(--chrome-border)" strokeDasharray="2 2" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
              <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
              <Tooltip contentStyle={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 10 }} />
              {groups.map((g, i) => (
                <Line key={g} type="monotone" dataKey={g} stroke={PALETTE[i % PALETTE.length]} dot={false} connectNulls strokeWidth={1.5} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
