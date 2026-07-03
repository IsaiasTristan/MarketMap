"use client";
/** 5.4 Rotation flow — diverging bars from a zero baseline, by sector, subsector, or stock. */
import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RotationGroupBy, RotationPayload } from "@/server/services/institutional/institutional-query.service";
import { Segmented, type SegmentedOption } from "@/components/analysis/factors/shared/Segmented";
import { useFlows } from "./useFlows";
import { PanelState } from "./flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";

const PAGE_SIZE = 100; // stock view: names per page

const GROUP_OPTIONS: SegmentedOption<RotationGroupBy>[] = [
  { value: "sector", label: "SECTOR" },
  { value: "subsector", label: "SUBSECTOR" },
  { value: "stock", label: "STOCK" },
];

const CAPTIONS: Record<RotationGroupBy, string> = {
  sector: "Net funds adding minus trimming, by sector. Diverging from a zero baseline — right = inflow, left = outflow. The macro frame for the single-name work.",
  subsector: "Net funds adding minus trimming, by subsector — top/bottom 15 by net flow. Diverging from a zero baseline — right = inflow, left = outflow.",
  stock: "Net funds adding minus trimming, per name — all names with nonzero net flow. Diverging from a zero baseline — right = inflow, left = outflow.",
};

type Group = RotationPayload["groups"][number];
function RotationTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Group }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div style={{ ...bbTooltipStyle, padding: "6px 8px" }}>
      <div style={{ fontWeight: 700 }}>{p.groupKey}</div>
      {p.companyName ? (
        <div style={{ color: "var(--text-muted)" }}>{p.companyName}{p.sector ? ` · ${p.sector}` : ""}</div>
      ) : null}
      <div>net {p.netFundsAdding >= 0 ? "+" : ""}{p.netFundsAdding} funds</div>
      <div style={{ color: "var(--text-muted)" }}>
        adding {p.fundsAdding} · trimming {p.fundsTrimming} · {p.nameCount} {p.companyName ? "holders" : "names"}
      </div>
    </div>
  );
}

export function RotationPanel({ period }: { period: string | null }) {
  const [groupBy, setGroupBy] = useState<RotationGroupBy>("sector");
  const [page, setPage] = useState(1);
  useEffect(() => {
    setPage(1);
  }, [period, groupBy]);

  const qs = new URLSearchParams();
  if (period) qs.set("period", period);
  if (groupBy !== "sector") qs.set("groupBy", groupBy);
  const { data, state, error } = useFlows<RotationPayload>(
    ["flows-rotation", period, groupBy],
    `/api/analysis/flows/rotation${qs.size ? `?${qs}` : ""}`,
  );

  const groups = data?.groups ?? [];
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageGroups = groupBy === "stock" ? groups.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : groups;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Segmented value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS} />
      <PanelState state={state} error={error}>
        {data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{CAPTIONS[groupBy]}</div>
            <div style={{ width: "100%", height: Math.max(260, pageGroups.length * 30 + 40), background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pageGroups} layout="vertical" margin={{ top: 10, right: 40, bottom: 10, left: 8 }}>
                  <XAxis type="number" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickLine={false} axisLine={false} />
                  <YAxis type="category" dataKey="groupKey" width={groupBy === "stock" ? 70 : 130} tick={{ fontSize: 11, fill: "var(--text-primary)" }} tickLine={false} axisLine={false} />
                  <ReferenceLine x={0} stroke="var(--text-muted)" />
                  <Tooltip content={<RotationTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey="netFundsAdding" barSize={16}>
                    {pageGroups.map((g) => (
                      <Cell key={g.groupKey} fill={g.netFundsAdding >= 0 ? "var(--color-positive)" : "var(--color-negative)"} />
                    ))}
                    <LabelList dataKey="netFundsAdding" position="right" formatter={(v) => (Number(v) >= 0 ? `+${v}` : `${v}`)} style={{ fill: "var(--text-secondary)", fontSize: 10 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {groupBy === "stock" && groups.length > PAGE_SIZE ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
                <button
                  type="button"
                  className="bb-tab"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  style={{ border: "1px solid var(--chrome-border)", opacity: safePage <= 1 ? 0.4 : 1 }}
                >
                  Prev
                </button>
                <span>
                  Page {safePage} of {totalPages} · showing {(safePage - 1) * PAGE_SIZE + 1}–
                  {Math.min(safePage * PAGE_SIZE, groups.length)} of {groups.length}
                </span>
                <button
                  type="button"
                  className="bb-tab"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  style={{ border: "1px solid var(--chrome-border)", opacity: safePage >= totalPages ? 0.4 : 1 }}
                >
                  Next
                </button>
              </div>
            ) : null}
          </div>
        )}
      </PanelState>
    </div>
  );
}
