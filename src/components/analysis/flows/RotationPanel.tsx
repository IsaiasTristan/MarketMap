"use client";
/** 5.4 Sector-rotation flow — diverging bars from a zero baseline. */
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RotationPayload } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { PanelState } from "./flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";

type Sector = RotationPayload["sectors"][number];
function RotationTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: Sector }> }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  return (
    <div style={{ ...bbTooltipStyle, padding: "6px 8px" }}>
      <div style={{ fontWeight: 700 }}>{p.sector}</div>
      <div>net {p.netFundsAdding >= 0 ? "+" : ""}{p.netFundsAdding} funds</div>
      <div style={{ color: "var(--text-muted)" }}>adding {p.fundsAdding} · trimming {p.fundsTrimming} · {p.nameCount} names</div>
    </div>
  );
}

export function RotationPanel({ period }: { period: string | null }) {
  const { data, state, error } = useFlows<RotationPayload>(["flows-rotation", period], `/api/analysis/flows/rotation${period ? `?period=${period}` : ""}`);

  return (
    <PanelState state={state} error={error}>
      {data && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            Net funds adding minus trimming, by sector. Diverging from a zero baseline — right = inflow, left = outflow. The macro frame for the single-name work.
          </div>
          <div style={{ width: "100%", height: Math.max(260, data.sectors.length * 30 + 40), background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.sectors} layout="vertical" margin={{ top: 10, right: 40, bottom: 10, left: 8 }}>
                <XAxis type="number" tick={{ fontSize: 10, fill: "var(--text-secondary)" }} tickLine={false} axisLine={false} />
                <YAxis type="category" dataKey="sector" width={130} tick={{ fontSize: 11, fill: "var(--text-primary)" }} tickLine={false} axisLine={false} />
                <ReferenceLine x={0} stroke="var(--text-muted)" />
                <Tooltip content={<RotationTooltip />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                <Bar dataKey="netFundsAdding" barSize={16}>
                  {data.sectors.map((s) => (
                    <Cell key={s.sector} fill={s.netFundsAdding >= 0 ? "var(--color-positive)" : "var(--color-negative)"} />
                  ))}
                  <LabelList dataKey="netFundsAdding" position="right" formatter={(v) => (Number(v) >= 0 ? `+${v}` : `${v}`)} style={{ fill: "var(--text-secondary)", fontSize: 10 }} />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </PanelState>
  );
}
