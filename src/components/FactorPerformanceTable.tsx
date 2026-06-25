"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { MetricKind, BenchmarkCode } from "@/domain/entities/analytics";
import { heatmapRgb, resolveHeatRange } from "@/domain/calculations/heatmap";
import { HORIZON_LABEL, formatMetricValue } from "@/lib/format";

type ApiRow = {
  key: string;
  label: string;
  code: string;
  cells: Record<Horizon, number | null>;
};

type ApiPayload = {
  ok: boolean;
  metric: MetricKind;
  benchmark: string;
  asOf: string | null;
  warnings: string[];
  horizons: Horizon[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
  rows: ApiRow[];
};

type SortState = { horizon: Horizon; dir: "asc" | "desc" };

const TOTAL_COLS = 3 + HORIZON_ORDER.length;

/**
 * Ranked Factor Performance grid for the Market Map tab. Renders the 14
 * MACRO14 factors as a flat sortable heatmap using the same horizons, metric
 * selector, and signed-Bloomberg heat ramp as the stock grid above it.
 *
 * Driven entirely by the parent's Metric + Benchmark state (no controls of
 * its own) so a single selector pair governs both tables.
 */
export function FactorPerformanceTable({
  metric,
  benchmark,
  reloadToken = 0,
  marketScale,
}: {
  metric: MetricKind;
  benchmark: BenchmarkCode;
  reloadToken?: number;
  /** Market map company-level per-horizon range, so factor cells share the
   * grid's scale instead of self-scaling against the 14-factor spread. */
  marketScale?: Record<Horizon, { min: number; max: number }>;
}) {
  const [data, setData] = useState<ApiPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortState>({ horizon: "D1", dir: "desc" });

  const qs = useMemo(() => {
    const u = new URLSearchParams();
    u.set("metric", metric);
    u.set("benchmark", benchmark);
    return u.toString();
  }, [metric, benchmark]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(`/api/analysis/factors/performance?${qs}`, {
        cache: "no-store",
      });
      const j = (await res.json()) as ApiPayload & { error?: string };
      if (!res.ok || !j.ok) {
        throw new Error(
          typeof j.error === "string" ? j.error : res.statusText,
        );
      }
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [qs]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const rows = useMemo<ApiRow[]>(() => {
    if (!data?.rows?.length) return [];
    const copy = [...data.rows];
    copy.sort((a, b) => {
      const av = a.cells[sort.horizon];
      const bv = b.cells[sort.horizon];
      if (av == null && bv == null) return a.label.localeCompare(b.label);
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = av - bv;
      return sort.dir === "asc" ? c : -c;
    });
    return copy;
  }, [data, sort]);

  const ranges = useMemo<Record<Horizon, { min: number; max: number }>>(() => {
    const out = {} as Record<Horizon, { min: number; max: number }>;
    if (!data?.columnRanges) {
      for (const h of HORIZON_ORDER) out[h] = { min: 0, max: 0 };
      return out;
    }
    for (const h of HORIZON_ORDER) {
      out[h] = {
        min: data.columnRanges.min[h] ?? 0,
        max: data.columnRanges.max[h] ?? 0,
      };
    }
    return out;
  }, [data]);

  const horizonAverages = useMemo(() => {
    const out = {} as Record<Horizon, number | null>;
    for (const h of HORIZON_ORDER) {
      const vals = rows
        .map((r) => r.cells[h])
        .filter((v): v is number => v != null && Number.isFinite(v));
      out[h] = vals.length
        ? vals.reduce((a, b) => a + b, 0) / vals.length
        : null;
    }
    return out;
  }, [rows]);

  const horizonHeaderRange = useMemo(() => {
    const vals = HORIZON_ORDER.map((h) => horizonAverages[h]).filter(
      (v): v is number => v != null && Number.isFinite(v),
    );
    if (vals.length === 0) return { min: 0, max: 0 };
    return { min: Math.min(...vals), max: Math.max(...vals) };
  }, [horizonAverages]);

  const toggleSort = (h: Horizon) => {
    setSort((prev) => {
      if (prev.horizon !== h) return { horizon: h, dir: "desc" };
      return { horizon: h, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  return (
    <div style={section}>
      <div style={headerStrip}>
        <h2 style={sectionTitle}>Factor Performance</h2>
        <span style={subtitle}>
          MACRO14 factors ranked by trailing performance
          {loading ? " · Loading…" : ""}
        </span>
      </div>

      {err && (
        <p style={{ color: "var(--color-negative)" }} role="alert">
          {err}
        </p>
      )}
      {data?.warnings?.length ? (
        <ul
          style={{
            color: "var(--color-warning)",
            fontSize: "12px",
            marginBottom: "0.5rem",
          }}
        >
          {data.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      <div style={tableWrap}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...thStyle, textAlign: "left", width: "1%" }}>
                Factor
              </th>
              <th style={{ ...thStyle, textAlign: "left", width: "1%" }} />
              <th style={{ ...thStyle, textAlign: "left", width: "1%" }} />
              {HORIZON_ORDER.map((h) => {
                const avg = horizonAverages[h];
                const headerBg = horizonHeaderRgb(
                  avg,
                  horizonHeaderRange.min,
                  horizonHeaderRange.max,
                  metric,
                );
                const tip =
                  avg == null
                    ? "Sort"
                    : `Avg ${formatMetricValue(avg, metric)} \u2022 Click to sort`;
                return (
                  <th
                    key={h}
                    style={{
                      ...thStyle,
                      cursor: "pointer",
                      userSelect: "none",
                      background: headerBg,
                      color: pickTextColor(headerBg),
                    }}
                    onClick={() => toggleSort(h)}
                    title={tip}
                  >
                    {HORIZON_LABEL[h]}
                    {sort.horizon === h
                      ? sort.dir === "asc"
                        ? " \u25B2"
                        : " \u25BC"
                      : ""}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} style={factorRowStyle}>
                <td style={factorLabelCell} title={`${r.label} (${r.code})`}>
                  <span style={factorLine}>
                    <span style={factorLabelText}>{r.label}</span>
                    <span style={factorCodeText}>{r.code}</span>
                  </span>
                </td>
                <td style={factorEmptyCell} />
                <td style={factorEmptyCell} />

                {HORIZON_ORDER.map((h) => {
                  const v = r.cells[h];
                  const scale = resolveHeatRange(marketScale?.[h], ranges[h]);
                  const bg = heatmapRgb(v, metric, scale.min, scale.max);
                  return (
                    <td
                      key={h}
                      style={{
                        ...tdCellStyle,
                        background: bg,
                        color: pickTextColor(bg),
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      {formatMetricValue(v, metric)}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td
                  style={{ ...emptyStateCell, color: "var(--text-secondary)" }}
                  colSpan={TOTAL_COLS}
                >
                  No factor data available. Run
                  &nbsp;<code>POST /api/analysis/factors/pipeline-refresh</code>.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Header tint that ranks horizons against each other on this row level only,
 * so the strongest horizon column reads green regardless of absolute level.
 * Mirrors `horizonHeaderRgb` in `MarketMapClient`.
 */
function horizonHeaderRgb(
  value: number | null,
  min: number,
  max: number,
  metric: MetricKind,
): string {
  if (value == null || !Number.isFinite(value)) return "#0a0a0a";
  if (max <= min) return "#0a0a0a";
  let t = (value - min) / (max - min);
  if (metric === "VOLATILITY") t = 1 - t;
  const synthetic = t * 2 - 1;
  return heatmapRgb(synthetic, "RETURN", -1, 1);
}

function pickTextColor(bg: string): string {
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)\)/.exec(bg);
  if (!m) return "#ffffff";
  const r = Number(m[1]);
  const g = Number(m[2]);
  const b = Number(m[3]);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#000000" : "#ffffff";
}

const section: CSSProperties = {
  marginTop: "12px",
};

const headerStrip: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "8px",
  marginBottom: "4px",
};

const sectionTitle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  fontWeight: 700,
  color: "var(--text-primary)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  lineHeight: 1.25,
};

const subtitle: CSSProperties = {
  fontSize: "11px",
  color: "var(--text-secondary)",
  lineHeight: 1.25,
};

const tableWrap: CSSProperties = {
  overflowX: "auto",
  border: "1px solid var(--bg-border)",
  borderRadius: 0,
  background: "var(--bg-surface)",
};

const tableStyle: CSSProperties = {
  borderCollapse: "separate",
  borderSpacing: 0,
  width: "100%",
  fontSize: "12px",
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const thStyle: CSSProperties = {
  padding: "2px 6px",
  borderBottom: "1px solid var(--bg-border)",
  background: "var(--bg-surface)",
  color: "var(--text-primary)",
  textAlign: "right",
  whiteSpace: "nowrap",
  fontWeight: 700,
  lineHeight: 1.25,
};

// Heat cell density matches the SECTOR row level in MarketMapClient
// (`HEAT_CELL_DENSITY.SECTOR`) so the two grids read as the same visual band.
const tdCellStyle: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  padding: "0 6px",
  fontSize: "12px",
  fontWeight: 700,
};

// Mirrors `SECTOR_BG` in MarketMapClient — same row level / same colour.
const FACTOR_BG = "#0a0a0a";

const factorRowStyle: CSSProperties = {
  background: FACTOR_BG,
};

const factorLabelCell: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  whiteSpace: "nowrap",
  padding: "0 6px",
  background: FACTOR_BG,
  maxWidth: "20rem",
};

const factorEmptyCell: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  whiteSpace: "nowrap",
  padding: "0 6px",
  background: FACTOR_BG,
};

const factorLine: CSSProperties = {
  display: "inline-flex",
  alignItems: "baseline",
  gap: "8px",
  maxWidth: "100%",
  overflow: "hidden",
};

// Long-form factor name. Identical to MarketMapClient's `sectorLabelText`:
// amber accent, uppercase, bold, wide letter-spacing.
const factorLabelText: CSSProperties = {
  color: "var(--color-accent)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
};

// Secondary factor code chip, sits to the right of the amber label.
// Muted secondary text colour so the amber name reads as the primary tag.
const factorCodeText: CSSProperties = {
  color: "var(--text-secondary)",
  fontWeight: 500,
  fontSize: "11px",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.02em",
  fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
};

const emptyStateCell: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  whiteSpace: "nowrap",
  padding: "8px 6px",
  background: "transparent",
};
