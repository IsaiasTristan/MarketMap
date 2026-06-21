"use client";
/**
 * HeaderDistributionStrip — 1-row column-header distribution sparkline.
 *
 * Renders the cohort distribution for a single screener column as a thin
 * histogram (or three-tick min/median/max indicator when the cohort is
 * small). When a row is hovered in the grid, an accent vertical tick
 * marks where that row's value falls in the cohort distribution.
 *
 * The strip's distribution is the *active cohort* — i.e. when Rank Vs =
 * Sector and the user hovers an Energy row, the strip shows Energy's
 * distribution and the tick shows that row's position within Energy.
 * When no row is hovered, the parent passes universe-wide stats so the
 * resting visual is the full universe.
 *
 * Always renders raw values regardless of the active Stat lens (Z, Pct,
 * etc.) — the strip's job is "shape and skew of the distribution," not
 * the cohort-relative number the cell already shows.
 */
import {
  buildHistogramBins,
  histogramMode,
  threeTickFromStats,
  valuePositionInCohort,
  type ScreenerColumnStats,
} from "@/lib/factors/screener";

interface HeaderDistributionStripProps {
  /** Cohort stats for this column. Null → renders empty placeholder. */
  stats: ScreenerColumnStats | null;
  /**
   * Raw value of the currently-hovered row in this column. Null when no
   * row is hovered or the cell is empty (e.g., factor cell missing for
   * the row). Sig-gated cells still pass their value here so the tick
   * shows where a low-|t| row would have ranked — the cell next to it
   * already renders "·" to communicate the gate.
   */
  hoveredValue: number | null;
  /** Strip width in pixels (matches the <th> content width). */
  width: number;
  /** Strip height in pixels. Defaults to 14. */
  height?: number;
}

const BAR_FILL = "rgba(180,180,180,0.45)";
const BASELINE = "rgba(255,255,255,0.10)";
const ZERO_LINE = "rgba(255,255,255,0.18)";
const TICK_FALLBACK = "rgba(255,255,255,0.55)";
const TICK_ACCENT = "var(--color-accent)";

export function HeaderDistributionStrip({
  stats,
  hoveredValue,
  width,
  height = 14,
}: HeaderDistributionStripProps) {
  if (width <= 0 || height <= 0) {
    return <div style={{ width, height }} aria-hidden />;
  }

  const mode = histogramMode(stats);
  if (mode === "empty" || !stats) {
    return <div style={{ width, height }} aria-hidden />;
  }

  // Tick position (cohort min/max bounded → [0, 1]) for the hovered row.
  const tickT = valuePositionInCohort(hoveredValue, stats);
  const tickX = tickT !== null ? tickT * width : null;

  // Zero-line position (only when the cohort spans both signs).
  const zeroLineX =
    stats.min < 0 && stats.max > 0
      ? ((0 - stats.min) / (stats.max - stats.min)) * width
      : null;

  const baseline = (
    <line
      x1={0}
      y1={height - 0.5}
      x2={width}
      y2={height - 0.5}
      stroke={BASELINE}
      strokeWidth={1}
    />
  );

  const zeroLine =
    zeroLineX !== null ? (
      <line
        x1={zeroLineX}
        y1={0}
        x2={zeroLineX}
        y2={height}
        stroke={ZERO_LINE}
        strokeDasharray="1 2"
        strokeWidth={1}
      />
    ) : null;

  const tick =
    tickX !== null ? (
      <line
        x1={tickX}
        y1={0}
        x2={tickX}
        y2={height}
        stroke={TICK_ACCENT}
        strokeWidth={1.5}
      />
    ) : null;

  if (mode === "threeTick") {
    const t = threeTickFromStats(stats);
    if (!t) return <div style={{ width, height }} aria-hidden />;
    const range = t.max - t.min;
    const xMin = 0;
    const xMax = width;
    const xMed = range > 0 ? ((t.median - t.min) / range) * width : width / 2;
    const tickStyle = (x: number, color: string) => (
      <line
        x1={x}
        y1={1}
        x2={x}
        y2={height - 1}
        stroke={color}
        strokeWidth={1}
      />
    );
    return (
      <svg
        width={width}
        height={height}
        style={{ display: "block", overflow: "visible" }}
        aria-hidden
      >
        {baseline}
        {zeroLine}
        {/* range bar between min and max */}
        <line
          x1={xMin}
          y1={height / 2}
          x2={xMax}
          y2={height / 2}
          stroke={TICK_FALLBACK}
          strokeWidth={1}
          strokeDasharray="2 2"
        />
        {tickStyle(xMin + 0.5, TICK_FALLBACK)}
        {tickStyle(xMed, TICK_FALLBACK)}
        {tickStyle(xMax - 0.5, TICK_FALLBACK)}
        {tick}
      </svg>
    );
  }

  // histogram mode
  const bins = buildHistogramBins(stats.sortedValues);
  const maxCount = bins.reduce((m, b) => Math.max(m, b.count), 0);
  const binWidth = bins.length > 0 ? width / bins.length : width;
  const safeBinWidth = Math.max(0, binWidth - 0.5);

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", overflow: "visible" }}
      aria-hidden
    >
      {baseline}
      {bins.map((b, i) => {
        const h = maxCount > 0 ? (b.count / maxCount) * (height - 1) : 0;
        return (
          <rect
            key={i}
            x={i * binWidth}
            y={height - h}
            width={safeBinWidth}
            height={h}
            fill={BAR_FILL}
          />
        );
      })}
      {zeroLine}
      {tick}
    </svg>
  );
}
