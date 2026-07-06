"use client";
/**
 * CONFLUENCE stage funnel — horizontal segmented census bar, one segment per
 * stage in adoption-sequence order (visually consistent with the Flows
 * trajectories pipeline strip). Width tracks the count; clicking a segment
 * filters the table. Counts always describe the FULL board (server-computed,
 * pre-truncation), never the filtered view.
 */
import { STAGE_ORDER, stageChipLabel, type Stage } from "@/lib/analysis/confluence/rules";
import type { ConfluencePayload } from "@/server/services/confluence.service";
import { ConfluenceMetricTip } from "./ConfluenceMetricTip";
import type { ConfluenceMetricId } from "@/lib/analysis/confluence/metric-registry";

const SEG_BG: Record<Stage, string> = {
  FULL_STACK: "#1f5b32",
  CROWDED: "#7a5215",
  PLUS_REVISIONS: "#1f4e6e",
  R_PLUS_13F: "#3d3a6e",
  F_PLUS_13F: "#4e3a5e",
  SINGLE: "#3a3a3a",
  CONFLICT: "#6e2a2a",
};

const STAGE_TIP: Record<Stage, ConfluenceMetricId> = {
  FULL_STACK: "stageFullStack",
  CROWDED: "stageCrowded",
  PLUS_REVISIONS: "stagePlusRevisions",
  R_PLUS_13F: "stageRPlus13F",
  F_PLUS_13F: "stageFPlus13F",
  SINGLE: "stageSingle",
  CONFLICT: "stageConflict",
};

export function StageFunnel({
  counts,
  active,
  onToggle,
}: {
  counts: ConfluencePayload["counts"];
  active: Stage | null;
  onToggle: (stage: Stage) => void;
}) {
  const byStage = new Map(counts.map((c) => [c.stage, c]));
  return (
    <div>
      <div style={{ display: "flex", height: 46, margin: "4px 0" }}>
        {STAGE_ORDER.map((stage) => {
          const c = byStage.get(stage) ?? { stage, long: 0, short: 0, tied: 0 };
          const total = c.long + c.short + c.tied;
          const flex = Math.max(6, total);
          const dimmed = active != null && active !== stage;
          return (
            <div
              key={stage}
              onClick={() => onToggle(stage)}
              title={`${total} names ${stageChipLabel(stage, null)} — click to ${active === stage ? "clear filter" : "filter the table"}`}
              style={{
                flex,
                minWidth: 84,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                padding: "0 12px",
                background: SEG_BG[stage],
                borderRight: "2px solid var(--bg-base)",
                cursor: "pointer",
                opacity: dimmed ? 0.4 : 1,
                outline: active === stage ? "2px solid var(--color-accent)" : "none",
              }}
            >
              <span style={{ fontSize: 10, letterSpacing: "0.06em", color: "rgba(255,255,255,.78)" }}>
                <ConfluenceMetricTip id={STAGE_TIP[stage]} style={{ borderBottom: "none", color: "inherit" }}>
                  {stageChipLabel(stage, null)}
                </ConfluenceMetricTip>
              </span>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#fff" }}>
                {total}{" "}
                <span style={{ fontSize: 10, color: "rgba(255,255,255,.6)" }}>
                  {c.long > 0 && <span style={{ color: "var(--color-positive)" }}>{c.long}▲</span>}
                  {c.long > 0 && (c.short > 0 || c.tied > 0) && "/"}
                  {c.short > 0 && <span style={{ color: "var(--color-negative)" }}>{c.short}▼</span>}
                  {c.tied > 0 && `${c.short > 0 ? "/" : ""}${c.tied}≍`}
                </span>
              </span>
            </div>
          );
        })}
      </div>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        width = names in stage · <ConfluenceMetricTip id="stackDepth">stack depth</ConfluenceMetricTip> is a
        count, never a blended score · click a segment to filter · SINGLE dominating on a young board is
        honest, not broken
      </div>
    </div>
  );
}
