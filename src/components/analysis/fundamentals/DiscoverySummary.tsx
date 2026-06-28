"use client";

import { Fragment, useMemo, useState } from "react";
import { heatSignedBloomberg } from "@/components/analysis/ui/heat";
import {
  buildDiscoverySummary,
  DISCOVERY_SIGNAL_KEYS,
  type DiscoverySectorSummary,
} from "@/lib/fundamental/discovery-summary";
import type { DiscoveryRow } from "./types";

const SIGNAL_LABELS: Record<(typeof DISCOVERY_SIGNAL_KEYS)[number], string> = {
  grossMarginInflection: "GM",
  ebitdaMarginInflection: "EBM",
  revenueGrowthAccel: "Rev↑",
  fcfInflection: "FCF",
  roicTrend: "ROIC",
  deleveraging: "Delev",
};

function fmt(v: number | null, dp = 2): string {
  return v != null && Number.isFinite(v) ? v.toFixed(dp) : "—";
}

function SummaryCell({ value, zScale = 2 }: { value: number | null; zScale?: number }) {
  if (value == null || !Number.isFinite(value)) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }
  return (
    <span style={{ color: heatSignedBloomberg(value, zScale), fontWeight: 600 }} className="bb-num">
      {value.toFixed(2)}
    </span>
  );
}

function SummaryRow({
  label,
  summary,
  indent = false,
  expanded,
  onToggle,
  onSelect,
  selected,
}: {
  label: string;
  summary: DiscoverySectorSummary | { key: string; nameCount: number; avgComposite: number | null; avgDecile: number | null; avgSignals: Record<string, number | null>; avgVal: number | null };
  indent?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  selected: boolean;
}) {
  return (
    <tr
      style={{
        borderTop: "1px solid var(--chrome-border)",
        background: selected ? "rgba(240, 182, 93, 0.08)" : indent ? "#0e1624" : "#1c2638",
        cursor: "pointer",
      }}
      onClick={onSelect}
    >
      <td style={{ padding: "3px 6px", paddingLeft: indent ? 20 : 6 }}>
        {onToggle ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onToggle();
            }}
            style={{ background: "none", border: "none", color: "var(--color-accent)", cursor: "pointer", padding: "0 4px 0 0", fontSize: 10 }}
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▼" : "▶"}
          </button>
        ) : null}
        <span
          style={{
            color: indent ? "var(--text-primary)" : "var(--color-accent)",
            fontWeight: indent ? 500 : 700,
            letterSpacing: indent ? 0 : 0.6,
            textTransform: indent ? "none" : "uppercase",
            fontSize: indent ? 11 : 11,
          }}
        >
          {label}
        </span>
      </td>
      <td style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-muted)" }} className="bb-num">
        {summary.nameCount}
      </td>
      <td style={{ padding: "3px 6px", textAlign: "right" }}>
        <SummaryCell value={summary.avgComposite} zScale={1.5} />
      </td>
      <td style={{ padding: "3px 6px", textAlign: "right", color: "var(--text-muted)" }} className="bb-num">
        {fmt(summary.avgDecile, 1)}
      </td>
      {DISCOVERY_SIGNAL_KEYS.map((k) => (
        <td key={k} style={{ padding: "3px 6px", textAlign: "center" }}>
          <SummaryCell value={summary.avgSignals[k] ?? null} />
        </td>
      ))}
      <td style={{ padding: "3px 6px", textAlign: "right" }} className="bb-num">
        {fmt(summary.avgVal)}
      </td>
    </tr>
  );
}

export function DiscoverySummary({
  rows,
  sectorFilter,
  subsectorFilter,
  onFilterChange,
}: {
  rows: DiscoveryRow[];
  sectorFilter: string | null;
  subsectorFilter: string | null;
  onFilterChange: (sector: string | null, subsector: string | null) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const summary = useMemo(() => buildDiscoverySummary(rows), [rows]);

  const toggleSector = (key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  if (summary.length === 0) return null;

  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 4, letterSpacing: 0.3 }}>
        SECTOR / SUBSECTOR ROLL-UP · click a row to filter the table below
        {(sectorFilter || subsectorFilter) ? (
          <button
            type="button"
            onClick={() => onFilterChange(null, null)}
            style={{ marginLeft: 8, background: "none", border: "1px solid var(--chrome-border)", color: "var(--color-accent)", fontSize: 10, cursor: "pointer", padding: "0 4px" }}
          >
            Clear filter
          </button>
        ) : null}
      </div>
      <div style={{ overflowX: "auto" }}>
        <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "3px 6px" }}>Sector / Subsector</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>N</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Composite</th>
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Decile</th>
              {DISCOVERY_SIGNAL_KEYS.map((k) => (
                <th key={k} style={{ padding: "3px 6px", textAlign: "center" }}>{SIGNAL_LABELS[k]}</th>
              ))}
              <th style={{ padding: "3px 6px", textAlign: "right" }}>Val</th>
            </tr>
          </thead>
          <tbody>
            {summary.map((sec) => {
              const isOpen = expanded.has(sec.key);
              const sectorSelected = sectorFilter === sec.key && !subsectorFilter;
              return (
                <Fragment key={sec.key}>
                  <SummaryRow
                    label={sec.key}
                    summary={sec}
                    expanded={isOpen}
                    onToggle={() => toggleSector(sec.key)}
                    onSelect={() => onFilterChange(sec.key, null)}
                    selected={sectorSelected}
                  />
                  {isOpen
                    ? sec.subsectors.map((sub) => (
                        <SummaryRow
                          key={`${sec.key}:${sub.key}`}
                          label={sub.key}
                          summary={sub}
                          indent
                          onSelect={() => onFilterChange(sec.key, sub.key)}
                          selected={sectorFilter === sec.key && subsectorFilter === sub.key}
                        />
                      ))
                    : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
