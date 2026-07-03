"use client";
/**
 * Hand-rolled SVG scatter for the crowding × conviction view. Layers, bottom-up:
 * grid/axes → reference lines → BACKGROUND dots (context, never hit-tested) →
 * FOREGROUND marks (tooltips, click-through). Hit-testing is a nearest-point
 * scan over the foreground array only.
 */
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { makeScales, type PlottedPoint, type QuadrantModel } from "./quadrantModel";
import { QUADRANT_CONFIG } from "./quadrantConfig";
import { placeLabels, placeOptsFromConfig, type LabelInput } from "./labelPlacement";

export interface HoverState {
  point: PlottedPoint;
  /** Pixel position of the mark inside the chart container. */
  x: number;
  y: number;
}

const MARGIN = { top: 14, right: 20, bottom: 38, left: 50 };
const HIT_SLOP = 4;
const MIN_HIT_RADIUS = 12;

interface Positioned {
  p: PlottedPoint;
  x: number;
  y: number;
}

export function QuadrantChart({
  model,
  width,
  height,
  onHover,
  onClickTicker,
}: {
  model: QuadrantModel;
  width: number;
  height: number;
  onHover: (h: HoverState | null) => void;
  onClickTicker: (ticker: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const rect = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, width - MARGIN.left - MARGIN.right),
    height: Math.max(10, height - MARGIN.top - MARGIN.bottom),
  };

  const { scales, bgPos, fgPos, labels } = useMemo(() => {
    const s = makeScales(model, rect);
    const place = (p: PlottedPoint): Positioned => ({ p, x: s.x(p.breadth), y: s.y(p.conviction) });
    const fg = model.foreground.map(place);

    // Label candidates: the top-N foreground by score, unioned with every
    // danger-zone name (crowded high-conviction distribution — always called out).
    const cfg = QUADRANT_CONFIG.labels;
    const byScore = [...fg].sort((a, b) => b.p.score - a.p.score);
    const chosen = new Map<string, Positioned>();
    for (const pos of byScore.slice(0, cfg.maxByScore)) chosen.set(pos.p.ticker, pos);
    for (const pos of fg) if (pos.p.danger) chosen.set(pos.p.ticker, pos);

    const inputs: LabelInput[] = [...chosen.values()].map((pos) => ({
      id: pos.p.ticker,
      x: pos.x,
      y: pos.y,
      r: pos.p.r,
      text: pos.p.ticker,
      score: pos.p.score,
      forced: pos.p.danger,
    }));
    const bounds = { x0: rect.left, y0: rect.top, x1: rect.left + rect.width, y1: rect.top + rect.height };
    const placed = placeLabels(inputs, bounds, placeOptsFromConfig(QUADRANT_CONFIG));

    return { scales: s, bgPos: model.background.map(place), fgPos: fg, labels: placed };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, rect.left, rect.top, rect.width, rect.height]);

  const labeledIds = useMemo(() => new Set(labels.map((l) => l.id)), [labels]);

  function hitTest(evt: React.MouseEvent<SVGSVGElement>): Positioned | null {
    const bounds = evt.currentTarget.getBoundingClientRect();
    const mx = evt.clientX - bounds.left;
    const my = evt.clientY - bounds.top;
    let best: Positioned | null = null;
    let bestD = Infinity;
    for (const pos of fgPos) {
      const d = Math.hypot(pos.x - mx, pos.y - my);
      if (d < bestD && d <= Math.max(pos.p.r + HIT_SLOP, MIN_HIT_RADIUS)) {
        best = pos;
        bestD = d;
      }
    }
    return best;
  }

  function handleMove(evt: React.MouseEvent<SVGSVGElement>) {
    const hit = hitTest(evt);
    if (hit) {
      if (hit.p.ticker !== hovered) setHovered(hit.p.ticker);
      onHover({ point: hit.p, x: hit.x, y: hit.y });
    } else if (hovered !== null) {
      setHovered(null);
      onHover(null);
    }
  }

  function handleLeave() {
    if (hovered !== null) setHovered(null);
    onHover(null);
  }

  function handleClick(evt: React.MouseEvent<SVGSVGElement>) {
    const hit = hitTest(evt);
    if (hit) onClickTicker(hit.p.ticker);
  }

  const tickStyle: CSSProperties = { fontSize: 10, fill: "var(--text-secondary)" };
  const labelStyle: CSSProperties = { fontSize: 10, fill: "var(--text-secondary)" };
  const refLabelStyle: CSSProperties = { fontSize: 10, fill: "var(--text-muted)" };
  const labelTextStyle: CSSProperties = { fontSize: QUADRANT_CONFIG.labels.fontSize, fill: "var(--text-primary)", fontWeight: 600 };
  const hoverLabelStyle: CSSProperties = { ...labelTextStyle, fill: "var(--bb-highlight-text)" };
  const cfg = QUADRANT_CONFIG;

  // On hover of an already-labeled mark, no extra label; otherwise a transient
  // one placed to the right (fixed offset — no collision pass needed for one).
  const hoverLabel = (() => {
    if (!hovered || labeledIds.has(hovered)) return null;
    const pos = fgPos.find((f) => f.p.ticker === hovered);
    if (!pos) return null;
    return { text: pos.p.ticker, x: pos.x + pos.p.r + 4, y: pos.y + 3, anchor: "start" as const };
  })();

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block" }}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
      onClick={handleClick}
    >
      {/* Grid */}
      {model.xTicks.map((t) => (
        <line key={`gx${t}`} x1={scales.x(t)} x2={scales.x(t)} y1={rect.top} y2={rect.top + rect.height} stroke="var(--bg-border)" strokeDasharray="2 4" />
      ))}
      {model.yTicks.map((t) => (
        <line key={`gy${t}`} x1={rect.left} x2={rect.left + rect.width} y1={scales.y(t)} y2={scales.y(t)} stroke="var(--bg-border)" strokeDasharray="2 4" />
      ))}

      {/* Axis tick labels */}
      {model.xTicks.map((t) => (
        <text key={`tx${t}`} x={scales.x(t)} y={rect.top + rect.height + 14} textAnchor="middle" style={tickStyle}>
          {t}%
        </text>
      ))}
      {model.yTicks.map((t) => (
        <text key={`ty${t}`} x={rect.left - 6} y={scales.y(t) + 3} textAnchor="end" style={tickStyle}>
          {t}%
        </text>
      ))}

      {/* Axis titles */}
      <text x={rect.left + rect.width / 2} y={height - 6} textAnchor="middle" style={labelStyle}>
        Breadth — % of tracked funds holding →
      </text>
      <text x={12} y={rect.top + rect.height / 2} textAnchor="middle" transform={`rotate(-90 12 ${rect.top + rect.height / 2})`} style={labelStyle}>
        Conviction — median % of book ↑
      </text>

      {/* Reference lines */}
      <line x1={scales.x(model.breadthLine)} x2={scales.x(model.breadthLine)} y1={rect.top} y2={rect.top + rect.height} stroke="var(--text-muted)" strokeDasharray="3 3" />
      <text x={scales.x(model.breadthLine)} y={rect.top - 3} textAnchor="middle" style={refLabelStyle}>
        {model.breadthLine}% breadth
      </text>
      <line x1={rect.left} x2={rect.left + rect.width} y1={scales.y(model.convictionLine)} y2={scales.y(model.convictionLine)} stroke="var(--text-muted)" strokeDasharray="3 3" />
      <text x={rect.left + rect.width - 4} y={scales.y(model.convictionLine) - 4} textAnchor="end" style={refLabelStyle}>
        median conviction
      </text>

      {/* BACKGROUND layer — context only, never intercepts hover/click. */}
      <g style={{ pointerEvents: "none" }} opacity={cfg.colors.backgroundOpacity}>
        {bgPos.map(({ p, x, y }) => (
          <circle key={p.ticker} cx={x} cy={y} r={p.r} fill={p.fill} />
        ))}
      </g>

      {/* FOREGROUND layer */}
      <g>
        {fgPos.map(({ p, x, y }) => (
          <circle
            key={p.ticker}
            cx={x}
            cy={y}
            r={p.r}
            fill={p.fill}
            fillOpacity={0.75}
            stroke={hovered === p.ticker ? "var(--text-primary)" : "none"}
            strokeWidth={hovered === p.ticker ? 1 : 0}
          />
        ))}
      </g>

      {/* Selective labels (deterministic placement) */}
      <g style={{ pointerEvents: "none" }}>
        {labels.map((l) => (
          <text key={l.id} x={l.x} y={l.y} textAnchor={l.anchor} style={labelTextStyle}>
            {l.text}
          </text>
        ))}
        {/* Hover label for an unlabeled foreground mark. */}
        {hoverLabel && (
          <text x={hoverLabel.x} y={hoverLabel.y} textAnchor={hoverLabel.anchor} style={hoverLabelStyle}>
            {hoverLabel.text}
          </text>
        )}
      </g>
    </svg>
  );
}
