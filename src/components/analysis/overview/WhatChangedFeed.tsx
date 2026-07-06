"use client";
/**
 * WHAT CHANGED — severity-ranked feed of the highest-impact signal events,
 * held names first (held-negative → held-positive → strongest non-held new
 * ideas → at most one group-rotation line). Rows are precomputed server-side
 * by the signal-brief rules; each deep-links to the relevant tab pre-filtered.
 * An empty feed is a valid, fast outcome. Modeled on the research SummaryPanel
 * transition rows.
 */
import { useRouter } from "next/navigation";
import type { FeedRowDto } from "@/server/services/signal-brief.service";
import { SignalMetricTip } from "./SignalMetricTip";

const SOURCE_COLOR: Record<FeedRowDto["source"], string> = {
  REV: "var(--color-accent)",
  "13F": "#5aa0ff",
};

/** Short display tag per event kind (transition types + flow event kinds). */
const KIND_TAG: Record<string, string> = {
  NEW_LONG: "LONG",
  NEW_SHORT: "SHORT",
  GAP_CLOSED: "GAP CLOSED",
  STREAK_BROKEN: "STRK BREAK",
  NEXT_DOMINO: "DOMINO",
  stasis_break: "STASIS BREAK",
  stage_transition: "LIFECYCLE",
  NEW_ACCUMULATION: "NEW ACCUM",
  GROUP_ROTATION: "ROTATION",
};

export function WhatChangedFeed({
  rows,
  sinceDate,
}: {
  rows: FeedRowDto[];
  sinceDate: string | null;
}) {
  const router = useRouter();

  if (rows.length === 0) {
    return (
      <div style={{ padding: 16, fontSize: 11, color: "var(--text-muted)" }}>
        no signal changes since {sinceDate ?? "the last snapshot"}
      </div>
    );
  }

  return (
    <div>
      {rows.map((r, i) => (
        <button
          key={`${r.source}-${r.ticker ?? "rotation"}-${r.kind}-${i}`}
          type="button"
          onClick={() => router.push(r.href)}
          style={{
            display: "flex",
            alignItems: "baseline",
            gap: 7,
            padding: "4px 8px",
            width: "100%",
            textAlign: "left",
            background: "transparent",
            border: "none",
            borderTop: i > 0 ? "1px solid var(--chrome-border)" : "none",
            borderLeft: `2px solid ${r.positive ? "var(--color-positive)" : "var(--color-negative)"}`,
            cursor: "pointer",
            font: "inherit",
          }}
        >
          <span
            style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: SOURCE_COLOR[r.source],
              border: `1px solid ${SOURCE_COLOR[r.source]}`,
              padding: "0 3px",
              flexShrink: 0,
            }}
          >
            {r.source}
          </span>
          <span
            style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 0.4,
              color: r.positive ? "var(--color-positive)" : "var(--color-negative)",
              flexShrink: 0,
              minWidth: 52,
            }}
          >
            {KIND_TAG[r.kind] ?? r.kind}
          </span>
          {r.ticker && (
            <span style={{ fontSize: 11, fontWeight: 700, color: "var(--color-accent)", flexShrink: 0 }}>
              {r.ticker}
              {r.held && r.weight != null && (
                <span style={{ fontWeight: 400, color: "var(--text-muted)" }}>
                  {" "}
                  {(r.weight * 100).toFixed(1)}%
                </span>
              )}
            </span>
          )}
          <span
            style={{
              fontSize: 10,
              color: "var(--text-primary)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {r.sentence}
          </span>
        </button>
      ))}
      <div style={{ padding: "4px 8px", fontSize: 9, color: "var(--text-muted)" }}>
        <SignalMetricTip id="severityOrder">severity order</SignalMetricTip>
        {" · click a row to open it pre-filtered"}
      </div>
    </div>
  );
}
