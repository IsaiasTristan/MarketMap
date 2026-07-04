"use client";
/**
 * 5.4 Rotation flow — price-adjusted, equal-weighted active rotation.
 *
 * Bar length = shrunk net-diffusion (share of tracked funds that deliberately
 * TRADED into the bucket minus those that traded out, shrunk by k so a tiny
 * unanimous name doesn't peg 100%). A broad migration reads differently from one
 * whale's reallocation. The $ label is the net capital moved; the tooltip
 * carries the average fund's deliberate move in bps. Price drift is removed, so
 * a sector that merely rallied shows ~no flow.
 *
 * Stock view shows only the top-15 accumulation and bottom-15 distribution names
 * (rank-scored, never alphabetical); the long tail is reachable via the search
 * box. A size filter (all / ex-mega / mega-only) applies to the stock board.
 *
 * Falls back to the legacy holder-count flow for the earliest quarter.
 */
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RotationGroupBy, RotationPayload, RotationSizeFilter } from "@/server/services/institutional/institutional-query.service";
import { Segmented, type SegmentedOption } from "@/components/analysis/factors/shared/Segmented";
import { useFlows } from "./useFlows";
import { PanelState, fmtBps, fmtFlowDollars } from "./flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";

const GROUP_OPTIONS: SegmentedOption<RotationGroupBy>[] = [
  { value: "sector", label: "SECTOR" },
  { value: "subsector", label: "SUBSECTOR" },
  { value: "stock", label: "STOCK" },
];

const SIZE_OPTIONS: SegmentedOption<RotationSizeFilter>[] = [
  { value: "all", label: "ALL CAPS" },
  { value: "ex-mega", label: "EX-MEGA" },
  { value: "mega-only", label: "MEGA ONLY" },
];

const CAPTIONS: Record<RotationGroupBy, string> = {
  sector:
    "Net diffusion — share of tracked funds that deliberately TRADED into each sector minus those that traded out (price-adjusted & equal-weighted, one vote per fund; a sector that merely rallied shows no flow). Bar = diffusion %, label = net $ moved, hover for the average fund's bps move.",
  subsector:
    "Net diffusion by subsector — top/bottom 15 by the share of funds that deliberately traded in minus out (price-adjusted, equal-weighted). Bar = diffusion %, label = net $ moved.",
  stock:
    "Net diffusion per name — top-15 accumulation & bottom-15 distribution, ranked by breadth × participation × move size (shrunk so a 3-of-3 name isn't 100%). Bar = diffusion %, label = net $ moved. Search below for any other name.",
};

const LEGACY_CAPTION =
  "Earliest quarter — price-adjusted rotation needs a prior quarter, so this shows raw fund add/trim counts (funds adding minus trimming).";

type Group = RotationPayload["groups"][number];

/** The plotted metric: shrunk diffusion where available, else raw diffusion. */
function barValue(g: Group): number {
  return g.shrunkDiffusionPct ?? g.netDiffusionPct ?? 0;
}

function RotationTooltip({ active, payload, hasActiveFlow }: { active?: boolean; payload?: Array<{ payload: Group }>; hasActiveFlow?: boolean }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const isStock = p.companyName !== undefined;
  const diff = p.shrunkDiffusionPct ?? p.netDiffusionPct;
  return (
    <div style={{ ...bbTooltipStyle, padding: "6px 8px" }}>
      <div style={{ fontWeight: 700 }}>{p.groupKey}</div>
      {p.companyName ? (
        <div style={{ color: "var(--text-muted)" }}>{p.companyName}{p.sector ? ` · ${p.sector}` : ""}</div>
      ) : null}
      {hasActiveFlow && diff !== null && diff !== undefined ? (
        <>
          <div>
            diffusion {diff >= 0 ? "+" : "−"}{Math.abs(diff).toFixed(0)}% · avg move {fmtBps(p.activeBpsAvg)}
          </div>
          <div style={{ color: "var(--text-muted)" }}>
            {p.fundsIn ?? 0} of {p.fundsParticipating ?? 0} {isStock ? "holders" : "funds"} rotated in · {p.fundsOut ?? 0} out
          </div>
          <div style={{ color: "var(--text-muted)" }}>net flow {fmtFlowDollars(p.dollarNetFlow)}</div>
        </>
      ) : (
        <div>net {p.netFundsAdding >= 0 ? "+" : ""}{p.netFundsAdding} funds</div>
      )}
      <div style={{ color: "var(--text-muted)", opacity: 0.8, marginTop: 2 }}>
        adding {p.fundsAdding} · trimming {p.fundsTrimming} · {p.nameCount} {isStock ? "holders" : "names"}
      </div>
    </div>
  );
}

/** Search results for stock names outside the top/bottom boards. */
function StockSearch({ searchable }: { searchable: Group[] }) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const t = q.trim().toUpperCase();
    if (t.length < 1) return [];
    return searchable
      .filter((g) => g.groupKey.toUpperCase().includes(t) || (g.companyName ?? "").toUpperCase().includes(t))
      .slice(0, 12);
  }, [q, searchable]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search any name (ticker or company)…"
        style={{
          background: "var(--bg-base)", border: "1px solid var(--bg-border)", color: "var(--text-primary)",
          padding: "4px 8px", fontSize: 12, borderRadius: 0, outline: "none", maxWidth: 360,
        }}
      />
      {matches.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--bg-border)", maxWidth: 480 }}>
          {matches.map((g) => {
            const diff = g.shrunkDiffusionPct ?? g.netDiffusionPct ?? 0;
            return (
              <div key={g.groupKey} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", fontSize: 11, borderTop: "1px solid var(--bg-border)" }}>
                <span style={{ fontWeight: 700, width: 60 }}>{g.groupKey}</span>
                <span style={{ color: diff >= 0 ? "var(--color-positive)" : "var(--color-negative)", width: 54 }}>
                  {diff >= 0 ? "+" : "−"}{Math.abs(diff).toFixed(0)}% of {g.fundsParticipating ?? 0}
                </span>
                <span style={{ color: "var(--text-secondary)", width: 70 }}>{fmtFlowDollars(g.dollarNetFlow)}</span>
                {g.belowThreshold ? <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>below threshold</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RotationPanel({ period }: { period: string | null }) {
  const [groupBy, setGroupBy] = useState<RotationGroupBy>("sector");
  const [size, setSize] = useState<RotationSizeFilter>("all");

  const qs = new URLSearchParams();
  if (period) qs.set("period", period);
  if (groupBy !== "sector") qs.set("groupBy", groupBy);
  if (groupBy === "stock" && size !== "all") qs.set("size", size);
  const { data, state, error } = useFlows<RotationPayload>(
    ["flows-rotation", period, groupBy, groupBy === "stock" ? size : "all"],
    `/api/analysis/flows/rotation${qs.size ? `?${qs}` : ""}`,
  );

  const active = data?.hasActiveFlow ?? false;
  const groups = data?.groups ?? [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Segmented value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS} />
        {groupBy === "stock" && <Segmented value={size} onChange={setSize} options={SIZE_OPTIONS} />}
      </div>
      <PanelState state={state} error={error}>
        {data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{active ? CAPTIONS[groupBy] : LEGACY_CAPTION}</div>
            <div style={{ width: "100%", height: Math.max(260, groups.length * 30 + 40), background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={groups} layout="vertical" margin={{ top: 10, right: 56, bottom: 10, left: 8 }}>
                  <XAxis
                    type="number"
                    domain={active ? [-100, 100] : ["auto", "auto"]}
                    tickFormatter={active ? (v) => `${v}%` : undefined}
                    tick={{ fontSize: 10, fill: "var(--text-secondary)" }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <YAxis type="category" dataKey="groupKey" width={groupBy === "stock" ? 70 : 130} tick={{ fontSize: 11, fill: "var(--text-primary)" }} tickLine={false} axisLine={false} />
                  <ReferenceLine x={0} stroke="var(--text-muted)" />
                  <Tooltip content={<RotationTooltip hasActiveFlow={active} />} cursor={{ fill: "rgba(255,255,255,0.04)" }} />
                  <Bar dataKey={active ? barValue : "netFundsAdding"} barSize={16}>
                    {groups.map((g) => {
                      const v = active ? barValue(g) : g.netFundsAdding;
                      return <Cell key={g.groupKey} fill={v >= 0 ? "var(--color-positive)" : "var(--color-negative)"} />;
                    })}
                    <LabelList
                      dataKey={active ? "dollarNetFlow" : "netFundsAdding"}
                      position="right"
                      formatter={active ? (v) => fmtFlowDollars(Number(v)) : (v) => (Number(v) >= 0 ? `+${v}` : `${v}`)}
                      style={{ fill: "var(--text-secondary)", fontSize: 10 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            {groupBy === "stock" && data.searchable && data.searchable.length > 0 && (
              <StockSearch searchable={data.searchable} />
            )}
            {groupBy === "stock" && data.qualifyingCount !== undefined && (
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {data.qualifyingCount} names meet the ≥5-fund floor · showing top 15 accumulation & bottom 15 distribution
              </div>
            )}
          </div>
        )}
      </PanelState>
    </div>
  );
}
