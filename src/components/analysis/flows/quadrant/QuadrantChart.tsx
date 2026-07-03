"use client";
/**
 * Hand-rolled SVG scatter for the crowding × conviction view. Layers, bottom-up:
 * grid/axes → reference lines → BACKGROUND dots (context, never hit-tested) →
 * FOREGROUND marks (tooltips, click-through). Hit-testing is a nearest-point
 * scan over the foreground array only.
 */
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { flowColor, flowRadius, makeScales, type PlottedPoint, type QuadrantModel } from "./quadrantModel";
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
  search,
  showTrails,
  showZones,
  onHover,
  onPinnedChange,
  onClickTicker,
}: {
  model: QuadrantModel;
  width: number;
  height: number;
  /** Active search query — matches (ticker + name) are highlighted, others dimmed. */
  search: string;
  /** When on, draw QoQ trails for every labeled mark (not just the hovered one). */
  showTrails: boolean;
  /** When on, draw the interpretation-zone overlay (p75 boundaries + labels). */
  showZones: boolean;
  onHover: (h: HoverState | null) => void;
  /** Reports the single searched match (with position) for a persistent tooltip. */
  onPinnedChange: (h: HoverState | null) => void;
  onClickTicker: (ticker: string) => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);

  const rect = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, width - MARGIN.left - MARGIN.right),
    height: Math.max(10, height - MARGIN.top - MARGIN.bottom),
  };

  const { scales, bgPos, fgPos, labels, badges } = useMemo(() => {
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

    // A persistence badge (×N) is appended to the label text so its width is
    // accounted for during collision placement; it's rendered in accent below.
    const badgeOf = (p: PlottedPoint) => (Math.abs(p.holderStreak) >= QUADRANT_CONFIG.streak.badgeMin ? `×${Math.abs(p.holderStreak)}` : "");
    const inputs: LabelInput[] = [...chosen.values()].map((pos) => {
      const badge = badgeOf(pos.p);
      return {
        id: pos.p.ticker,
        x: pos.x,
        y: pos.y,
        r: pos.p.r,
        text: badge ? `${pos.p.ticker} ${badge}` : pos.p.ticker,
        score: pos.p.score,
        forced: pos.p.danger,
      };
    });
    const bounds = { x0: rect.left, y0: rect.top, x1: rect.left + rect.width, y1: rect.top + rect.height };
    const placed = placeLabels(inputs, bounds, placeOptsFromConfig(QUADRANT_CONFIG));
    const badges = new Map(fg.map((pos) => [pos.p.ticker, badgeOf(pos.p)] as const).filter(([, b]) => b));

    return { scales: s, bgPos: model.background.map(place), fgPos: fg, labels: placed, badges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, rect.left, rect.top, rect.width, rect.height]);

  const labeledIds = useMemo(() => new Set(labels.map((l) => l.id)), [labels]);

  // Search: match ticker + company name (case-insensitive substring), across
  // BOTH layers, so a name filtered out of the foreground can still be found.
  const matchSet = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return null;
    const set = new Set<string>();
    const hit = (p: PlottedPoint) => p.ticker.toLowerCase().includes(q) || (p.companyName ?? "").toLowerCase().includes(q);
    for (const pos of fgPos) if (hit(pos.p)) set.add(pos.p.ticker);
    for (const pos of bgPos) if (hit(pos.p)) set.add(pos.p.ticker);
    return set;
  }, [search, fgPos, bgPos]);
  const searching = matchSet !== null;

  // Matched background names are promoted to full foreground rendering.
  const promotedBg = useMemo(
    () => (matchSet ? bgPos.filter((pos) => matchSet.has(pos.p.ticker)) : []),
    [matchSet, bgPos],
  );

  // A lone match gets a persistent tooltip; report it (with position) to the panel.
  useEffect(() => {
    if (matchSet && matchSet.size === 1) {
      const t = [...matchSet][0];
      const pos = fgPos.find((f) => f.p.ticker === t) ?? bgPos.find((b) => b.p.ticker === t);
      onPinnedChange(pos ? { point: pos.p, x: pos.x, y: pos.y } : null);
    } else {
      onPinnedChange(null);
    }
  }, [matchSet, fgPos, bgPos, onPinnedChange]);

  function hitTest(evt: React.MouseEvent<SVGSVGElement>): Positioned | null {
    const bounds = evt.currentTarget.getBoundingClientRect();
    const mx = evt.clientX - bounds.left;
    const my = evt.clientY - bounds.top;
    // Promoted background matches become hoverable while searching.
    const targets = searching ? [...fgPos, ...promotedBg] : fgPos;
    let best: Positioned | null = null;
    let bestD = Infinity;
    for (const pos of targets) {
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

  // Trails: every labeled mark when the toggle is on, plus the hovered mark
  // always. Only names with a prior-quarter position (prev != null) get one.
  const trailPositions = useMemo(() => {
    const out: Positioned[] = [];
    const seen = new Set<string>();
    const add = (pos: Positioned | undefined) => {
      if (pos?.p.prev && !seen.has(pos.p.ticker)) {
        seen.add(pos.p.ticker);
        out.push(pos);
      }
    };
    if (showTrails) for (const pos of fgPos) if (labeledIds.has(pos.p.ticker)) add(pos);
    if (hovered) add(fgPos.find((f) => f.p.ticker === hovered) ?? promotedBg.find((b) => b.p.ticker === hovered));
    return out;
  }, [fgPos, promotedBg, showTrails, labeledIds, hovered]);

  return (
    <svg
      width={width}
      height={height}
      style={{ display: "block", cursor: hovered ? "pointer" : "default" }}
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

      {/* ZONE OVERLAY — p75 interpretation regions (toggleable, drawn behind marks). */}
      {showZones && (() => {
        const px = scales.x(model.p75Breadth);
        const py = scales.y(model.p75Conviction);
        const left = rect.left;
        const right = rect.left + rect.width;
        const top = rect.top;
        const bottom = rect.top + rect.height;
        const zoneStyle: CSSProperties = { fontSize: cfg.zones.fontSize, fill: "var(--text-muted)", opacity: 0.55, fontStyle: "italic" };
        return (
          <g style={{ pointerEvents: "none" }}>
            <line x1={px} x2={px} y1={top} y2={bottom} stroke="var(--text-muted)" strokeDasharray="1 5" strokeOpacity={0.3} />
            <line x1={left} x2={right} y1={py} y2={py} stroke="var(--text-muted)" strokeDasharray="1 5" strokeOpacity={0.3} />
            <text x={left + (px - left) / 2} y={top + 14} textAnchor="middle" style={zoneStyle}>emerging conviction</text>
            <text x={px + (right - px) / 2} y={top + 14} textAnchor="middle" style={zoneStyle}>crowded — unwind risk</text>
            <text x={left + (px - left) / 2} y={py + 16} textAnchor="middle" style={zoneStyle}>toe-dipping</text>
            <text x={left + rect.width / 2} y={bottom - 6} textAnchor="middle" style={zoneStyle}>below median conviction</text>
          </g>
        );
      })()}

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

      {/* BACKGROUND layer — context only, never intercepts hover/click. Matched
          names are pulled out and re-drawn in the promoted layer below. */}
      <g style={{ pointerEvents: "none" }}>
        {bgPos.map(({ p, x, y }) =>
          matchSet?.has(p.ticker) ? null : (
            <circle
              key={p.ticker}
              cx={x}
              cy={y}
              r={p.r}
              fill={p.fill}
              fillOpacity={searching ? cfg.search.dimOpacity : cfg.colors.backgroundOpacity}
            />
          ),
        )}
      </g>

      {/* TRAILS — QoQ movement from last quarter's position to this one. */}
      <g style={{ pointerEvents: "none" }}>
        {trailPositions.map(({ p, x, y }) => {
          const px = scales.x(p.prev!.breadth);
          const py = scales.y(p.prev!.conviction);
          const color = flowColor(p.deltaHolders);
          return (
            <g key={`trail-${p.ticker}`}>
              <line x1={px} y1={py} x2={x} y2={y} stroke={color} strokeWidth={cfg.trails.strokeWidth} strokeOpacity={0.75} />
              <circle cx={px} cy={py} r={cfg.trails.hollowRadius} fill="none" stroke={color} strokeWidth={1.5} strokeOpacity={0.9} />
            </g>
          );
        })}
      </g>

      {/* FOREGROUND layer */}
      <g>
        {fgPos.map(({ p, x, y }) => {
          const matched = matchSet?.has(p.ticker) ?? false;
          const op = !searching ? 0.75 : matched ? 1 : cfg.search.dimOpacity;
          const outlined = hovered === p.ticker || matched;
          return (
            <circle
              key={p.ticker}
              cx={x}
              cy={y}
              r={p.r}
              fill={p.fill}
              fillOpacity={op}
              stroke={outlined ? "var(--text-primary)" : "none"}
              strokeWidth={outlined ? 1 : 0}
            />
          );
        })}
      </g>

      {/* PROMOTED layer — matched background names rendered at full fidelity. */}
      <g style={{ pointerEvents: "none" }}>
        {promotedBg.map(({ p, x, y }) => (
          <circle
            key={p.ticker}
            cx={x}
            cy={y}
            r={flowRadius(p.deltaHolders)}
            fill={flowColor(p.deltaHolders)}
            fillOpacity={1}
            stroke="var(--text-primary)"
            strokeWidth={1}
          />
        ))}
      </g>

      {/* Selective labels (deterministic placement) */}
      <g style={{ pointerEvents: "none" }}>
        {labels.map((l) => {
          const badge = badges.get(l.id);
          return (
            <text
              key={l.id}
              x={l.x}
              y={l.y}
              textAnchor={l.anchor}
              style={labelTextStyle}
              opacity={searching && !matchSet!.has(l.id) ? cfg.search.dimOpacity : 1}
            >
              {l.id}
              {badge && <tspan fill="var(--color-accent)"> {badge}</tspan>}
            </text>
          );
        })}
        {/* Pinned labels for matches that aren't already in the placed set. */}
        {searching &&
          [...fgPos, ...promotedBg]
            .filter((pos) => matchSet!.has(pos.p.ticker) && !labeledIds.has(pos.p.ticker))
            .map(({ p, x, y }) => (
              <text key={`m${p.ticker}`} x={x + flowRadius(p.deltaHolders) + 4} y={y + 3} textAnchor="start" style={hoverLabelStyle}>
                {p.ticker}
              </text>
            ))}
        {/* Hover label for an unlabeled foreground mark (suppressed while searching). */}
        {!searching && hoverLabel && (
          <text x={hoverLabel.x} y={hoverLabel.y} textAnchor={hoverLabel.anchor} style={hoverLabelStyle}>
            {hoverLabel.text}
          </text>
        )}
      </g>
    </svg>
  );
}
