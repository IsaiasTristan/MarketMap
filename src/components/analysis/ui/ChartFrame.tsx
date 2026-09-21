"use client";
/**
 * ChartFrame — the shared scatter/plot frame for the analysis tabs.
 *
 * Every chart built on this gets, for free: real x and y axes with nice ticks,
 * written axis titles carrying units and the direction of "good", optional
 * shaded quadrant zones, in-plot quadrant labels, de-collided point labels
 * (via the pure `placeLabels` used by the flows quadrant), a footer caption,
 * and a real hover popover per point (the portal `DefinitionTooltip`, so it is
 * never clipped and can show the point's own arithmetic).
 *
 * Callers pass data-space points + domains; projection to pixels happens here.
 * Presentational only — it draws numbers that already exist.
 */
import { useMemo } from "react";
import { useMeasure } from "@/components/analysis/flows/quadrant/useMeasure";
import { placeLabels, type LabelInput } from "@/components/analysis/flows/quadrant/labelPlacement";
import { DefinitionTooltip } from "@/components/analysis/ui/DefinitionTooltip";
import type { MetricDef } from "@/lib/analysis/metric-def";

export interface ChartPoint {
  id: string;
  /** Data-space coordinates. */
  x: number;
  y: number;
  r?: number;
  /** Marker glyph (default circle). */
  shape?: "circle" | "square" | "diamond";
  fill: string;
  fillOpacity?: number;
  stroke?: string;
  strokeWidth?: number;
  /** Draw an outer ring (e.g. "new this week"). */
  ring?: boolean;
  ringColor?: string;
  /** Optional de-collided label drawn near the mark. */
  label?: string;
  labelForced?: boolean;
  labelScore?: number;
  /** Hover popover content (with an optional per-point arithmetic line). */
  def?: MetricDef;
  onClick?: () => void;
}

export interface ChartZone {
  /** Data-space rectangle; omit an edge to run to the domain bound. */
  x0?: number;
  x1?: number;
  y0?: number;
  y1?: number;
  fill: string;
  label?: string;
  labelColor?: string;
  labelCorner?: "tl" | "tr" | "bl" | "br";
}

export interface QuadrantLabel {
  /** Data-space anchor. */
  x: number;
  y: number;
  text: string;
  color?: string;
  anchor?: "start" | "middle" | "end";
}

interface ChartFrameProps {
  height: number;
  xDomain: [number, number];
  yDomain: [number, number];
  xTitle: string;
  yTitle: string;
  /** Tick formatters (default: rounded number). */
  xFmt?: (v: number) => string;
  yFmt?: (v: number) => string;
  /** Explicit ticks; when omitted, nice ticks are auto-generated. */
  xTicks?: number[];
  yTicks?: number[];
  zones?: ChartZone[];
  quadrantLabels?: QuadrantLabel[];
  /** Horizontal reference lines (e.g. a signal-gate threshold). */
  hlines?: { y: number; label?: string; color?: string; dash?: boolean }[];
  /** Data-space polylines (e.g. the Pareto frontier). */
  polylines?: { points: [number, number][]; color?: string; dash?: boolean }[];
  points: ChartPoint[];
  footer?: string;
  padding?: { top?: number; right?: number; bottom?: number; left?: number };
  /** Cap the number of labelled points (highest forced/score kept). Zone and
   *  quadrant captions are reserved obstacles regardless, so labels dodge them. */
  maxLabels?: number;
}

const DEFAULT_PAD = { top: 14, right: 14, bottom: 34, left: 44 };
const AXIS = "#3a3a3a";
const GRID = "#161616";
const TICK_FS = 8.5;
const TITLE_FS = 9;

/** ~`count` visually pleasant ticks spanning [lo, hi] (1/2/2.5/5 × 10^k steps). */
function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [lo];
  const span = hi - lo;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2.5 ? 2.5 : norm >= 2 ? 2 : 1) * mag;
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-6; v += step) out.push(Math.abs(v) < step * 1e-6 ? 0 : v);
  return out;
}

export function ChartFrame({
  height,
  xDomain,
  yDomain,
  xTitle,
  yTitle,
  xFmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 1 && v !== 0 ? 2 : 0)),
  yFmt = (v) => (Math.abs(v) >= 1000 ? v.toFixed(0) : v.toFixed(Math.abs(v) < 1 && v !== 0 ? 2 : 0)),
  xTicks,
  yTicks,
  zones = [],
  quadrantLabels = [],
  hlines = [],
  polylines = [],
  points,
  footer,
  padding,
  maxLabels,
}: ChartFrameProps) {
  const [ref, measured] = useMeasure<HTMLDivElement>();
  const W = Math.max(280, measured || 320);
  const H = height;
  const pad = { ...DEFAULT_PAD, ...padding };
  const plotL = pad.left;
  const plotR = W - pad.right;
  const plotT = pad.top;
  const plotB = H - pad.bottom;

  const [xLo, xHi] = xDomain;
  const [yLo, yHi] = yDomain;
  const px = (v: number) => plotL + ((v - xLo) / (xHi - xLo || 1)) * (plotR - plotL);
  const py = (v: number) => plotB - ((v - yLo) / (yHi - yLo || 1)) * (plotB - plotT);
  const clampX = (v: number) => Math.max(xLo, Math.min(xHi, v));
  const clampY = (v: number) => Math.max(yLo, Math.min(yHi, v));

  const xt = xTicks ?? niceTicks(xLo, xHi);
  const yt = yTicks ?? niceTicks(yLo, yHi);

  // Zero axes if within domain, else clamp to the plot edge.
  const zeroX = px(xLo <= 0 && 0 <= xHi ? 0 : xLo);
  const zeroY = py(yLo <= 0 && 0 <= yHi ? 0 : yLo);

  const zoneRect = (z: ChartZone) => {
    const x0 = px(z.x0 ?? xLo);
    const x1 = px(z.x1 ?? xHi);
    const y0 = py(z.y1 ?? yHi); // top
    const y1 = py(z.y0 ?? yLo); // bottom
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  };

  // De-collided labels (pixel space) for points carrying a `label`. Zone,
  // quadrant and hline captions are reserved obstacles so labels dodge chrome.
  const placed = useMemo(() => {
    // Approximate the pixel rect a caption occupies, given its baseline anchor.
    const CAP_FS = 8;
    const CAP_CW = 4.4;
    const textRect = (x: number, y: number, text: string, anchor: "start" | "middle" | "end") => {
      const w = text.length * CAP_CW + 2;
      const rx = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
      return { x: rx, y: y - CAP_FS, w, h: CAP_FS + 2 };
    };
    const reserved = [] as { x: number; y: number; w: number; h: number }[];
    for (const z of zones) {
      if (!z.label) continue;
      const r = zoneRect(z);
      const corner = z.labelCorner ?? "br";
      const x = corner === "tr" || corner === "br" ? r.x + r.w - 4 : r.x + 4;
      const y = corner === "tl" || corner === "tr" ? r.y + 10 : r.y + r.h - 5;
      const anchor = corner === "tr" || corner === "br" ? "end" : "start";
      reserved.push(textRect(x, y, z.label, anchor));
    }
    for (const q of quadrantLabels) {
      reserved.push(textRect(px(q.x), py(q.y), q.text, q.anchor ?? "middle"));
    }
    for (const h of hlines) {
      if (!h.label) continue;
      reserved.push(textRect(plotL + 4, py(clampY(h.y)) - 3, h.label, "start"));
    }

    const inputs: LabelInput[] = points
      .filter((p) => p.label)
      .map((p) => ({
        id: p.id,
        x: px(clampX(p.x)),
        y: py(clampY(p.y)),
        r: p.r ?? 3,
        text: p.label!,
        score: p.labelScore ?? 0,
        forced: Boolean(p.labelForced),
      }));
    const budgeted =
      maxLabels != null && inputs.length > maxLabels
        ? [...inputs]
            .sort((a, b) => Number(b.forced) - Number(a.forced) || b.score - a.score)
            .slice(0, maxLabels)
        : inputs;
    return placeLabels(
      budgeted,
      { x0: plotL, y0: plotT, x1: plotR, y1: plotB },
      { fontSize: 8.5, charWidth: 4.6, pad: 1, slots: ["right", "above-right", "below-right", "left"] },
      reserved,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points, W, H, maxLabels]);

  return (
    <div ref={ref} style={{ width: "100%", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ position: "relative", flex: 1, minHeight: 0 }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", background: "var(--bg-surface)" }}>
          {/* shaded zones */}
          {zones.map((z, i) => {
            const r = zoneRect(z);
            return <rect key={`z${i}`} x={r.x} y={r.y} width={r.w} height={r.h} fill={z.fill} />;
          })}

          {/* gridlines */}
          {xt.map((t) => (
            <line key={`gx${t}`} x1={px(t)} y1={plotT} x2={px(t)} y2={plotB} stroke={GRID} strokeWidth={1} />
          ))}
          {yt.map((t) => (
            <line key={`gy${t}`} x1={plotL} y1={py(t)} x2={plotR} y2={py(t)} stroke={GRID} strokeWidth={1} />
          ))}

          {/* zero axes */}
          <line x1={plotL} y1={zeroY} x2={plotR} y2={zeroY} stroke={AXIS} strokeWidth={1} />
          <line x1={zeroX} y1={plotT} x2={zeroX} y2={plotB} stroke={AXIS} strokeWidth={1} />

          {/* x ticks + labels */}
          {xt.map((t) => (
            <g key={`tx${t}`}>
              <line x1={px(t)} y1={plotB} x2={px(t)} y2={plotB + 3} stroke={AXIS} strokeWidth={1} />
              <text x={px(t)} y={plotB + 12} textAnchor="middle" fontSize={TICK_FS} fill="var(--text-muted)">
                {xFmt(t)}
              </text>
            </g>
          ))}
          {/* y ticks + labels */}
          {yt.map((t) => (
            <g key={`ty${t}`}>
              <line x1={plotL - 3} y1={py(t)} x2={plotL} y2={py(t)} stroke={AXIS} strokeWidth={1} />
              <text x={plotL - 5} y={py(t) + 3} textAnchor="end" fontSize={TICK_FS} fill="var(--text-muted)">
                {yFmt(t)}
              </text>
            </g>
          ))}

          {/* axis titles */}
          <text x={(plotL + plotR) / 2} y={H - 4} textAnchor="middle" fontSize={TITLE_FS} fill="var(--text-secondary)" letterSpacing={0.4}>
            {xTitle}
          </text>
          <text
            x={11}
            y={(plotT + plotB) / 2}
            textAnchor="middle"
            fontSize={TITLE_FS}
            fill="var(--text-secondary)"
            letterSpacing={0.4}
            transform={`rotate(-90 11 ${(plotT + plotB) / 2})`}
          >
            {yTitle}
          </text>

          {/* zone corner labels */}
          {zones.map((z, i) => {
            if (!z.label) return null;
            const r = zoneRect(z);
            const corner = z.labelCorner ?? "br";
            const x = corner === "tr" || corner === "br" ? r.x + r.w - 4 : r.x + 4;
            const y = corner === "tl" || corner === "tr" ? r.y + 10 : r.y + r.h - 5;
            const anchor = corner === "tr" || corner === "br" ? "end" : "start";
            return (
              <text key={`zl${i}`} x={x} y={y} textAnchor={anchor} fontSize={8} fill={z.labelColor ?? "var(--text-muted)"} letterSpacing={0.3}>
                {z.label}
              </text>
            );
          })}

          {/* horizontal reference lines */}
          {hlines.map((h, i) => (
            <g key={`hl${i}`}>
              <line
                x1={plotL}
                y1={py(clampY(h.y))}
                x2={plotR}
                y2={py(clampY(h.y))}
                stroke={h.color ?? "var(--color-accent)"}
                strokeWidth={1}
                strokeDasharray={h.dash === false ? undefined : "3 3"}
              />
              {h.label && (
                <text x={plotL + 4} y={py(clampY(h.y)) - 3} fontSize={8} fill={h.color ?? "var(--color-accent)"} letterSpacing={0.3}>
                  {h.label}
                </text>
              )}
            </g>
          ))}

          {/* polylines (e.g. Pareto frontier) */}
          {polylines.map((pl, i) => (
            <polyline
              key={`pl${i}`}
              points={pl.points.map(([x, y]) => `${px(clampX(x)).toFixed(1)},${py(clampY(y)).toFixed(1)}`).join(" ")}
              fill="none"
              stroke={pl.color ?? "var(--color-accent)"}
              strokeWidth={1.2}
              strokeDasharray={pl.dash === false ? undefined : "4 3"}
            />
          ))}

          {/* quadrant labels */}
          {quadrantLabels.map((q, i) => (
            <text key={`ql${i}`} x={px(q.x)} y={py(q.y)} textAnchor={q.anchor ?? "middle"} fontSize={8} fill={q.color ?? "var(--text-muted)"} letterSpacing={0.3}>
              {q.text}
            </text>
          ))}

          {/* points */}
          {points.map((p) => {
            const cx = px(clampX(p.x));
            const cy = py(clampY(p.y));
            const rad = p.r ?? 3;
            const shape = p.shape ?? "circle";
            const marker =
              shape === "square" ? (
                <rect
                  x={cx - rad}
                  y={cy - rad}
                  width={rad * 2}
                  height={rad * 2}
                  fill={p.fill}
                  fillOpacity={p.fillOpacity ?? 0.85}
                  stroke={p.stroke ?? "var(--bg-base)"}
                  strokeWidth={p.strokeWidth ?? 0.5}
                />
              ) : shape === "diamond" ? (
                <path
                  d={`M${cx},${cy - rad - 0.5} L${cx + rad + 0.5},${cy} L${cx},${cy + rad + 0.5} L${cx - rad - 0.5},${cy} Z`}
                  fill={p.fill}
                  fillOpacity={p.fillOpacity ?? 0.85}
                  stroke={p.stroke ?? "var(--bg-base)"}
                  strokeWidth={p.strokeWidth ?? 0.5}
                />
              ) : (
                <circle
                  cx={cx}
                  cy={cy}
                  r={rad}
                  fill={p.fill}
                  fillOpacity={p.fillOpacity ?? 0.85}
                  stroke={p.stroke ?? "var(--bg-base)"}
                  strokeWidth={p.strokeWidth ?? 0.5}
                />
              );
            // A point whose data coords sit outside the domain is clamped to the
            // edge (nothing is dropped). Mark it with a small open arrowhead
            // pointing off-plot in each clamped direction so a pinned mark is not
            // misread as a real in-range value.
            const clampDirs: string[] = [];
            if (p.x > xHi) clampDirs.push("E");
            else if (p.x < xLo) clampDirs.push("W");
            if (p.y > yHi) clampDirs.push("N");
            else if (p.y < yLo) clampDirs.push("S");
            const arrow = (dir: string, k: number) => {
              const s = rad + 3;
              const t =
                dir === "E" ? `M${cx + s},${cy} l-4,-3 m4,3 l-4,3` :
                dir === "W" ? `M${cx - s},${cy} l4,-3 m-4,3 l4,3` :
                dir === "N" ? `M${cx},${cy - s} l-3,4 m3,-4 l3,4` :
                `M${cx},${cy + s} l-3,-4 m3,4 l3,-4`;
              return <path key={`clp${p.id}${k}`} d={t} fill="none" stroke={p.stroke ?? p.fill} strokeWidth={1} />;
            };
            return (
              <g key={p.id}>
                {p.ring && (
                  <circle cx={cx} cy={cy} r={rad + 2.5} fill="none" stroke={p.ringColor ?? "var(--color-accent)"} strokeWidth={1} />
                )}
                {marker}
                {clampDirs.map((d, k) => arrow(d, k))}
              </g>
            );
          })}

          {/* de-collided labels */}
          {placed.map((l) => (
            <text key={`lbl${l.id}`} x={l.x} y={l.y} textAnchor={l.anchor} fontSize={8.5} fill="var(--text-secondary)">
              {l.text}
            </text>
          ))}
        </svg>

        {/* HTML hit-target overlay: reuses the portal DefinitionTooltip so hover
            popovers are never clipped and show the point's own arithmetic. */}
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          {points.map((p) => {
            const cx = (px(clampX(p.x)) / W) * 100;
            const cy = (py(clampY(p.y)) / H) * 100;
            const hit = Math.max(9, (p.r ?? 3) * 2 + 6);
            const trigger = (
              <span
                onClick={p.onClick}
                style={{
                  display: "block",
                  width: hit,
                  height: hit,
                  borderRadius: "50%",
                  cursor: p.onClick ? "pointer" : "help",
                  borderBottom: "none",
                }}
              />
            );
            return (
              <div
                key={`hit${p.id}`}
                style={{
                  position: "absolute",
                  left: `${cx}%`,
                  top: `${cy}%`,
                  transform: "translate(-50%, -50%)",
                  pointerEvents: "auto",
                }}
              >
                {p.def ? (
                  <DefinitionTooltip def={p.def} style={{ borderBottom: "none" }}>
                    {trigger}
                  </DefinitionTooltip>
                ) : (
                  trigger
                )}
              </div>
            );
          })}
        </div>
      </div>
      {footer && (
        <div style={{ fontSize: 8.5, color: "var(--text-muted)", padding: "3px 4px 0" }}>{footer}</div>
      )}
    </div>
  );
}
