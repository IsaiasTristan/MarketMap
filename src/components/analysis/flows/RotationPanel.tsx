"use client";
/**
 * 5.4 Rotation flow — price-adjusted, equal-weighted active rotation.
 *
 * Bar length = net diffusion % (share of tracked funds that deliberately rotated
 * INTO the bucket minus those that rotated OUT), so a broad migration reads
 * differently from one whale's reallocation. The $ label is the net capital
 * moved; the tooltip carries the average fund's deliberate move in bps. Price
 * drift is removed, so a sector that merely rallied shows ~no flow.
 *
 * Falls back to the legacy holder-count flow for the earliest quarter (no prior
 * quarter to diff prices against).
 */
import { useEffect, useState } from "react";
import { Bar, BarChart, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { RotationGroupBy, RotationPayload } from "@/server/services/institutional/institutional-query.service";
import { Segmented, type SegmentedOption } from "@/components/analysis/factors/shared/Segmented";
import { useFlows } from "./useFlows";
import { PanelState, fmtBps, fmtFlowDollars } from "./flowsUi";
import { bbTooltipStyle } from "@/components/analysis/ui/chartStyle";

const PAGE_SIZE = 100; // stock view: names per page

const GROUP_OPTIONS: SegmentedOption<RotationGroupBy>[] = [
  { value: "sector", label: "SECTOR" },
  { value: "subsector", label: "SUBSECTOR" },
  { value: "stock", label: "STOCK" },
];

const CAPTIONS: Record<RotationGroupBy, string> = {
  sector:
    "Net diffusion — share of tracked funds that deliberately rotated INTO each sector minus those that rotated OUT (price-adjusted & equal-weighted, one vote per fund; a sector that merely rallied shows no flow). Bar = diffusion %, label = net $ moved, hover for the average fund's bps move.",
  subsector:
    "Net diffusion by subsector — top/bottom 15 by the share of funds that deliberately rotated in minus out (price-adjusted, equal-weighted). Bar = diffusion %, label = net $ moved.",
  stock:
    "Net diffusion per name — funds that added weight minus those that trimmed it (price-adjusted, equal-weighted), among names ≥3 funds traded. Bar = diffusion %, label = net $ moved.",
};

const LEGACY_CAPTION =
  "Earliest quarter — price-adjusted rotation needs a prior quarter, so this shows raw fund add/trim counts (funds adding minus trimming).";

type Group = RotationPayload["groups"][number];

function RotationTooltip({ active, payload, hasActiveFlow }: { active?: boolean; payload?: Array<{ payload: Group }>; hasActiveFlow?: boolean }) {
  if (!active || !payload?.length) return null;
  const p = payload[0]!.payload;
  const isStock = p.companyName !== undefined;
  return (
    <div style={{ ...bbTooltipStyle, padding: "6px 8px" }}>
      <div style={{ fontWeight: 700 }}>{p.groupKey}</div>
      {p.companyName ? (
        <div style={{ color: "var(--text-muted)" }}>{p.companyName}{p.sector ? ` · ${p.sector}` : ""}</div>
      ) : null}
      {hasActiveFlow && p.netDiffusionPct !== null ? (
        <>
          <div>
            diffusion {p.netDiffusionPct >= 0 ? "+" : "−"}{Math.abs(p.netDiffusionPct).toFixed(0)}% · avg move {fmtBps(p.activeBpsAvg)}
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

  const active = data?.hasActiveFlow ?? false;
  const groups = data?.groups ?? [];
  const totalPages = Math.max(1, Math.ceil(groups.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageGroups = groupBy === "stock" ? groups.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE) : groups;

  const barKey = active ? "netDiffusionPct" : "netFundsAdding";
  const valOf = (g: Group): number => (active ? g.netDiffusionPct ?? 0 : g.netFundsAdding);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <Segmented value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS} />
      <PanelState state={state} error={error}>
        {data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{active ? CAPTIONS[groupBy] : LEGACY_CAPTION}</div>
            <div style={{ width: "100%", height: Math.max(260, pageGroups.length * 30 + 40), background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pageGroups} layout="vertical" margin={{ top: 10, right: 56, bottom: 10, left: 8 }}>
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
                  <Bar dataKey={barKey} barSize={16}>
                    {pageGroups.map((g) => (
                      <Cell key={g.groupKey} fill={valOf(g) >= 0 ? "var(--color-positive)" : "var(--color-negative)"} />
                    ))}
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
            {groupBy === "stock" && groups.length > PAGE_SIZE ? (
              <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
                <button
                  type="button"
                  className="bb-tab"
                  disabled={safePage <= 1}
                  onClick={() => setPage((pp) => Math.max(1, pp - 1))}
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
                  onClick={() => setPage((pp) => Math.min(totalPages, pp + 1))}
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
