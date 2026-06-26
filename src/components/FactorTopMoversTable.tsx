"use client";

import type { CSSProperties } from "react";
import { memo, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Horizon } from "@/domain/entities/horizons";
import { HORIZON_ORDER } from "@/domain/entities/horizons";
import { heatmapRgb, resolveHeatRange } from "@/domain/calculations/heatmap";
import { HORIZON_LABEL, formatMetricValue } from "@/lib/format";
import { sectorColor, subThemeColor } from "@/lib/market-map/sector-colors";
import { factorAccentColor } from "@/lib/factors/factor-colors";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import { useAnalysisStore } from "@/store/analysis";
import type {
  FactorTopMoverEntry,
  FactorTopMoversFactor,
  FactorTopMoversResult,
} from "@/types/factors";

/**
 * FactorTopMoversTable — under the Top Movers section on the Market Map page.
 * For each MACRO14 factor, renders the top 20 stocks most positively and most
 * negatively driven by that factor (return contribution = β × factor return).
 * Factors are laid out two panels per row (7 rows), ordered by the factor's
 * own performance over the selected horizon (matching the Factor Performance
 * table). The 1D horizon is live intraday (polled); 5D+ are cached EOD.
 *
 * Rows are clickable and reuse the same `onSelectTicker` callback as the main
 * grid + Top Movers, opening the floating per-stock factor detail popup.
 */

const RANK_LIMIT = 20;

interface FactorTopMoversTableProps {
  onSelectTicker: (ticker: string) => void;
  selectedTickers: Set<string>;
  /** Market map company-level per-horizon range, so contribution cells share
   * the grid's scale instead of self-scaling within each factor panel. */
  marketScale?: Record<Horizon, { min: number; max: number }>;
}

export function FactorTopMoversTable({
  onSelectTicker,
  selectedTickers,
  marketScale,
}: FactorTopMoversTableProps) {
  const [horizon, setHorizon] = useState<Horizon>("D1");
  // Panels are collapsed by default: 14 factors x 2 lists x 20 rows = ~560 rows
  // (~3,360 cells). Mounting them all up-front is the dominant cost of this
  // section, so each panel renders only its header until the user expands it.
  const [expandedCodes, setExpandedCodes] = useState<Set<string>>(new Set());
  // Follow the app-wide attribution mode + beta window so the per-factor
  // contributions tie to the per-stock popup waterfall by construction.
  const mode = useAnalysisStore((s) => s.factorAttributionMode);
  const factorWindow = useAnalysisStore((s) => s.factorWindow);

  const isOneDay = horizon === "D1";
  // 1D polls (live tape during REGULAR, today's close otherwise); 5D+ are
  // static EOD between daily precomputes.
  const refetchInterval = isOneDay
    ? getUsMarketSession(new Date()) === "REGULAR"
      ? 30_000
      : 5 * 60_000
    : false;

  const { data, isFetching, error } = useQuery<FactorTopMoversResult>({
    queryKey: ["factor-top-movers", horizon, mode, factorWindow],
    queryFn: async () => {
      const res = await fetch(
        `/api/analysis/factors/top-movers?horizon=${horizon}&mode=${mode}&window=${factorWindow}`,
        { cache: "no-store" },
      );
      const j = (await res.json()) as FactorTopMoversResult & {
        ok?: boolean;
        error?: unknown;
      };
      if (!res.ok || j.ok === false) {
        throw new Error(
          typeof j.error === "string" ? j.error : res.statusText,
        );
      }
      return j;
    },
    refetchInterval,
    staleTime: isOneDay ? 0 : 5 * 60_000,
    // Keep the previously-rendered factors visible while a refetch is in
    // flight. Without this the panel would blank to [] over the near-black
    // canvas on every refresh (TanStack v5 returns data=undefined transiently
    // whenever the query re-runs).
    placeholderData: (prev) => prev,
  });

  const factors = data?.factors ?? [];
  // Company scale for the toggled horizon (1D -> 1D market range, etc.); falls
  // back per factor to the service-provided panel range when unavailable.
  const marketRange = marketScale?.[horizon];

  const allExpanded =
    factors.length > 0 && factors.every((f) => expandedCodes.has(f.code));
  const toggleAll = () =>
    setExpandedCodes(
      allExpanded ? new Set() : new Set(factors.map((f) => f.code)),
    );
  const toggleCode = (code: string) =>
    setExpandedCodes((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });

  return (
    <div style={section}>
      <div style={headerStrip}>
        <h2 style={sectionTitle}>Factor Top Movers</h2>
        <span style={subtitle}>
          Top {RANK_LIMIT} stocks most positively and negatively driven by each
          factor{isFetching ? " \u00b7 Loading\u2026" : ""}
        </span>
        {data?.live && (
          <span
            style={
              data.session === "REGULAR" ? liveBadgeStyle : todayCloseBadgeStyle
            }
            title={
              data.session === "REGULAR"
                ? "1D contributions from the live market tape"
                : "1D contributions from today's closing print"
            }
          >
            {data.session === "REGULAR" ? "LIVE" : "TODAY CLOSE"}
          </span>
        )}
        {factors.length > 0 && (
          <button
            type="button"
            onClick={toggleAll}
            style={expandAllBtn}
            title={allExpanded ? "Collapse all factor panels" : "Expand all factor panels"}
          >
            {allExpanded ? "Collapse all" : "Expand all"}
          </button>
        )}
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
                title={`Rank by ${HORIZON_LABEL[h]} factor contribution`}
              >
                {HORIZON_LABEL[h]}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <p style={{ color: "var(--color-negative)" }} role="alert">
          {(error as Error).message}
        </p>
      )}

      {factors.length === 0 && !isFetching && !error && (
        <p style={subtitle}>
          No factor grid available. Run&nbsp;
          <code>POST /api/analysis/factors/pipeline-refresh</code>.
        </p>
      )}

      <div style={gridRow}>
        {factors.map((f) => (
          <FactorPanel
            key={f.code}
            factor={f}
            horizon={horizon}
            marketRange={marketRange}
            expanded={expandedCodes.has(f.code)}
            onToggle={() => toggleCode(f.code)}
            onSelectTicker={onSelectTicker}
            selectedTickers={selectedTickers}
          />
        ))}
      </div>
    </div>
  );
}

function FactorPanel({
  factor,
  horizon,
  marketRange,
  expanded,
  onToggle,
  onSelectTicker,
  selectedTickers,
}: {
  factor: FactorTopMoversFactor;
  horizon: Horizon;
  marketRange?: { min: number; max: number };
  expanded: boolean;
  onToggle: () => void;
  onSelectTicker: (ticker: string) => void;
  selectedTickers: Set<string>;
}) {
  // Prefer the market scale; fall back to this factor's own panel range.
  const range = resolveHeatRange(marketRange, factor.range);
  // Bright per-factor accent so each of the 14 panels reads as its own block.
  const accent = factorAccentColor(factor.code);
  return (
    <div style={panelWrap}>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        style={{
          ...panelHeader,
          borderLeft: `3px solid ${accent}`,
          background: hexAlpha(accent, 0.12),
        }}
        title={expanded ? "Collapse this factor" : "Expand this factor"}
      >
        <span style={chevronText}>{expanded ? "\u25be" : "\u25b8"}</span>
        <span style={{ ...factorLabelText, color: accent }}>{factor.label}</span>
        <span style={factorCodeText}>{factor.code}</span>
        {factor.factorReturn != null && (
          <span style={factorReturnText}>
            {formatMetricValue(factor.factorReturn, "RETURN")}
          </span>
        )}
      </button>
      {expanded && (
        <>
          <MoversList
            title={`Top ${RANK_LIMIT} Positive`}
            tone="positive"
            rows={factor.positive}
            horizon={horizon}
            range={range}
            onSelectTicker={onSelectTicker}
            selectedTickers={selectedTickers}
            emptyHint="No positive contributions for this factor."
          />
          <MoversList
            title={`Top ${RANK_LIMIT} Negative`}
            tone="negative"
            rows={factor.negative}
            horizon={horizon}
            range={range}
            onSelectTicker={onSelectTicker}
            selectedTickers={selectedTickers}
            emptyHint="No negative contributions for this factor."
          />
        </>
      )}
    </div>
  );
}

/**
 * One mover row. Memoized + per-row color math behind useMemo so a selection
 * change (which re-renders the list) only re-renders the rows whose selected
 * state actually flipped, and never re-runs heatmapRgb / sectorColor /
 * subThemeColor unless its inputs change.
 */
const MoverRow = memo(function MoverRow({
  entry,
  rank,
  rangeMin,
  rangeMax,
  isSelected,
  onSelectTicker,
}: {
  entry: FactorTopMoverEntry;
  rank: number;
  rangeMin: number;
  rangeMax: number;
  isSelected: boolean;
  onSelectTicker: (ticker: string) => void;
}) {
  const { bg, rowBg, sectorClr, subThemeClr } = useMemo(() => {
    const heat = heatmapRgb(entry.value, "RETURN", rangeMin, rangeMax);
    return {
      bg: heat,
      rowBg: isSelected ? SELECTED_ROW_BG : COMPANY_BG,
      sectorClr: sectorColor(entry.sector),
      subThemeClr: subThemeColor(entry.sector, entry.subTheme),
    };
  }, [entry.value, entry.sector, entry.subTheme, rangeMin, rangeMax, isSelected]);

  return (
    <tr
      onClick={() => onSelectTicker(entry.ticker)}
      aria-selected={isSelected}
      style={{ ...moverRowStyle, background: rowBg, cursor: "pointer" }}
      title={`${entry.name} (click to open factor detail)`}
    >
      <td style={{ ...rankCell, background: rowBg }}>{rank}</td>
      <td style={{ ...nameCell, background: rowBg }}>
        <span style={companyNameText}>{entry.name}</span>
      </td>
      <td style={{ ...tickerCell, background: rowBg }}>
        <span style={tickerSymbolText}>{entry.ticker}</span>
      </td>
      <td
        style={{ ...sectorCell, background: rowBg, color: sectorClr }}
        title={entry.sector}
      >
        {entry.sector}
      </td>
      <td
        style={{ ...subThemeCell, background: rowBg, color: subThemeClr }}
        title={entry.subTheme}
      >
        {entry.subTheme}
      </td>
      <td style={{ ...returnCell, background: bg, color: pickTextColor(bg) }}>
        {formatMetricValue(entry.value, "RETURN")}
      </td>
    </tr>
  );
});

function MoversList({
  title,
  tone,
  rows,
  horizon,
  range,
  onSelectTicker,
  selectedTickers,
  emptyHint,
}: {
  title: string;
  tone: "positive" | "negative";
  rows: FactorTopMoverEntry[];
  horizon: Horizon;
  range: { min: number; max: number };
  onSelectTicker: (ticker: string) => void;
  selectedTickers: Set<string>;
  emptyHint: string;
}) {
  // Filled, color-coded header row: the list title reads green/red so a
  // Positive vs Negative list is distinguishable at a glance; the remaining
  // column labels stay amber (the Bloomberg column-header convention).
  const toneColor =
    tone === "positive" ? "var(--color-positive)" : "var(--color-negative)";
  const headerCell: CSSProperties = {
    ...thStyle,
    background: HEADER_BG,
    borderBottom: `1px solid ${toneColor}`,
  };
  const titleCell: CSSProperties = {
    ...headerCell,
    textAlign: "left",
    color: toneColor,
    letterSpacing: "0.06em",
  };
  const labelCell: CSSProperties = { ...headerCell, color: "var(--color-accent)" };
  return (
    <div style={tableWrap}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...headerCell, width: "1%", textAlign: "right" }}>#</th>
            <th style={titleCell}>{title}</th>
            <th style={{ ...labelCell, textAlign: "left", width: "1%" }}>
              Ticker
            </th>
            <th style={{ ...labelCell, textAlign: "left" }}>Sector</th>
            <th style={{ ...labelCell, textAlign: "left" }}>Sub-Theme</th>
            <th style={{ ...labelCell, textAlign: "right", width: "1%" }}>
              {HORIZON_LABEL[horizon]}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, idx) => (
            <MoverRow
              key={c.ticker}
              entry={c}
              rank={idx + 1}
              rangeMin={range.min}
              rangeMax={range.max}
              isSelected={selectedTickers.has(c.ticker)}
              onSelectTicker={onSelectTicker}
            />
          ))}
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
// Elevated header-row fill so the filled column headers separate cleanly from
// the darker data rows below them.
const HEADER_BG = "#161616";

/** Expand a #rrggbb hex into an rgba() string at the given alpha. */
function hexAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const int = parseInt(m[1]!, 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

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

const liveBadgeStyle: CSSProperties = {
  fontSize: "10px",
  fontWeight: 700,
  letterSpacing: "0.08em",
  padding: "1px 6px",
  borderRadius: 0,
  background: "var(--color-positive)",
  color: "#04140a",
};

const todayCloseBadgeStyle: CSSProperties = {
  ...liveBadgeStyle,
  background: "var(--bg-elevated)",
  color: "var(--text-secondary)",
  border: "1px solid var(--bg-border)",
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

const gridRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "1fr 1fr",
  gap: "8px",
};

const panelWrap: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  minWidth: 0,
};

const panelHeader: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "8px",
  padding: "3px 8px",
  overflow: "hidden",
  width: "100%",
  textAlign: "left",
  border: "none",
  cursor: "pointer",
  font: "inherit",
};

const chevronText: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "10px",
  lineHeight: 1,
};

const expandAllBtn: CSSProperties = {
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

const factorLabelText: CSSProperties = {
  color: "var(--color-accent)",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: "12px",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const factorCodeText: CSSProperties = {
  color: "var(--text-secondary)",
  fontWeight: 500,
  fontSize: "11px",
  fontVariantNumeric: "tabular-nums",
  letterSpacing: "0.02em",
  fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
};

const factorReturnText: CSSProperties = {
  marginLeft: "auto",
  fontSize: "11px",
  fontWeight: 700,
  fontVariantNumeric: "tabular-nums",
  color: "var(--text-primary)",
  fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
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
