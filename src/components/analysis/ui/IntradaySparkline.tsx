"use client";

const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 18;

interface IntradaySparklineProps {
  series: number[];
  extendedSeries?: number[];
  prevClose: number | null;
  /** Last-resort regular series when primary is empty (e.g. prior session). */
  fallbackSeries?: number[];
  width?: number;
  height?: number;
  /** Stretch to container width via viewBox (holdings table seam layout). */
  fluid?: boolean;
}

function hasFinitePrevClose(prevClose: number | null): prevClose is number {
  return prevClose != null && Number.isFinite(prevClose) && prevClose !== 0;
}

/**
 * Bicolor intraday sparkline — green above prev close, red below.
 * Optional extended tail (PRE/POST) renders as dashed gray on the right.
 */
export function IntradaySparkline({
  series,
  extendedSeries = [],
  prevClose,
  fallbackSeries = [],
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  fluid = false,
}: IntradaySparklineProps) {
  const regular =
    series.length >= 2
      ? series
      : fallbackSeries.length >= 2
        ? fallbackSeries
        : series;
  const extended = extendedSeries ?? [];

  const canRenderRegular = regular.length >= 2 && hasFinitePrevClose(prevClose);
  const canRenderExtended = extended.length >= 2;

  if (!canRenderRegular && !canRenderExtended) {
    return null;
  }

  const allValues = [
    ...(canRenderRegular ? regular : []),
    ...(canRenderExtended ? extended : []),
    ...(canRenderRegular && hasFinitePrevClose(prevClose) ? [prevClose] : []),
  ];

  let dataMin = Math.min(...allValues);
  let dataMax = Math.max(...allValues);
  if (dataMin === dataMax) {
    dataMin -= 1;
    dataMax += 1;
  }
  const span = dataMax - dataMin;
  const pad = span * 0.1;
  const yMin = dataMin - pad;
  const yMax = dataMax + pad;

  const logicalWidth = fluid ? DEFAULT_WIDTH : width;
  const svgProps = fluid
    ? {
        width: "100%" as const,
        height,
        viewBox: `0 0 ${DEFAULT_WIDTH} ${height}`,
        preserveAspectRatio: "none" as const,
        style: { display: "block", verticalAlign: "middle" as const },
      }
    : {
        width,
        height,
        style: { flexShrink: 0, display: "block" },
      };

  const toY = (v: number) =>
    height - ((v - yMin) / (yMax - yMin)) * height;

  const regN = canRenderRegular ? regular.length : 0;
  const extN = canRenderExtended ? extended.length : 0;
  const totalSlots = Math.max(regN + extN, 2);
  const regWidth =
    regN > 0 && extN > 0
      ? logicalWidth * (regN / totalSlots)
      : regN > 0
        ? logicalWidth
        : 0;
  const joinX = regWidth;

  const toRegX = (i: number) =>
    regN <= 1 ? regWidth / 2 : (i / (regN - 1)) * regWidth;
  const toExtX = (i: number) => {
    if (extN <= 1) return joinX + (logicalWidth - joinX) / 2;
    const extSpan = logicalWidth - joinX;
    return joinX + (i / (extN - 1)) * extSpan;
  };

  const baselineY =
    canRenderRegular && hasFinitePrevClose(prevClose)
      ? toY(prevClose)
      : height / 2;

  const uid = `${regN}-${extN}-${baselineY.toFixed(0)}-${logicalWidth}`;

  const regPts = canRenderRegular
    ? regular.map((v, i) => `${toRegX(i).toFixed(2)},${toY(v).toFixed(2)}`)
    : [];
  const extPts = canRenderExtended
    ? extended.map((v, i) => `${toExtX(i).toFixed(2)},${toY(v).toFixed(2)}`)
    : [];

  const regLinePath = regPts.length > 0 ? `M${regPts.join(" L")}` : "";
  const regAreaPath =
    regPts.length > 0
      ? `M${toRegX(0).toFixed(2)},${baselineY.toFixed(2)} L${regPts.join(
          " L",
        )} L${toRegX(regN - 1).toFixed(2)},${baselineY.toFixed(2)} Z`
      : "";

  const extLinePath = extPts.length > 0 ? `M${extPts.join(" L")}` : "";
  const bridgePath =
    canRenderRegular && canRenderExtended && regPts.length > 0 && extPts.length > 0
      ? `M${regPts[regPts.length - 1]} L${extPts[0]}`
      : "";

  return (
    <svg {...svgProps} aria-hidden>
      {canRenderRegular && (
        <>
          <defs>
            <clipPath id={`spark-above-${uid}`}>
              <rect x={0} y={0} width={regWidth} height={baselineY} />
            </clipPath>
            <clipPath id={`spark-below-${uid}`}>
              <rect
                x={0}
                y={baselineY}
                width={regWidth}
                height={Math.max(0, height - baselineY)}
              />
            </clipPath>
          </defs>
          <path
            d={regAreaPath}
            fill="var(--color-positive)"
            fillOpacity={0.45}
            clipPath={`url(#spark-above-${uid})`}
          />
          <path
            d={regAreaPath}
            fill="var(--color-negative)"
            fillOpacity={0.45}
            clipPath={`url(#spark-below-${uid})`}
          />
          <line
            x1={0}
            x2={regWidth}
            y1={baselineY}
            y2={baselineY}
            stroke="var(--text-muted)"
            strokeDasharray="2 2"
            strokeWidth={0.75}
            opacity={0.6}
          />
          <path
            d={regLinePath}
            fill="none"
            stroke="var(--text-secondary)"
            strokeWidth={1}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}

      {canRenderRegular && canRenderExtended && (
        <line
          x1={joinX}
          x2={joinX}
          y1={1}
          y2={height - 1}
          stroke="var(--text-muted)"
          strokeWidth={0.75}
          opacity={0.5}
        />
      )}

      {canRenderExtended && (
        <>
          {bridgePath && (
            <path
              d={bridgePath}
              fill="none"
              stroke="var(--text-muted)"
              strokeWidth={1}
              strokeDasharray="2 2"
              strokeLinecap="round"
            />
          )}
          <path
            d={extLinePath}
            fill="none"
            stroke="var(--text-muted)"
            strokeWidth={1}
            strokeDasharray="2 2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </>
      )}
    </svg>
  );
}
