"use client";
/**
 * FactorScatterPanel — split-pane scatter view sitting below the per-stock
 * grid (Phase B of UI additions).
 *
 * Lets the user pick any two metrics for X and Y, color by sector, size by
 * R². Drag-rectangle brush over the scatter selects a subset of stocks;
 * the parent (PerStockView) lifts that selection up and the grid pins
 * those rows to the top above a divider. Reverse direction: when row
 * predicate filters narrow the surviving universe, non-surviving rows
 * dim to ~30 % opacity in the scatter (still visible — the scatter is a
 * map of the population, not a derived view of the screen).
 *
 * Three v1 presets (Real α, α vs R², Factor β-X vs β-Y) — vol-adjusted
 * alpha and β stability presets are absent until their underlying columns
 * land (P5 / P8). The X/Y dropdowns let the user roll their own.
 *
 * Default zoom clips to the 1st-99th percentile per axis so a single
 * outlier can't compress the whole chart. Outliers stay rendered, just
 * outside the visible range. Per-axis log-scale toggle disabled when the
 * data isn't strictly positive.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import {
  axisDef,
  clipPercentileRange,
  extractAxisValue,
  formatAxisValue,
  logScaleEligible,
  SCATTER_PRESETS,
  type ScatterAxisDef,
  type ScatterAxisKey,
} from "@/lib/factors/screener";
import type { FactorCode } from "@/types/factors";
import type { PerStockResult } from "@/server/services/factor-per-stock.service";

interface FactorScatterPanelProps {
  data: PerStockResult;
  /** Tickers that survive the screener row filters; non-survivors dim. */
  survivingTickers: Set<string>;
  /** Current selection (driven by brush, propagated to grid for pin-to-top). */
  selectedTickers: Set<string>;
  onSelectionChange: (next: Set<string>) => void;
  /** Panel height (controlled by parent so it survives reload). */
  height: number;
  onHeightChange: (next: number) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

const MIN_HEIGHT = 240;
const MAX_HEIGHT = 800;

const SECTOR_PALETTE = [
  "#5fb3d9",
  "#d97a5f",
  "#7ad95f",
  "#d95fb3",
  "#5fd9b3",
  "#d9b35f",
  "#b35fd9",
  "#5f7ad9",
  "#d95f5f",
  "#5fd97a",
  "#a5a5a5",
];

function sectorColor(sector: string, sectorList: ReadonlyArray<string>): string {
  const i = sectorList.indexOf(sector);
  if (i < 0) return SECTOR_PALETTE[SECTOR_PALETTE.length - 1]!;
  return SECTOR_PALETTE[i % SECTOR_PALETTE.length]!;
}

interface ScatterDatum {
  ticker: string;
  sector: string;
  subTheme: string;
  x: number;
  y: number;
  size: number;
  surviving: boolean;
  selected: boolean;
}

function buildAxisOptions(
  factors: ReadonlyArray<FactorCode>,
  factorLabels: Record<string, string>,
): ScatterAxisDef[] {
  const out: ScatterAxisDef[] = [
    axisDef("rSquared"),
    axisDef("realizedVol"),
    axisDef("alpha"),
    axisDef("alphaTStat"),
    axisDef("residual"),
    axisDef("residualTStat"),
  ];
  for (const code of factors) {
    out.push(axisDef(`factor:${code}:beta`, factorLabels));
    out.push(axisDef(`factor:${code}:return`, factorLabels));
    out.push(axisDef(`factor:${code}:risk`, factorLabels));
  }
  return out;
}

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: 10,
  fontWeight: 600,
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  color: "var(--text-primary)",
  border: "1px solid var(--bg-border)",
  borderRadius: 2,
  padding: "0 8px",
  height: 24,
  fontSize: 11,
  cursor: "pointer",
  outline: "none",
  fontFamily: "inherit",
};

export function FactorScatterPanel({
  data,
  survivingTickers,
  selectedTickers,
  onSelectionChange,
  height,
  onHeightChange,
  collapsed,
  onToggleCollapsed,
}: FactorScatterPanelProps) {
  const factors = data.usableFactors;
  const factorLabels = useMemo(() => {
    const m: Record<string, string> = {};
    for (const c of factors) m[c] = getFactorDef(c).shortLabel;
    return m;
  }, [factors]);
  const axisOptions = useMemo(
    () => buildAxisOptions(factors, factorLabels),
    [factors, factorLabels],
  );

  // Default to the first preset.
  const [xAxisKey, setXAxisKey] = useState<ScatterAxisKey>(SCATTER_PRESETS[0]!.x);
  const [yAxisKey, setYAxisKey] = useState<ScatterAxisKey>(SCATTER_PRESETS[0]!.y);
  const [xLog, setXLog] = useState(false);
  const [yLog, setYLog] = useState(false);

  // Brush state — pixel coords relative to the chart wrapper during drag,
  // null when no drag is in progress. Pixel coords are converted to data
  // coords on mouseup using the wrapper's bounding rect + known plot
  // margins. Pixel-space rect renders as an absolutely-positioned overlay.
  const [brush, setBrush] = useState<
    | {
        x0: number;
        y0: number;
        x1: number;
        y1: number;
      }
    | null
  >(null);
  const brushDownRef = useRef<{ x0: number; y0: number } | null>(null);
  const chartWrapperRef = useRef<HTMLDivElement | null>(null);

  const xDef = useMemo(() => axisDef(xAxisKey, factorLabels), [xAxisKey, factorLabels]);
  const yDef = useMemo(() => axisDef(yAxisKey, factorLabels), [yAxisKey, factorLabels]);

  // Build datum list — every row, even non-surviving (we dim those rather
  // than dropping them from view; the scatter is a map of the population).
  const sectorList = useMemo(() => {
    const set = new Set<string>();
    for (const r of data.rows) set.add(r.sector);
    return [...set].sort();
  }, [data.rows]);

  const allDatums: ScatterDatum[] = useMemo(() => {
    const out: ScatterDatum[] = [];
    for (const r of data.rows) {
      const x = extractAxisValue(r, xAxisKey);
      const y = extractAxisValue(r, yAxisKey);
      if (x === null || y === null) continue;
      const size = Number.isFinite(r.rSquared) ? Math.max(0, r.rSquared) : 0.1;
      out.push({
        ticker: r.ticker,
        sector: r.sector,
        subTheme: r.subTheme,
        x,
        y,
        size,
        surviving: survivingTickers.has(r.ticker),
        selected: selectedTickers.has(r.ticker),
      });
    }
    return out;
  }, [data.rows, xAxisKey, yAxisKey, survivingTickers, selectedTickers]);

  // Axis ranges: clip to 1st-99th percentile of the surviving subset only.
  // Outliers (and non-survivors) still render — they fall outside the
  // visible range but the chart doesn't compress for them.
  const xRange = useMemo(() => {
    const vals = allDatums.filter((d) => d.surviving).map((d) => d.x);
    return clipPercentileRange(vals);
  }, [allDatums]);
  const yRange = useMemo(() => {
    const vals = allDatums.filter((d) => d.surviving).map((d) => d.y);
    return clipPercentileRange(vals);
  }, [allDatums]);

  // Decide whether the log-scale toggle should be enabled per axis.
  const xLogEligible = useMemo(
    () => logScaleEligible(allDatums.filter((d) => d.surviving).map((d) => d.x), xDef),
    [allDatums, xDef],
  );
  const yLogEligible = useMemo(
    () => logScaleEligible(allDatums.filter((d) => d.surviving).map((d) => d.y), yDef),
    [allDatums, yDef],
  );
  // Auto-disable log when ineligible (e.g., user switched axis to a signed metric).
  useEffect(() => {
    if (xLog && !xLogEligible) setXLog(false);
  }, [xLog, xLogEligible]);
  useEffect(() => {
    if (yLog && !yLogEligible) setYLog(false);
  }, [yLog, yLogEligible]);

  // Resize: native browser CSS resize + ResizeObserver to capture the new
  // height on release. Debounced via rAF so we don't fire onHeightChange
  // on every pixel during the drag.
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let raf = 0;
    const ro = new ResizeObserver((entries) => {
      const e = entries[0];
      if (!e) return;
      const next = e.contentRect.height;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (Math.abs(next - height) > 4) {
          onHeightChange(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(next))));
        }
      });
    });
    ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [height, onHeightChange]);

  // Brush handlers — DOM events on the chart wrapper. Pixel coords map to
  // data coords using the wrapper's bounding rect + the ScatterChart's
  // known margins. Recharts' chart-event handlers don't expose data coords
  // for scatter plots, so we go around them and brush at the DOM layer.
  const dragMoved = useRef(false);

  // Plot margins must match the values passed to ScatterChart's `margin`
  // prop below. Keep them in lockstep — this is the only spot that
  // duplicates the values.
  const PLOT_MARGIN = { top: 12, right: 16, bottom: 24, left: 8 };
  // Recharts reserves space for axis labels + ticks inside the plot area;
  // these constants approximate what its layout engine actually uses for
  // a ScatterChart with default tick sizes. They're tuned so the brush
  // rect aligns with cursor on the visible plot area; off-by-a-few pixels
  // is acceptable since selection is range-based.
  const AXIS_RESERVE = { left: 56, bottom: 36 };

  function brushPlotRect(rect: DOMRect): {
    plotLeft: number;
    plotTop: number;
    plotW: number;
    plotH: number;
  } {
    const plotLeft = PLOT_MARGIN.left + AXIS_RESERVE.left;
    const plotTop = PLOT_MARGIN.top;
    const plotW = Math.max(1, rect.width - plotLeft - PLOT_MARGIN.right);
    const plotH = Math.max(
      1,
      rect.height - plotTop - PLOT_MARGIN.bottom - AXIS_RESERVE.bottom,
    );
    return { plotLeft, plotTop, plotW, plotH };
  }

  function pixelToData(
    px: number,
    py: number,
    rect: DOMRect,
  ): { x: number; y: number } | null {
    if (!xRange || !yRange) return null;
    const { plotLeft, plotTop, plotW, plotH } = brushPlotRect(rect);
    const localX = px - plotLeft;
    const localY = py - plotTop;
    if (localX < 0 || localY < 0 || localX > plotW || localY > plotH) {
      // Outside the plot area — clamp rather than reject so the brush
      // still works when the user drags slightly past the edge.
    }
    const tX = Math.max(0, Math.min(1, localX / plotW));
    const tY = Math.max(0, Math.min(1, localY / plotH));
    const x = xRange[0] + tX * (xRange[1] - xRange[0]);
    // Y axis is inverted in screen space.
    const y = yRange[1] - tY * (yRange[1] - yRange[0]);
    return { x, y };
  }

  function handleBrushMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (!chartWrapperRef.current) return;
    if (!xRange || !yRange) return; // No data range = no brushing
    const rect = chartWrapperRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    brushDownRef.current = { x0: px, y0: py };
    dragMoved.current = false;
    setBrush({ x0: px, y0: py, x1: px, y1: py });
  }
  function handleBrushMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!brushDownRef.current || !chartWrapperRef.current) return;
    const rect = chartWrapperRef.current.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    if (
      Math.abs(px - brushDownRef.current.x0) > 2 ||
      Math.abs(py - brushDownRef.current.y0) > 2
    ) {
      dragMoved.current = true;
    }
    setBrush({
      x0: brushDownRef.current.x0,
      y0: brushDownRef.current.y0,
      x1: px,
      y1: py,
    });
  }
  function handleBrushMouseUp() {
    const down = brushDownRef.current;
    const moved = dragMoved.current;
    const currentBrush = brush;
    brushDownRef.current = null;
    setBrush(null);
    if (!down || !currentBrush || !chartWrapperRef.current) return;
    if (!moved) {
      // Click without drag → clear selection.
      onSelectionChange(new Set());
      return;
    }
    const rect = chartWrapperRef.current.getBoundingClientRect();
    const a = pixelToData(currentBrush.x0, currentBrush.y0, rect);
    const b = pixelToData(currentBrush.x1, currentBrush.y1, rect);
    if (!a || !b) return;
    const xLo = Math.min(a.x, b.x);
    const xHi = Math.max(a.x, b.x);
    const yLo = Math.min(a.y, b.y);
    const yHi = Math.max(a.y, b.y);
    const next = new Set<string>();
    for (const d of allDatums) {
      if (!d.surviving) continue;
      if (d.x >= xLo && d.x <= xHi && d.y >= yLo && d.y <= yHi) {
        next.add(d.ticker);
      }
    }
    onSelectionChange(next);
  }

  function applyPreset(p: (typeof SCATTER_PRESETS)[number]) {
    setXAxisKey(p.x);
    setYAxisKey(p.y);
  }

  // Group datums by sector so each `<Scatter>` series gets its own color.
  const datumsBySector = useMemo(() => {
    const m = new Map<string, ScatterDatum[]>();
    for (const d of allDatums) {
      let arr = m.get(d.sector);
      if (!arr) {
        arr = [];
        m.set(d.sector, arr);
      }
      arr.push(d);
    }
    return m;
  }, [allDatums]);

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
          flexWrap: "wrap",
        }}
      >
        <span style={labelStyle}>Scatter</span>

        {/* Presets */}
        {!collapsed && (
          <div style={{ display: "inline-flex", gap: 4 }}>
            {SCATTER_PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => applyPreset(p)}
                title={p.description}
                style={{
                  background: "transparent",
                  border: "1px solid var(--bg-border)",
                  color: "var(--text-secondary)",
                  borderRadius: 2,
                  padding: "0 8px",
                  height: 22,
                  fontSize: 10,
                  cursor: "pointer",
                  fontFamily: "inherit",
                  whiteSpace: "nowrap",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex: 1 }} />

        {!collapsed && selectedTickers.size > 0 && (
          <button
            type="button"
            onClick={() => onSelectionChange(new Set())}
            style={{
              background: "transparent",
              border: "1px solid var(--bg-border)",
              color: "var(--color-accent)",
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
            Clear ({selectedTickers.size})
          </button>
        )}
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
        <div style={{ padding: "8px 14px" }}>
          <div
            style={{
              display: "flex",
              gap: 16,
              alignItems: "center",
              flexWrap: "wrap",
              marginBottom: 8,
            }}
          >
            <AxisPicker
              label="X"
              value={xAxisKey}
              options={axisOptions}
              onChange={setXAxisKey}
              log={xLog}
              setLog={setXLog}
              logEligible={xLogEligible}
            />
            <AxisPicker
              label="Y"
              value={yAxisKey}
              options={axisOptions}
              onChange={setYAxisKey}
              log={yLog}
              setLog={setYLog}
              logEligible={yLogEligible}
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              · Color: sector · Size: R² · Drag a rectangle to select
            </span>
          </div>

          <div
            ref={containerRef}
            style={{
              width: "100%",
              height,
              minHeight: MIN_HEIGHT,
              maxHeight: MAX_HEIGHT,
              resize: "vertical",
              overflow: "hidden",
              border: "1px solid var(--bg-border)",
              borderRadius: 2,
              background: "var(--bg-base)",
              position: "relative",
            }}
          >
            <div
              ref={chartWrapperRef}
              style={{
                width: "100%",
                height: "100%",
                position: "relative",
                cursor: brush ? "crosshair" : "crosshair",
                userSelect: "none",
              }}
              onMouseDown={handleBrushMouseDown}
              onMouseMove={handleBrushMouseMove}
              onMouseUp={handleBrushMouseUp}
              onMouseLeave={handleBrushMouseUp}
            >
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart
                margin={PLOT_MARGIN}
              >
                <CartesianGrid stroke="rgba(255,255,255,0.06)" />
                <XAxis
                  type="number"
                  dataKey="x"
                  name={xDef.label}
                  scale={xLog && xLogEligible ? "log" : "linear"}
                  domain={xRange ?? ["auto", "auto"]}
                  allowDataOverflow
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  tickFormatter={(v: number) => formatAxisValue(v, xDef.format)}
                  label={{
                    value: xDef.label,
                    position: "insideBottom",
                    offset: -10,
                    fill: "var(--text-secondary)",
                    fontSize: 11,
                  }}
                />
                <YAxis
                  type="number"
                  dataKey="y"
                  name={yDef.label}
                  scale={yLog && yLogEligible ? "log" : "linear"}
                  domain={yRange ?? ["auto", "auto"]}
                  allowDataOverflow
                  tick={{ fill: "var(--text-muted)", fontSize: 10 }}
                  tickFormatter={(v: number) => formatAxisValue(v, yDef.format)}
                  label={{
                    value: yDef.label,
                    angle: -90,
                    position: "insideLeft",
                    fill: "var(--text-secondary)",
                    fontSize: 11,
                  }}
                />
                <ZAxis type="number" dataKey="size" range={[20, 200]} />
                <Tooltip
                  cursor={{ stroke: "var(--color-accent)", strokeOpacity: 0.3 }}
                  content={({ active, payload }) => {
                    if (!active || !payload || payload.length === 0) return null;
                    const d = payload[0]!.payload as ScatterDatum;
                    return (
                      <div
                        style={{
                          background: "var(--bg-elevated)",
                          border: "1px solid var(--bg-border)",
                          borderRadius: 2,
                          padding: "6px 10px",
                          fontSize: 11,
                          color: "var(--text-primary)",
                        }}
                      >
                        <div style={{ fontWeight: 700, color: "var(--color-accent)" }}>
                          {d.ticker}
                        </div>
                        <div style={{ color: "var(--text-secondary)", fontSize: 10 }}>
                          {d.sector} · {d.subTheme}
                        </div>
                        <div style={{ marginTop: 4 }}>
                          {xDef.label}: {formatAxisValue(d.x, xDef.format)}
                        </div>
                        <div>
                          {yDef.label}: {formatAxisValue(d.y, yDef.format)}
                        </div>
                      </div>
                    );
                  }}
                />
                {[...datumsBySector.entries()].map(([sector, list]) => (
                  <Scatter
                    key={sector}
                    name={sector}
                    data={list}
                    fill={sectorColor(sector, sectorList)}
                    fillOpacity={undefined}
                    shape={(props: {
                      cx?: number;
                      cy?: number;
                      payload?: ScatterDatum;
                      fill?: string;
                      size?: number;
                    }) => {
                      const d = props.payload;
                      if (!d || props.cx == null || props.cy == null) {
                        return <g />;
                      }
                      const baseFill = props.fill ?? "#888";
                      const r = Math.sqrt(Math.max(20, props.size ?? 40)) / 1.5;
                      const opacity = !d.surviving ? 0.18 : d.selected ? 1 : 0.7;
                      const stroke = d.selected ? "var(--color-accent)" : "rgba(0,0,0,0.4)";
                      const strokeWidth = d.selected ? 2 : 1;
                      return (
                        <circle
                          cx={props.cx}
                          cy={props.cy}
                          r={r}
                          fill={baseFill}
                          fillOpacity={opacity}
                          stroke={stroke}
                          strokeWidth={strokeWidth}
                        />
                      );
                    }}
                  />
                ))}
              </ScatterChart>
            </ResponsiveContainer>
              {brush && (
                <div
                  style={{
                    position: "absolute",
                    left: Math.min(brush.x0, brush.x1),
                    top: Math.min(brush.y0, brush.y1),
                    width: Math.abs(brush.x1 - brush.x0),
                    height: Math.abs(brush.y1 - brush.y0),
                    border: "1px solid var(--color-accent)",
                    background: "rgba(240,182,93,0.10)",
                    pointerEvents: "none",
                  }}
                />
              )}
            </div>
          </div>

          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              padding: "6px 0 0",
            }}
          >
            {allDatums.length} stocks plotted ·{" "}
            {allDatums.filter((d) => !d.surviving).length} dimmed (filtered out) ·
            zoom clipped to 1st-99th percentile · drag bottom edge to resize
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Axis picker
// ---------------------------------------------------------------------------

interface AxisPickerProps {
  label: "X" | "Y";
  value: ScatterAxisKey;
  options: ScatterAxisDef[];
  onChange: (next: ScatterAxisKey) => void;
  log: boolean;
  setLog: (v: boolean) => void;
  logEligible: boolean;
}

function AxisPicker({
  label,
  value,
  options,
  onChange,
  log,
  setLog,
  logEligible,
}: AxisPickerProps) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      <span style={labelStyle}>{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ScatterAxisKey)}
        style={{ ...selectStyle, minWidth: 180 }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key} title={o.description}>
            {o.label}
          </option>
        ))}
      </select>
      <label
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          fontSize: 10,
          color: logEligible ? "var(--text-secondary)" : "var(--text-muted)",
          cursor: logEligible ? "pointer" : "not-allowed",
        }}
        title={
          logEligible
            ? "Log scale — useful for skewed distributions"
            : "Log scale unavailable: data must be strictly positive"
        }
      >
        <input
          type="checkbox"
          checked={log}
          disabled={!logEligible}
          onChange={(e) => setLog(e.target.checked)}
          style={{ accentColor: "var(--color-accent)" }}
        />
        log
      </label>
    </div>
  );
}
