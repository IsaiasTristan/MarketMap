"use client";
/**
 * SectorFactorHeatmap — universe-tilt panel above the per-stock grid.
 *
 * Rows = sectors (alphabetical for v1). Columns = factors in the model's
 * canonical order. Cell value = mean β / mean return contribution / mean
 * risk contribution depending on the active metric. Color = cohort-percentile
 * heat (signed for factor cells), opacity tiers by the sector loading's
 * t-stat:
 *
 *   |t| ≥ 2.0  → opacity 1.0  (significant — trust the loading)
 *   1.0 ≤ |t|  → opacity 0.5  (marginal — directionally interesting)
 *   |t| < 1.0  → opacity 0.2  (insignificant — direction is noise)
 *
 * Cells with fewer than 3 contributing rows render BLANK, distinct from
 * the low-opacity "weak significance" path — missing data is a different
 * problem than a noisy estimate.
 *
 * Click a cell → the parent narrows the per-stock grid to that sector and
 * sorts it descending by that factor — "show me Tech stocks ordered by
 * MOM exposure" in one click.
 *
 * TODO: ordering options. Sectors currently alphabetical; factors follow
 * the input list order (model preset canonical). Future improvements
 * would order sectors by surviving-set weight and factors by the user's
 * composite-score weight. Tracked but not v1.
 */
import { useMemo, useState } from "react";
import {
  heatPercentileBloomberg,
  heatSequentialBloomberg,
} from "@/domain/calculations/heatmap";
import { pickTextColor } from "../shared/bloomberg-grid";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import { FactorTooltip } from "../shared/FactorTooltip";
import type { FactorCode } from "@/types/factors";
import type { FactorGridMetric } from "@/store/analysis";
import type {
  SectorFactorAggregate,
  SectorHeatmapResult,
} from "@/lib/factors/screener";

interface SectorFactorHeatmapProps {
  result: SectorHeatmapResult;
  metric: FactorGridMetric;
  /** Currently-active sector filter (highlights the matching row). */
  activeSector: string | null;
  /** User clicked a cell → set sector filter + sort by factor desc. */
  onCellClick: (sector: string, code: FactorCode) => void;
  /** Collapsed state controlled by parent (persisted in store later if needed). */
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const SECTOR_COL_WIDTH = 120;
const FACTOR_COL_WIDTH = 56;
const ROW_HEIGHT = 22;

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: 10,
  fontWeight: 600,
};

function opacityForSig(s: SectorFactorAggregate["significance"]): number {
  if (s === "significant") return 1.0;
  if (s === "marginal") return 0.5;
  return 0.2;
}

function formatCellValue(v: number, metric: FactorGridMetric): string {
  if (!Number.isFinite(v)) return "—";
  if (metric === "beta") return v.toFixed(2);
  // return / risk both render as percentage
  const sign = v >= 0 ? "+" : "";
  return `${sign}${(v * 100).toFixed(1)}%`;
}

export function SectorFactorHeatmap({
  result,
  metric,
  activeSector,
  onCellClick,
  collapsed,
  onToggleCollapsed,
}: SectorFactorHeatmapProps) {
  // Per-column max-magnitude span across all sectors — used by the heat
  // ramp. Cohort-percentile heat would be ideal here too but with only
  // ~10 sectors it produces too many discrete steps; per-column signed
  // span keeps the visual sensible at this scale.
  const colSpans = useMemo(() => {
    const m = new Map<FactorCode, number>();
    for (const code of result.factors) {
      let max = 0;
      for (const sector of result.sectors) {
        const cell = result.bySector.get(sector)?.get(code);
        if (cell && Number.isFinite(cell.mean) && Math.abs(cell.mean) > max) {
          max = Math.abs(cell.mean);
        }
      }
      m.set(code, Math.max(max, 1e-6));
    }
    return m;
  }, [result]);

  const [hoverCell, setHoverCell] = useState<
    { sector: string; code: FactorCode } | null
  >(null);

  return (
    <div
      style={{
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 2,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "6px 14px",
          borderBottom: collapsed ? "none" : "1px solid var(--bg-border)",
        }}
      >
        <span style={labelStyle}>Universe tilts</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
          mean {metric === "beta" ? "β" : metric === "return" ? "return contrib" : "risk contrib"} by sector × factor — opacity = significance, blank = insufficient data
        </span>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onToggleCollapsed}
          style={{
            background: "transparent",
            border: "1px solid var(--bg-border)",
            color: "var(--text-secondary)",
            borderRadius: 2,
            padding: "0 10px",
            height: 22,
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {collapsed ? "show ▾" : "hide ▴"}
        </button>
      </div>

      {!collapsed && (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              borderCollapse: "separate",
              borderSpacing: 0,
              fontSize: 11,
              fontVariantNumeric: "tabular-nums",
            }}
          >
            <thead>
              <tr>
                <th
                  style={{
                    width: SECTOR_COL_WIDTH,
                    minWidth: SECTOR_COL_WIDTH,
                    padding: "4px 8px",
                    textAlign: "left",
                    color: "var(--text-muted)",
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.08em",
                    borderBottom: "1px solid var(--bg-border)",
                    background: "var(--bg-surface)",
                    position: "sticky",
                    left: 0,
                    zIndex: 1,
                  }}
                >
                  Sector
                </th>
                {result.factors.map((code) => {
                  const def = getFactorDef(code);
                  return (
                    <th
                      key={code}
                      style={{
                        width: FACTOR_COL_WIDTH,
                        minWidth: FACTOR_COL_WIDTH,
                        padding: "4px 4px",
                        textAlign: "center",
                        color: "var(--text-muted)",
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        borderBottom: "1px solid var(--bg-border)",
                      }}
                    >
                      <FactorTooltip code={code} concise>
                        <span>{def.shortLabel}</span>
                      </FactorTooltip>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {result.sectors.map((sector) => {
                const sectorRow = result.bySector.get(sector);
                if (!sectorRow) return null;
                const isActive = activeSector === sector;
                return (
                  <tr key={sector} style={{ height: ROW_HEIGHT }}>
                    <td
                      style={{
                        width: SECTOR_COL_WIDTH,
                        minWidth: SECTOR_COL_WIDTH,
                        padding: "0 8px",
                        color: isActive ? "var(--color-accent)" : "#d0d0d0",
                        fontWeight: isActive ? 700 : 600,
                        textTransform: "uppercase",
                        letterSpacing: "0.04em",
                        background: isActive
                          ? "rgba(240,182,93,0.06)"
                          : "var(--bg-surface)",
                        position: "sticky",
                        left: 0,
                        zIndex: 1,
                        borderBottom: "1px solid rgba(255,255,255,0.04)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                      title={sector}
                    >
                      {sector}
                    </td>
                    {result.factors.map((code) => {
                      const cell = sectorRow.get(code) ?? null;
                      const isHover =
                        hoverCell?.sector === sector && hoverCell?.code === code;
                      if (!cell) {
                        return (
                          <td
                            key={code}
                            title={`${sector} · ${getFactorDef(code).shortLabel}: <3 stocks contributing`}
                            style={{
                              width: FACTOR_COL_WIDTH,
                              minWidth: FACTOR_COL_WIDTH,
                              padding: "0 4px",
                              textAlign: "center",
                              color: "var(--text-muted)",
                              fontSize: 10,
                              background: "rgba(255,255,255,0.02)",
                              borderBottom: "1px solid rgba(0,0,0,0.4)",
                              borderLeft: "1px solid rgba(0,0,0,0.3)",
                            }}
                          >
                            ·
                          </td>
                        );
                      }
                      const span = colSpans.get(code) ?? 1;
                      // Map mean to a percentile-like fraction within the
                      // column's symmetric span so the heat ramp behaves
                      // consistently with the per-stock grid.
                      const t = Math.max(-1, Math.min(1, cell.mean / span));
                      const pct = (t + 1) / 2;
                      const baseBg =
                        metric === "beta" || cell.mean !== 0
                          ? heatPercentileBloomberg(pct, "signed")
                          : heatSequentialBloomberg(0, 1, "green");
                      const opacity = opacityForSig(cell.significance);
                      const fg = pickTextColor(baseBg);
                      return (
                        <td
                          key={code}
                          onClick={() => onCellClick(sector, code)}
                          onMouseEnter={() => setHoverCell({ sector, code })}
                          onMouseLeave={() => setHoverCell(null)}
                          title={`${sector} · ${getFactorDef(code).shortLabel}\nMean = ${formatCellValue(cell.mean, metric)} (n=${cell.n}, t=${cell.tStat.toFixed(1)})\nSignificance: ${cell.significance}\nClick to filter grid to ${sector} · sort by ${getFactorDef(code).shortLabel} desc`}
                          style={{
                            width: FACTOR_COL_WIDTH,
                            minWidth: FACTOR_COL_WIDTH,
                            padding: "0 4px",
                            textAlign: "center",
                            color: fg,
                            fontSize: 10,
                            background: baseBg,
                            opacity,
                            outline: isHover
                              ? "1px solid var(--color-accent)"
                              : "none",
                            outlineOffset: -1,
                            borderBottom: "1px solid rgba(0,0,0,0.4)",
                            borderLeft: "1px solid rgba(0,0,0,0.3)",
                            cursor: "pointer",
                            transition: "outline 0.05s",
                          }}
                        >
                          {formatCellValue(cell.mean, metric)}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {result.sectors.length === 0 && (
                <tr>
                  <td
                    colSpan={result.factors.length + 1}
                    style={{
                      padding: 12,
                      textAlign: "center",
                      color: "var(--text-muted)",
                      fontSize: 11,
                    }}
                  >
                    No sectors in the surviving universe.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
