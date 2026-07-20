"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import { heatmapRgb, resolveHeatRange } from "@/domain/calculations/heatmap";
import { quantileSorted } from "@/domain/calculations/percentile-range";
import { HORIZON_LABEL, formatMetricValue } from "@/lib/format";
import { isExcludedSector } from "@/lib/market-map/excluded-sectors";
import { sectorColor, subThemeColor } from "@/lib/market-map/sector-colors";

/**
 * TopMoversTable — bottom-of-page ranking of the top 20 best and worst
 * performing tickers in the universe for the selected horizon. Always
 * ranks by total RETURN (independent of the page's metric selector) so
 * the section reliably surfaces movers regardless of how the main grid
 * is currently coloured.
 *
 * Data source:
 *   • If the parent's metric is already RETURN, the parent passes its
 *     `companyLeaves` (already loaded for the main grid) and we skip the
 *     extra fetch entirely.
 *   • Otherwise we fetch `metric=RETURN` once — returns are
 *     benchmark-independent so we always use SP500 to maximise cache hits.
 *
 * Rows are clickable and reuse the same `onSelectTicker` callback used by
 * the main hierarchy grid; clicking opens the factors-tab floating
 * per-stock popup (or closes it if already open).
 *
 * `mode="zscore"` renders the same section ranked by the volatility-adjusted
 * return (the server's `zCells`: return ÷ own trailing σ_daily × √N), so it
 * surfaces *unusual* moves instead of the perma-volatile names that dominate
 * the raw list. Z-mode always own-fetches the RETURN payload (warm cache) and
 * maps `cells` to `zCells`, so all ranking/heat logic below is shared.
 */

const RANK_LIMIT = 20;

type MoversMode = "return" | "zscore";

type CompanyLeaf = {
  ticker: string;
  name: string;
  sector: string;
  subTheme: string;
  cells: Record<Horizon, number | null>;
  /** Raw per-horizon returns, kept in z-mode for the value-cell tooltip. */
  rawCells?: Record<Horizon, number | null>;
  lastDate?: string | null;
};

type ApiRow = {
  key: string;
  label: string;
  sector?: string;
  subTheme?: string;
  ticker?: string;
  cells: Record<Horizon, number | null>;
  zCells?: Record<Horizon, number | null>;
  lastDate?: string | null;
};

const EMPTY_CELLS: Record<Horizon, number | null> = {
  D1: null,
  D5: null,
  M1: null,
  M3: null,
  M6: null,
  Y1: null,
};

type ApiPayload = {
  ok: boolean;
  metric: string;
  benchmark: string;
  asOf: string | null;
  warnings: string[];
  horizons: Horizon[];
  columnRanges: { min: Record<string, number>; max: Record<string, number> };
  rows: ApiRow[];
};

interface TopMoversTableProps {
  universeId: string;
  reloadToken?: number;
  /** Pre-loaded company leaves from the parent grid when the parent's metric
   * is RETURN. When provided, no extra fetch is issued. Ignored in z-mode
   * (grid leaves carry raw returns, not zCells). */
  companyLeaves: CompanyLeaf[] | null;
  onSelectTicker: (ticker: string) => void;
  selectedTickers: Set<string>;
  /** Market map company-level per-horizon range, so movers share the grid's
   * scale instead of self-scaling against the displayed leaves. Ignored in
   * z-mode (the grid scale is %-denominated; z uses its own local range). */
  marketScale?: Record<Horizon, { min: number; max: number }>;
  /** "return" (default) ranks raw trailing returns; "zscore" ranks the
   * volatility-adjusted returns from the payload's `zCells`. */
  mode?: MoversMode;
}

export function TopMoversTable({
  universeId,
  reloadToken = 0,
  companyLeaves,
  onSelectTicker,
  selectedTickers,
  marketScale,
  mode = "return",
}: TopMoversTableProps) {
  const [horizon, setHorizon] = useState<Horizon>("D1");
  const [ownData, setOwnData] = useState<CompanyLeaf[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const isZ = mode === "zscore";
  const needOwnFetch = isZ || companyLeaves == null;

  const load = useCallback(async () => {
    if (!needOwnFetch) return;
    setLoading(true);
    setErr(null);
    try {
      const res = await fetch(
        `/api/universes/${universeId}/market-map?metric=RETURN&rowLevel=COMPANY&benchmark=SP500`,
        { cache: "no-store" },
      );
      const j = (await res.json()) as ApiPayload & { error?: string };
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      // Apply the same Performance-page sector exclusion the parent grid uses
      // so the movers list never surfaces index / macro instruments.
      const filteredRows = j.rows.filter((r) => !isExcludedSector(r.sector));
      const leaves: CompanyLeaf[] = filteredRows.map((r) => ({
        ticker: r.ticker ?? r.key,
        name: r.label.includes("\u2014")
          ? r.label.split("\u2014").slice(1).join("\u2014").trim()
          : r.label,
        sector: r.sector ?? "Unknown",
        subTheme: r.subTheme ?? "Unknown",
        // Z-mode ranks the volatility-adjusted cells; the raw returns ride
        // along for the value-cell tooltip. A pre-feature cached blob has no
        // zCells yet \u2014 empty cells render the hint until the background
        // revalidate lands (the route marks such responses `refreshing`).
        cells: isZ ? (r.zCells ?? EMPTY_CELLS) : r.cells,
        ...(isZ ? { rawCells: r.cells } : {}),
        lastDate: r.lastDate ?? null,
      }));
      setOwnData(leaves);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setOwnData(null);
    } finally {
      setLoading(false);
    }
  }, [needOwnFetch, universeId, isZ]);

  useEffect(() => {
    if (needOwnFetch) void load();
    else setOwnData(null);
  }, [needOwnFetch, load, reloadToken]);

  const leaves = (isZ ? ownData : (companyLeaves ?? ownData)) ?? [];

  // Rank desc by the selected horizon's return; null cells go to the bottom
  // of both lists so they never spuriously appear as "best" or "worst".
  const { gainers, losers, range } = useMemo(() => {
    const withVal = leaves.filter(
      (c) =>
        c.cells[horizon] != null && Number.isFinite(c.cells[horizon] as number),
    );
    const sortedDesc = [...withVal].sort(
      (a, b) => (b.cells[horizon] as number) - (a.cells[horizon] as number),
    );
    const top = sortedDesc.slice(0, RANK_LIMIT);
    const bottom = sortedDesc.slice(-RANK_LIMIT).reverse();
    const vals = withVal.map((c) => c.cells[horizon] as number);
    let min = 0;
    let max = 0;
    if (vals.length) {
      if (isZ) {
        // Winsorized p5/p95 span (same convention as the server's column
        // ranges) so a single extreme-σ artifact can't wash out the ramp.
        const sorted = [...vals].sort((a, b) => a - b);
        min = quantileSorted(sorted, 0.05);
        max = quantileSorted(sorted, 0.95);
      } else {
        min = Math.min(...vals);
        max = Math.max(...vals);
      }
    }
    return { gainers: top, losers: bottom, range: { min, max } };
  }, [leaves, horizon, isZ]);

  // Prefer the shared market-map company scale for the selected horizon; fall
  // back to the locally computed leaf range when it is unavailable. Z-mode
  // always self-scales — the grid scale is in % units, not sigmas.
  const heatRange = resolveHeatRange(isZ ? undefined : marketScale?.[horizon], range);

  return (
    <div style={section}>
      <div style={headerStrip}>
        <h2 style={sectionTitle}>
          {isZ ? "Top Movers (Z-Scored)" : "Top Movers"}
        </h2>
        <span style={subtitle}>
          {isZ
            ? `Top ${RANK_LIMIT} gainers and losers by z-scored trailing return (move \u00f7 own trailing vol)`
            : `Top ${RANK_LIMIT} gainers and losers by trailing return`}
          {loading ? " \u00b7 Loading\u2026" : ""}
        </span>
        <div style={horizonToggleRow} role="tablist" aria-label="Horizon">
          {HORIZON_ORDER.map((h) => {
            const active = h === horizon;
            return (
              <button
                key={h}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setHorizon(h)}
                style={active ? horizonBtnActive : horizonBtn}
                title={`Rank by ${HORIZON_LABEL[h]} return`}
              >
                {HORIZON_LABEL[h]}
              </button>
            );
          })}
        </div>
      </div>

      {err && (
        <p style={{ color: "var(--color-negative)" }} role="alert">
          {err}
        </p>
      )}

      <div style={twoColRow}>
        <MoversList
          title={`Top ${RANK_LIMIT} Gainers`}
          rows={gainers}
          horizon={horizon}
          range={heatRange}
          mode={mode}
          onSelectTicker={onSelectTicker}
          selectedTickers={selectedTickers}
          emptyHint={
            isZ
              ? "No z-score data for the selected horizon (refresh in progress or insufficient history)."
              : "No return data available for the selected horizon."
          }
        />
        <MoversList
          title={`Top ${RANK_LIMIT} Losers`}
          rows={losers}
          horizon={horizon}
          range={heatRange}
          mode={mode}
          onSelectTicker={onSelectTicker}
          selectedTickers={selectedTickers}
          emptyHint={
            isZ
              ? "No z-score data for the selected horizon (refresh in progress or insufficient history)."
              : "No return data available for the selected horizon."
          }
        />
      </div>
    </div>
  );
}

function MoversList({
  title,
  rows,
  horizon,
  range,
  mode,
  onSelectTicker,
  selectedTickers,
  emptyHint,
}: {
  title: string;
  rows: CompanyLeaf[];
  horizon: Horizon;
  range: { min: number; max: number };
  mode: MoversMode;
  onSelectTicker: (ticker: string) => void;
  selectedTickers: Set<string>;
  emptyHint: string;
}) {
  const isZ = mode === "zscore";
  return (
    <div style={tableWrap}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: "1%", textAlign: "right" }}>#</th>
            <th style={{ ...thStyle, textAlign: "left" }}>{title}</th>
            <th style={{ ...thStyle, textAlign: "left", width: "1%" }}>
              Ticker
            </th>
            <th style={{ ...thStyle, textAlign: "left" }}>Sector</th>
            <th style={{ ...thStyle, textAlign: "left" }}>Sub-Theme</th>
            <th style={{ ...thStyle, textAlign: "right", width: "1%" }}>
              {HORIZON_LABEL[horizon]}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, idx) => {
            const v = c.cells[horizon];
            const bg = heatmapRgb(v, "RETURN", range.min, range.max);
            const isSelected = selectedTickers.has(c.ticker);
            const rowBg = isSelected ? SELECTED_ROW_BG : COMPANY_BG;
            const sectorClr = sectorColor(c.sector);
            const subThemeClr = subThemeColor(c.sector, c.subTheme);
            return (
              <tr
                key={c.ticker}
                onClick={() => onSelectTicker(c.ticker)}
                aria-selected={isSelected}
                style={{ ...moverRowStyle, background: rowBg, cursor: "pointer" }}
                title={`${c.name} (click to open factor detail)`}
              >
                <td style={{ ...rankCell, background: rowBg }}>{idx + 1}</td>
                <td style={{ ...nameCell, background: rowBg }}>
                  <span style={companyNameText}>{c.name}</span>
                </td>
                <td style={{ ...tickerCell, background: rowBg }}>
                  <span style={tickerSymbolText}>{c.ticker}</span>
                </td>
                <td
                  style={{ ...sectorCell, background: rowBg, color: sectorClr }}
                  title={c.sector}
                >
                  {c.sector}
                </td>
                <td
                  style={{
                    ...subThemeCell,
                    background: rowBg,
                    color: subThemeClr,
                  }}
                  title={c.subTheme}
                >
                  {c.subTheme}
                </td>
                <td
                  style={{
                    ...returnCell,
                    background: bg,
                    color: pickTextColor(bg),
                  }}
                  title={
                    isZ
                      ? `${HORIZON_LABEL[horizon]} return: ${formatMetricValue(c.rawCells?.[horizon] ?? null, "RETURN")}`
                      : undefined
                  }
                >
                  {formatMetricValue(v, isZ ? "RETURN_Z" : "RETURN")}
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td
                colSpan={6}
                style={{ ...emptyStateCell, color: "var(--text-secondary)" }}
              >
                {emptyHint}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
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

const SELECTED_ROW_BG = "rgba(240,182,93,0.10)";
const COMPANY_BG = "#050505";

const section: CSSProperties = {
  marginTop: "12px",
};

const headerStrip: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
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

const horizonToggleRow: CSSProperties = {
  display: "inline-flex",
  gap: "4px",
  marginLeft: "auto",
};

const horizonBtn: CSSProperties = {
  padding: "1px 8px",
  borderRadius: 0,
  border: "1px solid var(--bg-border)",
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  fontSize: "11px",
  fontWeight: 600,
  cursor: "pointer",
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const horizonBtnActive: CSSProperties = {
  ...horizonBtn,
  background: "var(--bg-elevated)",
  border: "1px solid var(--color-accent)",
  color: "var(--text-primary)",
};

const twoColRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
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
  whiteSpace: "nowrap",
  fontWeight: 700,
  lineHeight: 1.25,
};

const moverRowStyle: CSSProperties = {
  background: COMPANY_BG,
};

const cellBase: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  padding: "0 6px",
  whiteSpace: "nowrap",
  lineHeight: 1.4,
};

const rankCell: CSSProperties = {
  ...cellBase,
  color: "var(--text-secondary)",
  textAlign: "right",
  width: "1%",
  fontVariantNumeric: "tabular-nums",
};

const nameCell: CSSProperties = {
  ...cellBase,
  maxWidth: "22ch",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const tickerCell: CSSProperties = {
  ...cellBase,
  width: "1%",
};

const sectorCell: CSSProperties = {
  ...cellBase,
  maxWidth: "16ch",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontWeight: 600,
  fontSize: "11px",
  letterSpacing: "0.02em",
};

const subThemeCell: CSSProperties = {
  ...cellBase,
  maxWidth: "16ch",
  overflow: "hidden",
  textOverflow: "ellipsis",
  fontWeight: 500,
  fontSize: "11px",
};

const returnCell: CSSProperties = {
  ...cellBase,
  textAlign: "right",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  width: "1%",
};

const companyNameText: CSSProperties = {
  color: "var(--color-accent)",
  fontWeight: 500,
  fontSize: "12px",
  display: "inline-block",
  maxWidth: "22ch",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  verticalAlign: "bottom",
};

const tickerSymbolText: CSSProperties = {
  color: "var(--color-accent)",
  fontWeight: 600,
  fontSize: "12px",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.02em",
  fontFamily:
    'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
};

const emptyStateCell: CSSProperties = {
  borderBottom: "1px solid var(--bg-border)",
  whiteSpace: "nowrap",
  padding: "8px 6px",
  background: "transparent",
};
