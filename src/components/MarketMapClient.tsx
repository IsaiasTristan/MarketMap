"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import type { MetricKind, RowLevel } from "@/domain/entities/analytics";
import { heatmapRgb } from "@/domain/calculations/heatmap";
import { HORIZON_LABEL, formatMetricValue } from "@/lib/format";

type Row = {
  key: string;
  label: string;
  sector?: string;
  subTheme?: string;
  ticker?: string;
  cells: Record<Horizon, number | null>;
};

type ApiPayload = {
  ok: boolean;
  metric: MetricKind;
  rowLevel: RowLevel;
  benchmark: string;
  asOf: string | null;
  warnings: string[];
  horizons: Horizon[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
  rows: Row[];
};

type SortState = { horizon: Horizon; dir: "asc" | "desc" } | null;

export function MarketMapClient({
  universeId,
  initialSector,
  initialSubTheme,
  initialRowLevel,
}: {
  universeId: string;
  initialSector?: string;
  initialSubTheme?: string;
  initialRowLevel?: RowLevel;
}) {
  const [metric, setMetric] = useState<MetricKind>("RETURN");
  const [rowLevel, setRowLevel] = useState<RowLevel>(
    initialRowLevel ?? "SECTOR"
  );
  const [benchmark, setBenchmark] = useState<"SP500" | "NASDAQ" | "DOW">(
    "SP500"
  );
  const [sectorFilter, setSectorFilter] = useState(initialSector ?? "");
  const [subThemeFilter, setSubThemeFilter] = useState(initialSubTheme ?? "");
  const [data, setData] = useState<ApiPayload | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [sort, setSort] = useState<SortState>({ horizon: "Y1", dir: "desc" });

  useEffect(() => {
    setSectorFilter(initialSector ?? "");
    setSubThemeFilter(initialSubTheme ?? "");
    if (initialRowLevel) setRowLevel(initialRowLevel);
  }, [initialSector, initialSubTheme, initialRowLevel]);

  const qs = useMemo(() => {
    const u = new URLSearchParams();
    u.set("metric", metric);
    u.set("rowLevel", rowLevel);
    u.set("benchmark", benchmark);
    if (sectorFilter) u.set("sector", sectorFilter);
    if (subThemeFilter) u.set("subTheme", subThemeFilter);
    return u.toString();
  }, [metric, rowLevel, benchmark, sectorFilter, subThemeFilter]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/universes/${universeId}/market-map?${qs}`,
        { cache: "no-store" }
      );
      const j = (await res.json()) as ApiPayload & { error?: string };
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setData(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [universeId, qs]);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedRows = useMemo(() => {
    if (!data?.rows) return [];
    const rows = [...data.rows];
    if (!sort) return rows;
    const h = sort.horizon;
    rows.sort((a, b) => {
      const av = a.cells[h];
      const bv = b.cells[h];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      const c = av - bv;
      return sort.dir === "asc" ? c : -c;
    });
    return rows;
  }, [data, sort]);

  const toggleSort = (h: Horizon) => {
    setSort((prev) => {
      if (!prev || prev.horizon !== h) return { horizon: h, dir: "desc" };
      return { horizon: h, dir: prev.dir === "asc" ? "desc" : "asc" };
    });
  };

  return (
    <div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1rem",
          alignItems: "flex-end",
        }}
      >
        <label>
          <div style={{ fontSize: "0.75rem", color: "#5a6b7d" }}>Metric</div>
          <select
            value={metric}
            onChange={(e) => setMetric(e.target.value as MetricKind)}
            style={selectStyle}
          >
            <option value="RETURN">Return</option>
            <option value="EXCESS_RETURN">Excess return</option>
            <option value="VOLATILITY">Annualized realized volatility</option>
            <option value="SHARPE">Sharpe ratio</option>
          </select>
        </label>
        <label>
          <div style={{ fontSize: "0.75rem", color: "#5a6b7d" }}>Row level</div>
          <select
            value={rowLevel}
            onChange={(e) => setRowLevel(e.target.value as RowLevel)}
            style={selectStyle}
          >
            <option value="SECTOR">Sector</option>
            <option value="SUB_THEME">Sub-theme</option>
            <option value="COMPANY">Company</option>
          </select>
        </label>
        {(metric === "EXCESS_RETURN" || metric === "RETURN") && (
          <label>
            <div style={{ fontSize: "0.75rem", color: "#5a6b7d" }}>
              Benchmark (excess)
            </div>
            <select
              value={benchmark}
              onChange={(e) =>
                setBenchmark(e.target.value as typeof benchmark)
              }
              style={selectStyle}
            >
              <option value="SP500">S&amp;P 500</option>
              <option value="NASDAQ">NASDAQ</option>
              <option value="DOW">DOW</option>
            </select>
          </label>
        )}
        <button type="button" onClick={() => void load()} style={btnStyle}>
          {loading ? "Loading…" : "Refresh"}
        </button>
        {(sectorFilter || subThemeFilter) && (
          <Link
            href={`/market-map?universeId=${universeId}`}
            style={{ fontSize: "0.9rem" }}
          >
            Clear filters
          </Link>
        )}
      </div>

      {err && (
        <p style={{ color: "#a32020" }} role="alert">
          {err}
        </p>
      )}
      {data?.warnings?.length ? (
        <ul style={{ color: "#7a5a00", fontSize: "0.9rem" }}>
          {data.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      ) : null}

      <Legend metric={metric} />

      <div style={{ overflowX: "auto", border: "1px solid #cfd6e0" }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={{ ...thStyle, position: "sticky", left: 0, zIndex: 2 }}>
                Name
              </th>
              {HORIZON_ORDER.map((h) => (
                <th
                  key={h}
                  style={{
                    ...thStyle,
                    cursor: "pointer",
                    userSelect: "none",
                  }}
                  onClick={() => toggleSort(h)}
                  title="Sort"
                >
                  {HORIZON_LABEL[h]}
                  {sort?.horizon === h ? (sort.dir === "asc" ? " ▲" : " ▼") : ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((row) => (
              <tr key={row.key}>
                <td
                  style={{
                    ...tdLabelStyle,
                    position: "sticky",
                    left: 0,
                    background: "#fff",
                    zIndex: 1,
                  }}
                >
                  {rowLevel === "SECTOR" && !sectorFilter ? (
                    <Link
                      href={`/market-map?universeId=${universeId}&rowLevel=SUB_THEME&sector=${encodeURIComponent(row.key)}`}
                    >
                      {row.label}
                    </Link>
                  ) : rowLevel === "SUB_THEME" &&
                    row.sector &&
                    row.subTheme ? (
                    <Link
                      href={`/market-map?universeId=${universeId}&rowLevel=COMPANY&sector=${encodeURIComponent(row.sector)}&subTheme=${encodeURIComponent(row.subTheme)}`}
                    >
                      {row.label}
                    </Link>
                  ) : (
                    row.label
                  )}
                </td>
                {HORIZON_ORDER.map((h) => {
                  const v = row.cells[h];
                  const bg = heatmapRgb(
                    v,
                    metric,
                    data?.columnRanges.min[h] ?? 0,
                    data?.columnRanges.max[h] ?? 0
                  );
                  return (
                    <td
                      key={h}
                      style={{
                        ...tdCellStyle,
                        background: bg,
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
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Legend({ metric }: { metric: MetricKind }) {
  if (metric === "VOLATILITY") {
    return (
      <p style={{ fontSize: "0.8rem", color: "#4a5a6b", marginBottom: "0.5rem" }}>
        Volatility heatmap: lighter = lower annualized realized volatility, darker
        = higher.
      </p>
    );
  }
  if (metric === "SHARPE") {
    return (
      <p style={{ fontSize: "0.8rem", color: "#4a5a6b", marginBottom: "0.5rem" }}>
        Sharpe heatmap: red = weaker risk-adjusted, green = stronger (methodology
        in docs).
      </p>
    );
  }
  return (
    <p style={{ fontSize: "0.8rem", color: "#4a5a6b", marginBottom: "0.5rem" }}>
      Return / excess heatmap: red = negative, green = positive vs column min/max.
    </p>
  );
}

const selectStyle: CSSProperties = {
  minWidth: "11rem",
  padding: "0.35rem 0.5rem",
  borderRadius: 4,
  border: "1px solid #b8c0cc",
};

const btnStyle: CSSProperties = {
  padding: "0.4rem 0.9rem",
  borderRadius: 4,
  border: "1px solid #1a3a5c",
  background: "#1a3a5c",
  color: "#fff",
  cursor: "pointer",
};

const tableStyle: CSSProperties = {
  borderCollapse: "collapse",
  width: "100%",
  fontSize: "0.88rem",
};

const thStyle: CSSProperties = {
  padding: "0.5rem 0.65rem",
  borderBottom: "2px solid #cfd6e0",
  background: "#f0f2f6",
  textAlign: "right",
  whiteSpace: "nowrap",
};

const tdLabelStyle: CSSProperties = {
  padding: "0.45rem 0.65rem",
  borderBottom: "1px solid #e4e8ee",
  maxWidth: "14rem",
};

const tdCellStyle: CSSProperties = {
  padding: "0.45rem 0.65rem",
  borderBottom: "1px solid #e4e8ee",
};
