"use client";

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { fmtBbWholeDollar, fmtPrice } from "@/components/analysis/overview/formatters";
import { WeightDataBarCell } from "@/components/analysis/overview/WeightDataBarCell";
import { SessionSeamSparkline } from "@/components/analysis/ui/SessionSeamSparkline";
import { DayRangeBar } from "@/components/analysis/overview/DayRangeBar";
import { PeriodCell } from "@/components/analysis/overview/PeriodBlock";
import { CohortDistribution } from "@/components/analysis/overview/CohortDistribution";
import {
  BB_GRID_BORDER,
  BB_GRID_FONT_SIZE,
  BB_GRID_FONT_STACK,
  BB_HEADER_BASE_STYLE,
  BB_ROW_BG,
  getCellDensity,
} from "@/components/analysis/factors/shared/bloomberg-grid";
import {
  sectorColor,
  subThemeColor,
} from "@/lib/market-map/sector-colors";
import type { HoldingRow } from "@/server/services/portfolio-holdings.service";

const TOP_N = 10;
const BOTTOM_N = 10;

type PeriodRangeKey =
  | "chg1dPct"
  | "chg5dPct"
  | "chgMtdPct"
  | "chgQtdPct"
  | "chgYtdPct";

type PeriodRanges = Record<PeriodRangeKey, { min: number; max: number }>;

const PERIOD_KEYS: PeriodRangeKey[] = [
  "chg1dPct",
  "chg5dPct",
  "chgMtdPct",
  "chgQtdPct",
  "chgYtdPct",
];

/** Light gray band for collapsible section headers. */
const SECTION_HEADER_BG = "#2a2a2a";

function computePeriodRanges(rows: HoldingRow[]): PeriodRanges {
  const out = {} as PeriodRanges;
  for (const key of PERIOD_KEYS) {
    const vals = rows
      .map((r) => r[key])
      .filter((v): v is number => Number.isFinite(v));
    out[key] =
      vals.length === 0
        ? { min: 0, max: 0 }
        : { min: Math.min(...vals), max: Math.max(...vals) };
  }
  return out;
}

const companyDensity = getCellDensity("company");

/** Black or white label text for a hex sector / sub-theme fill. */
function pickTextOnHex(hex: string): "#000000" | "#ffffff" {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return "#ffffff";
  const int = parseInt(m[1]!, 16);
  const r = (int >> 16) & 0xff;
  const g = (int >> 8) & 0xff;
  const b = int & 0xff;
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? "#000000" : "#ffffff";
}

function sectorFillStyle(
  sector: string | null,
  subTheme?: string | null,
): CSSProperties {
  const background = subTheme
    ? subThemeColor(sector, subTheme)
    : sectorColor(sector);
  return {
    background,
    color: pickTextOnHex(background),
  };
}

const thStyle: CSSProperties = {
  ...BB_HEADER_BASE_STYLE,
  padding: "2px 6px",
  lineHeight: 1.25,
};

const tdBase: CSSProperties = {
  ...companyDensity,
  fontFamily: BB_GRID_FONT_STACK,
  fontSize: BB_GRID_FONT_SIZE,
  lineHeight: 1.25,
  borderBottom: BB_GRID_BORDER,
  background: BB_ROW_BG.company,
  verticalAlign: "middle",
};

function SectorCell({ label }: { label: string }) {
  return (
    <span
      style={{
        display: "block",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

const nameTextStyle: CSSProperties = {
  display: "block",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--text-secondary)",
};

const nameButtonStyle: CSSProperties = {
  ...nameTextStyle,
  width: "100%",
  padding: 0,
  margin: 0,
  border: "none",
  background: "transparent",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
};

function HoldingRowView({
  row,
  periodRanges,
  totalGross,
  onNameClick,
}: {
  row: HoldingRow;
  periodRanges: PeriodRanges;
  totalGross: number;
  onNameClick?: (ticker: string) => void;
}) {
  const nameClickable = onNameClick && row.ticker !== "CASH";

  return (
    <tr style={{ background: BB_ROW_BG.company }}>
      <td
        style={{
          ...tdBase,
          color: "var(--color-accent)",
          fontWeight: 500,
        }}
      >
        {row.ticker}
      </td>
      <td style={{ ...tdBase, maxWidth: 120 }}>
        {nameClickable ? (
          <button
            type="button"
            title={`View ${row.ticker} detail`}
            onClick={() => onNameClick(row.ticker)}
            style={nameButtonStyle}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--color-accent)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-secondary)";
            }}
          >
            {row.name}
          </button>
        ) : (
          <span style={nameTextStyle}>{row.name}</span>
        )}
      </td>
      <td style={{ ...tdBase, textAlign: "right" }} className="bb-num">
        {fmtPrice(row.currentPrice)}
      </td>
      <td
        className="bb-weight-bar-cell"
        style={{ ...tdBase, padding: 0, overflow: "hidden" }}
      >
        <WeightDataBarCell
          weight={totalGross > 0 ? row.marketValue / totalGross : 0}
        />
      </td>
      <td style={{ ...tdBase, textAlign: "right" }} className="bb-num">
        {fmtBbWholeDollar(row.marketValue)}
      </td>
      <td
        className="spark-col-session"
        style={{ ...tdBase, textAlign: "center", padding: "0 4px" }}
      >
        <SessionSeamSparkline
          priorSeries={row.prevDaySparkline}
          todaySeries={row.sparkline}
          extendedSeries={row.sparklineExtended}
          prevClose={row.prevClose}
          fallbackTodaySeries={row.prevDaySparkline}
          timeMode="us_regular"
          height={18}
          fluid
        />
      </td>
      <td
        className="range-col"
        style={{ ...tdBase, textAlign: "center", padding: "0 2px" }}
      >
        <DayRangeBar
          low={row.dayLow}
          high={row.dayHigh}
          price={row.currentPrice}
          prevClose={row.prevClose}
          fluid
        />
      </td>
      <PeriodCell value={row.chg1dPct} range={periodRanges.chg1dPct} />
      <PeriodCell value={row.chg5dPct} range={periodRanges.chg5dPct} />
      <PeriodCell value={row.chgMtdPct} range={periodRanges.chgMtdPct} />
      <PeriodCell value={row.chgQtdPct} range={periodRanges.chgQtdPct} />
      <PeriodCell value={row.chgYtdPct} range={periodRanges.chgYtdPct} />
      <td style={{ ...tdBase, ...sectorFillStyle(row.sector) }}>
        <SectorCell label={row.sector ?? "Other"} />
      </td>
      <td
        style={{
          ...tdBase,
          ...sectorFillStyle(row.sector, row.subTheme),
        }}
      >
        <SectorCell label={row.subTheme ?? "Other"} />
      </td>
      <td style={{ ...tdBase, textAlign: "center", padding: "0 4px" }}>
        <CohortDistribution
          dist={row.sectorDist}
          stockReturn={row.chg1dPct}
          pctile={row.sectorPctile}
        />
      </td>
      <td style={{ ...tdBase, textAlign: "center", padding: "0 4px" }}>
        <CohortDistribution
          dist={row.subThemeDist}
          stockReturn={row.chg1dPct}
          pctile={row.subThemePctile}
        />
      </td>
    </tr>
  );
}

function chevronStyle(open: boolean): CSSProperties {
  return {
    display: "inline-block",
    width: "0.7rem",
    fontSize: "0.7rem",
    color: "var(--color-accent)",
    transition: "transform 120ms ease",
    transform: open ? "translateY(-1px)" : "translateY(0)",
  };
}

function SectionHeader({
  title,
  count,
  open,
  onToggle,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <tr
      onClick={onToggle}
      style={{
        cursor: "pointer",
        background: SECTION_HEADER_BG,
      }}
    >
      <td
        colSpan={16}
        style={{
          padding: "0 6px",
          fontSize: BB_GRID_FONT_SIZE,
          fontWeight: 700,
          color: "var(--color-accent)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
          borderBottom: BB_GRID_BORDER,
          background: SECTION_HEADER_BG,
          fontFamily: BB_GRID_FONT_STACK,
          lineHeight: 1.25,
        }}
      >
        <span style={chevronStyle(open)}>{open ? "▾" : "▸"}</span> {title} ({count})
      </td>
    </tr>
  );
}

interface HoldingsDashboardProps {
  rows: HoldingRow[];
  loading?: boolean;
  error?: string;
  onNameClick?: (ticker: string) => void;
}

export function HoldingsDashboard({
  rows,
  loading,
  error,
  onNameClick,
}: HoldingsDashboardProps) {
  const [topOpen, setTopOpen] = useState(true);
  const [bottomOpen, setBottomOpen] = useState(true);
  const [restOpen, setRestOpen] = useState(true);

  const { top, bottom, rest } = useMemo(() => {
    const sorted = [...rows].sort((a, b) => b.chg1dPct - a.chg1dPct);
    const top = sorted.slice(0, TOP_N);
    const topSet = new Set(top.map((r) => r.ticker));
    // Exclude top rows so a row never lands in both sections when the portfolio
    // has <= TOP_N + BOTTOM_N holdings and the two slices would otherwise overlap.
    const bottom = sorted
      .slice(-BOTTOM_N)
      .reverse()
      .filter((r) => !topSet.has(r.ticker));
    const bottomSet = new Set(bottom.map((r) => r.ticker));
    const rest = sorted.filter(
      (r) => !topSet.has(r.ticker) && !bottomSet.has(r.ticker),
    );
    return { top, bottom, rest };
  }, [rows]);

  const periodRanges = useMemo(() => computePeriodRanges(rows), [rows]);
  const totalGross = useMemo(
    () => rows.reduce((s, r) => s + r.marketValue, 0),
    [rows],
  );

  const tableHeader = (
    <thead>
      <tr>
        <th style={{ ...thStyle, textAlign: "left" }}>Ticker</th>
        <th style={{ ...thStyle, textAlign: "left" }}>Name</th>
        <th style={{ ...thStyle, textAlign: "right" }}>Price</th>
        <th style={{ ...thStyle, textAlign: "right" }}>% Wgt</th>
        <th style={{ ...thStyle, textAlign: "right" }}>Tot $</th>
        <th
          style={{ ...thStyle, textAlign: "center", lineHeight: 1.05, padding: "2px 4px" }}
          title="Prior session (white) · today (colored vs prev close)"
        >
          Session
        </th>
        <th style={{ ...thStyle, textAlign: "center" }}>Range</th>
        <th style={{ ...thStyle, textAlign: "right" }}>1D</th>
        <th style={{ ...thStyle, textAlign: "right" }}>5D</th>
        <th style={{ ...thStyle, textAlign: "right" }}>MTD</th>
        <th style={{ ...thStyle, textAlign: "right" }}>QTD</th>
        <th style={{ ...thStyle, textAlign: "right" }}>YTD</th>
        <th style={{ ...thStyle, textAlign: "left" }}>Sector</th>
        <th style={{ ...thStyle, textAlign: "left" }}>Sub-Theme</th>
        <th style={{ ...thStyle, textAlign: "center" }}>Sector Dist</th>
        <th style={{ ...thStyle, textAlign: "center" }}>Sub Dist</th>
      </tr>
    </thead>
  );

  return (
    <ChartCard title="Portfolio Holdings" compact>
      {loading ? (
        <div
          style={{
            padding: 16,
            textAlign: "center",
            color: "var(--text-secondary)",
            fontSize: BB_GRID_FONT_SIZE,
            fontFamily: BB_GRID_FONT_STACK,
          }}
        >
          Loading holdings…
        </div>
      ) : error ? (
        <div
          style={{
            padding: 12,
            color: "var(--color-negative)",
            fontSize: BB_GRID_FONT_SIZE,
            fontFamily: BB_GRID_FONT_STACK,
          }}
        >
          {error}
        </div>
      ) : rows.length === 0 ? (
        <div
          style={{
            padding: 12,
            color: "var(--text-muted)",
            fontSize: BB_GRID_FONT_SIZE,
            fontFamily: BB_GRID_FONT_STACK,
          }}
        >
          No positions in portfolio.
        </div>
      ) : (
        <div style={{ overflowX: "auto", background: "var(--bg-base)" }}>
          <table
            className="bb-holdings-table"
            style={{
              borderCollapse: "separate",
              borderSpacing: 0,
              width: "100%",
              minWidth: 1200,
              background: "var(--bg-base)",
            }}
          >
            {tableHeader}
            <tbody>
              <SectionHeader
                title="Top Performers"
                count={top.length}
                open={topOpen}
                onToggle={() => setTopOpen((v) => !v)}
              />
              {topOpen &&
                top.map((r) => (
                  <HoldingRowView
                    key={r.ticker}
                    row={r}
                    periodRanges={periodRanges}
                    totalGross={totalGross}
                    onNameClick={onNameClick}
                  />
                ))}

              <SectionHeader
                title="Bottom Performers"
                count={bottom.length}
                open={bottomOpen}
                onToggle={() => setBottomOpen((v) => !v)}
              />
              {bottomOpen &&
                bottom.map((r) => (
                  <HoldingRowView
                    key={`b-${r.ticker}`}
                    row={r}
                    periodRanges={periodRanges}
                    totalGross={totalGross}
                    onNameClick={onNameClick}
                  />
                ))}

              <SectionHeader
                title="Remaining Securities"
                count={rest.length}
                open={restOpen}
                onToggle={() => setRestOpen((v) => !v)}
              />
              {restOpen &&
                rest.map((r) => (
                  <HoldingRowView
                    key={`r-${r.ticker}`}
                    row={r}
                    periodRanges={periodRanges}
                    totalGross={totalGross}
                    onNameClick={onNameClick}
                  />
                ))}
            </tbody>
          </table>
        </div>
      )}
    </ChartCard>
  );
}
