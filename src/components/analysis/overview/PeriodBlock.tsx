"use client";

import type { CSSProperties } from "react";
import { fmtPct } from "@/components/analysis/overview/formatters";
import {
  BB_GRID_BORDER,
  BB_GRID_FONT_SIZE,
  BB_GRID_FONT_STACK,
  pickTextColor,
} from "@/components/analysis/factors/shared/bloomberg-grid";
import { heatmapRgb } from "@/domain/calculations/heatmap";

/** Full-cell Bloomberg period heat styles — apply directly on `<td>`. */
export function periodCellStyle(
  value: number,
  range: { min: number; max: number },
): CSSProperties {
  const bg = heatmapRgb(value, "RETURN", range.min, range.max);
  return {
    background: bg,
    color: pickTextColor(bg),
    padding: "0 6px",
    textAlign: "right",
    fontSize: BB_GRID_FONT_SIZE,
    fontWeight: 600,
    fontFamily: BB_GRID_FONT_STACK,
    fontVariantNumeric: "tabular-nums",
    whiteSpace: "nowrap",
    verticalAlign: "middle",
    borderBottom: BB_GRID_BORDER,
  };
}

interface PeriodCellProps {
  value: number;
  range: { min: number; max: number };
}

export function PeriodCell({ value, range }: PeriodCellProps) {
  return (
    <td style={periodCellStyle(value, range)} className="bb-num">
      {fmtPct(value)}
    </td>
  );
}
