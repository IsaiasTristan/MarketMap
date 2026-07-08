"use client";
/**
 * Hand-rolled SVG scatter for the crowding × conviction view. Layers, bottom-up:
 * grid/axes → reference lines → BACKGROUND dots (context, never hit-tested) →
 * FOREGROUND marks (tooltips, click-through). Hit-testing is a nearest-point
 * scan over the foreground array only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { breadthJitter, flowColor, flowRadius, makeScalesForDomain, ticksInDomain, type PlottedPoint, type QuadrantModel } from "./quadrantModel";
import { QUADRANT_CONFIG } from "./quadrantConfig";
import { placeLabels, placeOptsFromConfig, type LabelInput } from "./labelPlacement";
import { isBelowRange } from "./gutter";
import { buildSpatialIndex, type IndexedPoint, type QueryRect } from "./spatialIndex";
import { classifyGesture, dragDistance, normalizeRect, type Gesture } from "./gesture";
import { lerpLogDomain, panLogDomain, zoomAxis, type ZoomFrame } from "./zoomState";
import { computeDensity, pointsInView, selectPromoted, selectLabelCandidates, type ViewPoint } from "./densityPromotion";
import { classifyZone, type Zone } from "./zones";

export interface HoverState {
  point: PlottedPoint;
  /** Pixel position of the mark inside the chart container. */
  x: number;
  y: number;
  /** Alt-hover of a context (background) mark → the panel renders a minimal tooltip. */
  minimal?: boolean;
}

const MARGIN = { top: 14, right: 20, bottom: 38, left: 50 };

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
  promoted,
  viewDomain,
  watchlist,
  zoneFilter,
  watchlistIsolate,
  highlight,
  onHover,
  onPinnedChange,
  onClickTicker,
  onSelectRegion,
  onWheelZoom,
  onPan,
  onResetZoom,
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
  /** Tickers the user pinned from the region inspector — full-opacity + label. */
  promoted: Set<string>;
  /** Active zoom domain (top of the panel's zoom stack); null = full view. */
  viewDomain: ZoomFrame | null;
  /** Tickers on the user's watchlist (active portfolio holdings) — hollow ring. */
  watchlist: Set<string>;
  /** Census zone filter: when set, foreground names outside the zone dim. */
  zoneFilter: Zone | null;
  /** When true, isolate the watchlist names (mutually exclusive with zoneFilter). */
  watchlistIsolate: boolean;
  /** A name to emphasize (from a danger-vector / census row click). */
  highlight: string | null;
  onHover: (h: HoverState | null) => void;
  /** Reports the single searched match (with position) for a persistent tooltip. */
  onPinnedChange: (h: HoverState | null) => void;
  onClickTicker: (ticker: string) => void;
  /** A completed box-select (right-drag) reports the tickers whose centers fell inside. */
  onSelectRegion: (tickers: string[]) => void;
  /** A wheel tick reports the new zoom frame, or null when zoomed fully out. */
  onWheelZoom: (frame: ZoomFrame | null) => void;
  /** A pan (left-drag) reports the shifted frame to replace the current view. */
  onPan: (frame: ZoomFrame) => void;
  /** Double-click on empty canvas / Esc resets the zoom. */
  onResetZoom: () => void;
}) {
  const [hovered, setHovered] = useState<string | null>(null);
  // While Alt/Option is held, context (background) marks become hit-testable
  // (Part 1a). Tracked at the window level so the mode survives focus in the SVG.
  const [altHeld, setAltHeld] = useState(false);

  // Native wheel listener target (React onWheel can't reliably preventDefault).
  const svgRef = useRef<SVGSVGElement | null>(null);
  // Wheel zoom (like pan) must be instant, not animated — this flag tells the
  // animation effect to jump straight to the new frame.
  const wheelInstantRef = useRef(false);

  // A single mousedown-classified gesture drives hover / click / left-drag pan /
  // right-drag box-select so the modes don't fight over one drag. `panning`
  // drives the grab cursor.
  const dragRef = useRef<{ x: number; y: number; kind: Gesture; moved: boolean; lastX: number; lastY: number } | null>(null);
  const [panning, setPanning] = useState(false);
  const [selRect, setSelRect] = useState<QueryRect | null>(null);

  // ── Semantic zoom (Part 3) ──────────────────────────────────────────────────
  // The effective domain overrides what makeScalesForDomain sees; the model is
  // never mutated. animFrame is the in-flight tween; when null we sit on target.
  const baseFrame = useMemo<ZoomFrame>(() => ({ xDomain: model.xDomain, yDomain: model.yDomain }), [model.xDomain, model.yDomain]);
  const targetFrame = viewDomain ?? baseFrame;
  const [animFrame, setAnimFrame] = useState<ZoomFrame | null>(null);
  const [animating, setAnimating] = useState(false);
  const effectiveFrame = animFrame ?? targetFrame;
  const effectiveRef = useRef(effectiveFrame);
  effectiveRef.current = effectiveFrame;

  // Animate (rAF, log-space) whenever the target domain changes. Degrade to an
  // instant jump if the frames are already equal; hover is disabled mid-tween.
  const targetKey = `${targetFrame.xDomain[0]},${targetFrame.xDomain[1]},${targetFrame.yDomain[0]},${targetFrame.yDomain[1]}`;
  useEffect(() => {
    const from = effectiveRef.current;
    const to = targetFrame;
    const close = (a: number, b: number) => Math.abs(Math.log(a) - Math.log(b)) < 1e-6;
    // Pan and wheel-zoom update the domain continuously — jump instantly, never
    // animate, so they track the cursor. Equal frames also short-circuit.
    const isPanning = dragRef.current?.kind === "pan";
    const isWheeling = wheelInstantRef.current;
    wheelInstantRef.current = false;
    if (isPanning || isWheeling || (close(from.xDomain[0], to.xDomain[0]) && close(from.xDomain[1], to.xDomain[1]) && close(from.yDomain[0], to.yDomain[0]) && close(from.yDomain[1], to.yDomain[1]))) {
      setAnimFrame(null);
      setAnimating(false);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const dur = QUADRANT_CONFIG.zoom.animMs;
    setAnimating(true);
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      setAnimFrame({ xDomain: lerpLogDomain(from.xDomain, to.xDomain, t), yDomain: lerpLogDomain(from.yDomain, to.yDomain, t) });
      if (t < 1) raf = requestAnimationFrame(tick);
      else {
        setAnimFrame(null);
        setAnimating(false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  const [ex0, ex1] = effectiveFrame.xDomain;
  const [ey0, ey1] = effectiveFrame.yDomain;

  // A gutter strip sits between the plot floor and the axis labels; below-range
  // names (conviction < floor, or null) render there instead of clamping onto
  // the axis-floor pixel row. The plot area shrinks by the strip height so every
  // existing layer (which reads `rect`) is unaffected.
  const gutterH = QUADRANT_CONFIG.gutter.height;
  const gutterFloorPct = QUADRANT_CONFIG.gutter.floorBps / 100;
  const rect = {
    left: MARGIN.left,
    top: MARGIN.top,
    width: Math.max(10, width - MARGIN.left - MARGIN.right),
    height: Math.max(10, height - MARGIN.top - MARGIN.bottom - gutterH),
  };
  const gutterTop = rect.top + rect.height;
  const gutterCenterY = gutterTop + gutterH / 2;

  // Positions use the EFFECTIVE (possibly zoomed/animating) domain. The gutter
  // partition is unchanged. Marks outside the zoom domain clamp to the plot edge
  // (same as the base view), which is acceptable during the tween.
  const { scales, bgPos, fgPos, gutterPos } = useMemo(() => {
    const s = makeScalesForDomain([ex0, ex1], [ey0, ey1], rect);
    const place = (p: PlottedPoint): Positioned => ({ p, x: s.x(p.breadth + breadthJitter(p.ticker, p.fundsHolding)), y: s.y(p.conviction) });
    const inGutter = (p: PlottedPoint) => isBelowRange(p.conviction, gutterFloorPct);
    const fgAll = model.foreground.map(place);
    const bgAll = model.background.map(place);
    const fg = fgAll.filter((pos) => !inGutter(pos.p));
    const bg = bgAll.filter((pos) => !inGutter(pos.p));
    const gutter = [...fgAll, ...bgAll].filter((pos) => inGutter(pos.p)).map((pos) => ({ ...pos, y: gutterCenterY }));
    return { scales: s, bgPos: bg, fgPos: fg, gutterPos: gutter };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model, rect.left, rect.top, rect.width, rect.height, ex0, ex1, ey0, ey1, gutterCenterY, gutterFloorPct]);

  // Density-driven promotion (Part 3b) — computed off the SETTLED target domain
  // (stable per zoom level), only after a zoom. Below the density threshold, the
  // in-view context marks self-promote to foreground render-state.
  const promotedByDensity = useMemo(() => {
    if (!viewDomain) return new Set<string>();
    const bgIn = pointsInView(model.background, targetFrame.xDomain, targetFrame.yDomain);
    const fgIn = pointsInView(model.foreground, targetFrame.xDomain, targetFrame.yDomain);
    const density = computeDensity(bgIn.length + fgIn.length, rect.width * rect.height);
    const bgVP: ViewPoint[] = bgIn.map((p) => ({ ticker: p.ticker, x: 0, y: 0, r: 0, score: 0, conviction: p.conviction ?? 0, danger: false }));
    return selectPromoted(bgVP, density, QUADRANT_CONFIG.density.promoteDensity);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewDomain, targetKey, model, rect.width, rect.height]);

  // Ticks re-filter to the effective domain so gridlines/labels stay meaningful
  // when zoomed.
  const xTicks = useMemo(() => ticksInDomain(QUADRANT_CONFIG.axes.x.ticks, ex0, ex1), [ex0, ex1]);
  const yTicks = useMemo(() => ticksInDomain(QUADRANT_CONFIG.axes.y.ticks, ey0, ey1), [ey0, ey1]);

  const badgeOf = (p: PlottedPoint) => (Math.abs(p.holderStreak) >= QUADRANT_CONFIG.streak.badgeMin ? `×${Math.abs(p.holderStreak)}` : "");

  // Isolation (Part 4a / Part 5 / Part 6 / Part 7): the names to spotlight —
  // either an active census zone OR the watchlist. Spotlit names go
  // full-opacity + labeled + trailed + hoverable and everything else dims and
  // goes inert. An EMPTY set collapses to null (no isolation) so isolating an
  // empty zone/watchlist can never blank the chart.
  //
  // Zone isolation is foreground-only (zones are a foreground concept). WATCHLIST
  // isolation spans ALL layers (fg ∪ bg ∪ gutter) — holdings are mostly context
  // marks, so a foreground-only set would be empty and no-op.
  const isolatedSet = useMemo(() => {
    let members: Set<string> | null = null;
    if (watchlistIsolate) {
      members = new Set<string>();
      for (const pos of [...fgPos, ...bgPos, ...gutterPos]) if (watchlist.has(pos.p.ticker)) members.add(pos.p.ticker);
    } else if (zoneFilter) {
      members = new Set<string>();
      for (const pos of fgPos) if (classifyZone(pos.p.breadth, pos.p.conviction, model.p75Breadth, model.p75Conviction) === zoneFilter) members.add(pos.p.ticker);
    }
    return members && members.size > 0 ? members : null;
  }, [watchlistIsolate, zoneFilter, watchlist, fgPos, bgPos, gutterPos, model.p75Breadth, model.p75Conviction]);

  // Labels. When a census zone is isolated, label EVERY name in that zone (top
  // priority). Otherwise: default view keeps the historical top-maxByScore +
  // danger set; under zoom, the budgeted tiered selection (foreground > density-
  // promoted). Reuses placeLabels via the priority field; hidden mid-tween.
  const { labels, badges } = useMemo(() => {
    const badgeSources = viewDomain ? [...fgPos, ...bgPos.filter((pos) => promotedByDensity.has(pos.p.ticker))] : fgPos;
    const badges = new Map(badgeSources.map((pos) => [pos.p.ticker, badgeOf(pos.p)] as const).filter(([, b]) => b));
    if (animating) return { labels: [], badges };

    const bounds = { x0: rect.left, y0: rect.top, x1: rect.left + rect.width, y1: rect.top + rect.height };
    let inputs: LabelInput[];
    if (isolatedSet) {
      // Isolated subset: label the whole set across all layers (collision-placed,
      // capped). Watchlist names in bg/gutter are labeled here too.
      inputs = [...fgPos, ...bgPos, ...gutterPos]
        .filter((pos) => isolatedSet.has(pos.p.ticker))
        .slice(0, QUADRANT_CONFIG.density.maxLabels)
        .map((pos) => {
          const badge = badgeOf(pos.p);
          return { id: pos.p.ticker, x: pos.x, y: pos.y, r: Math.max(pos.p.r, QUADRANT_CONFIG.radius.base), text: badge ? `${pos.p.ticker} ${badge}` : pos.p.ticker, score: pos.p.score, forced: true, priority: 3 };
        });
    } else if (viewDomain) {
      const toVP = (pos: Positioned): ViewPoint => ({ ticker: pos.p.ticker, x: pos.x, y: pos.y, r: pos.p.r, score: pos.p.score, conviction: pos.p.conviction ?? 0, danger: pos.p.danger });
      const fgVP = fgPos.map(toVP);
      const promVP = bgPos.filter((pos) => promotedByDensity.has(pos.p.ticker)).map((pos) => ({ ...toVP(pos), r: flowRadius(pos.p.deltaHolders) }));
      inputs = selectLabelCandidates({ foreground: fgVP, promoted: promVP, pinnedTickers: promoted, maxLabels: QUADRANT_CONFIG.density.maxLabels, badgeOf: (t) => badges.get(t) ?? "" });
    } else {
      const cfg = QUADRANT_CONFIG.labels;
      const byScore = [...fgPos].sort((a, b) => b.p.score - a.p.score);
      const chosen = new Map<string, Positioned>();
      for (const pos of byScore.slice(0, cfg.maxByScore)) chosen.set(pos.p.ticker, pos);
      for (const pos of fgPos) if (pos.p.danger) chosen.set(pos.p.ticker, pos);
      inputs = [...chosen.values()].map((pos) => {
        const badge = badgeOf(pos.p);
        return { id: pos.p.ticker, x: pos.x, y: pos.y, r: pos.p.r, text: badge ? `${pos.p.ticker} ${badge}` : pos.p.ticker, score: pos.p.score, forced: pos.p.danger };
      });
    }
    const placed = placeLabels(inputs, bounds, placeOptsFromConfig(QUADRANT_CONFIG));
    return { labels: placed, badges };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fgPos, bgPos, gutterPos, viewDomain, promotedByDensity, promoted, animating, isolatedSet, rect.left, rect.top, rect.width, rect.height]);

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
    for (const pos of gutterPos) if (hit(pos.p)) set.add(pos.p.ticker);
    return set;
  }, [search, fgPos, bgPos, gutterPos]);
  const searching = matchSet !== null;

  // Matched background names are promoted to full foreground rendering.
  const promotedBg = useMemo(
    () => (matchSet ? bgPos.filter((pos) => matchSet.has(pos.p.ticker)) : []),
    [matchSet, bgPos],
  );

  // One spatial index over every positioned mark (foreground + background +
  // gutter), reused for hover (Part 1), box-select (Part 2) and density (Part 3).
  // Eligibility per mode is applied in the `accept` callback, not by rebuilding.
  const { index, posByTicker } = useMemo(() => {
    const pts: IndexedPoint[] = [];
    const map = new Map<string, Positioned>();
    for (const pos of [...fgPos, ...bgPos, ...gutterPos]) {
      pts.push({ ticker: pos.p.ticker, x: pos.x, y: pos.y, r: pos.p.r });
      map.set(pos.p.ticker, pos);
    }
    return { index: buildSpatialIndex(pts, QUADRANT_CONFIG.spatial.cellSize), posByTicker: map };
  }, [fgPos, bgPos, gutterPos]);
  const fgSet = useMemo(() => new Set(fgPos.map((p) => p.p.ticker)), [fgPos]);
  const bgSet = useMemo(() => new Set(bgPos.map((p) => p.p.ticker)), [bgPos]);

  // Track Alt/Option (context hover) at the window level; a window blur
  // (e.g. alt-tab) always releases so the mode can't get stuck on.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(true); };
    const up = (e: KeyboardEvent) => { if (e.key === "Alt") setAltHeld(false); };
    const blur = () => setAltHeld(false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  // Native non-passive wheel listener → zoom toward the cursor (instant). React's
  // onWheel is passive and can't preventDefault the page scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const b = el.getBoundingClientRect();
      const mx = e.clientX - b.left;
      const my = e.clientY - b.top;
      const step = QUADRANT_CONFIG.wheel.zoomStep;
      const factor = e.deltaY < 0 ? 1 / step : step;
      const cx = scales.invertX(mx);
      const cy = scales.invertY(my);
      const nx = zoomAxis(effectiveFrame.xDomain, cx, factor, baseFrame.xDomain);
      const ny = zoomAxis(effectiveFrame.yDomain, cy, factor, baseFrame.yDomain);
      const atBase = nx[0] === baseFrame.xDomain[0] && nx[1] === baseFrame.xDomain[1] && ny[0] === baseFrame.yDomain[0] && ny[1] === baseFrame.yDomain[1];
      wheelInstantRef.current = true;
      onWheelZoom(atBase ? null : { xDomain: nx, yDomain: ny });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scales, effectiveFrame, baseFrame, onWheelZoom]);

  // Releasing Alt clears a context-mark hover (foreground/search hovers persist).
  useEffect(() => {
    if (!altHeld && !searching && hovered && !fgSet.has(hovered)) {
      setHovered(null);
      onHover(null);
    }
  }, [altHeld, searching, hovered, fgSet, onHover]);

  // A lone match gets a persistent tooltip; report it (with position) to the panel.
  useEffect(() => {
    if (matchSet && matchSet.size === 1) {
      const t = [...matchSet][0];
      const pos = fgPos.find((f) => f.p.ticker === t) ?? bgPos.find((b) => b.p.ticker === t) ?? gutterPos.find((g) => g.p.ticker === t);
      onPinnedChange(pos ? { point: pos.p, x: pos.x, y: pos.y } : null);
    } else {
      onPinnedChange(null);
    }
  }, [matchSet, fgPos, bgPos, gutterPos, onPinnedChange]);

  // Foreground marks are always hoverable (unchanged threshold, so behavior is
  // byte-identical to the old linear scan); while searching, promoted background
  // matches are hoverable too; while Alt is held, ALL background marks are.
  // Gutter marks are never hovered (they are box-select targets, Part 2).
  function hitTest(evt: React.MouseEvent<SVGSVGElement>): Positioned | null {
    const bounds = evt.currentTarget.getBoundingClientRect();
    const mx = evt.clientX - bounds.left;
    const my = evt.clientY - bounds.top;
    const sp = QUADRANT_CONFIG.spatial;
    const altR = QUADRANT_CONFIG.altHover.radiusPx;
    const searchRadius = Math.max(QUADRANT_CONFIG.radius.max + sp.hitSlop, sp.minHitRadius, altR);
    const accept = (p: IndexedPoint, d: number): boolean => {
      // Isolation: only the spotlit set responds; the rest go inert. Spotlit marks
      // are hoverable on ANY layer (watchlist isolation includes bg/gutter names).
      if (isolatedSet) return isolatedSet.has(p.ticker) && d <= Math.max(p.r + sp.hitSlop, sp.minHitRadius);
      if (fgSet.has(p.ticker)) return d <= Math.max(p.r + sp.hitSlop, sp.minHitRadius);
      // Density-promoted context marks (under zoom) hover like foreground.
      if (promotedByDensity.has(p.ticker)) return d <= Math.max(p.r + sp.hitSlop, sp.minHitRadius);
      if (searching) return (matchSet?.has(p.ticker) ?? false) && d <= Math.max(p.r + sp.hitSlop, sp.minHitRadius);
      if (altHeld && bgSet.has(p.ticker)) return d <= altR;
      return false;
    };
    const hit = index.nearest(mx, my, searchRadius, accept);
    if (hit) return posByTicker.get(hit.ticker) ?? null;
    // Fall back to the visible ticker labels: their text sits offset from the
    // dot (beyond the dot's hover disc), so hovering the label alone would
    // otherwise find nothing. Treat each placed label's rect as a hit target for
    // the same names that are hover-eligible as dots.
    const eligible = (t: string): boolean =>
      isolatedSet
        ? isolatedSet.has(t)
        : fgSet.has(t) ||
          promotedByDensity.has(t) ||
          (searching && (matchSet?.has(t) ?? false)) ||
          (altHeld && bgSet.has(t));
    for (const l of labels) {
      const r = l.rect;
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h && eligible(l.id)) {
        return posByTicker.get(l.id) ?? null;
      }
    }
    return null;
  }

  function localXY(evt: React.MouseEvent<SVGSVGElement>): { x: number; y: number } {
    const b = evt.currentTarget.getBoundingClientRect();
    return { x: evt.clientX - b.left, y: evt.clientY - b.top };
  }

  function handleDown(evt: React.MouseEvent<SVGSVGElement>) {
    // Left button (0) → pan; right button (2) → box-select. Ignore the middle button.
    if (evt.button !== 0 && evt.button !== 2) return;
    const pt = localXY(evt);
    const onMark = hitTest(evt) !== null;
    const kind = classifyGesture({ rightButton: evt.button === 2, onMark });
    dragRef.current = { x: pt.x, y: pt.y, kind, moved: false, lastX: pt.x, lastY: pt.y };
  }

  function handleMove(evt: React.MouseEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    if (drag) {
      const pt = localXY(evt);
      if (!drag.moved && dragDistance(drag, pt) > QUADRANT_CONFIG.density.dragThresholdPx) drag.moved = true;
      if (drag.kind === "pan") {
        if (drag.moved && !panning) setPanning(true);
        // Grab-scroll: dragging right/down shifts the view the opposite way in
        // data space. Y is inverted (pixel down = lower conviction). At the base
        // domain panLogDomain clamps to a no-op, so panning only bites when zoomed.
        const dx = pt.x - drag.lastX;
        const dy = pt.y - drag.lastY;
        drag.lastX = pt.x;
        drag.lastY = pt.y;
        onPan({
          xDomain: panLogDomain(effectiveFrame.xDomain, -dx, rect.width, baseFrame.xDomain),
          yDomain: panLogDomain(effectiveFrame.yDomain, dy, rect.height, baseFrame.yDomain),
        });
      } else if (drag.kind === "select" && drag.moved) {
        setSelRect(normalizeRect(drag, pt));
      }
      return; // suppress hover while a gesture is active
    }
    if (animating) {
      if (hovered !== null) { setHovered(null); onHover(null); }
      return; // no hit-testing a moving target
    }
    const hit = hitTest(evt);
    if (hit) {
      if (hit.p.ticker !== hovered) setHovered(hit.p.ticker);
      // Context (background) marks picked up via Alt get the minimal tooltip —
      // but a spotlit (isolated) mark always gets the full tooltip.
      const minimal = altHeld && !searching && !isolatedSet?.has(hit.p.ticker) && !promotedByDensity.has(hit.p.ticker) && bgSet.has(hit.p.ticker);
      onHover({ point: hit.p, x: hit.x, y: hit.y, minimal });
    } else if (hovered !== null) {
      setHovered(null);
      onHover(null);
    }
  }

  function handleUp(evt: React.MouseEvent<SVGSVGElement>) {
    const drag = dragRef.current;
    dragRef.current = null;
    if (panning) setPanning(false);
    if (!drag) return;
    if (!drag.moved) {
      // A left click that didn't drag opens the ledger (right click does nothing).
      if (drag.kind === "pan") {
        const hit = hitTest(evt);
        if (hit) onClickTicker(hit.p.ticker);
      }
      setSelRect(null);
      return;
    }
    if (drag.kind === "select") {
      onSelectRegion(index.within(normalizeRect(drag, localXY(evt))).map((p) => p.ticker));
    }
    setSelRect(null);
  }

  function handleDoubleClick(evt: React.MouseEvent<SVGSVGElement>) {
    // Double-click on empty canvas resets the zoom (a mark keeps its click).
    if (hitTest(evt) === null) onResetZoom();
  }

  function handleLeave() {
    dragRef.current = null;
    setSelRect(null);
    if (panning) setPanning(false);
    if (hovered !== null) setHovered(null);
    onHover(null);
  }

  const tickStyle: CSSProperties = { fontSize: 10, fill: "var(--color-accent)" };
  const labelStyle: CSSProperties = { fontSize: 10, fill: "var(--color-accent)" };
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
    if (showTrails) {
      // When isolating, trail exactly the spotlit subset — foreground + background
      // (skip gutter: its plotted y is the synthetic strip row, not a real value).
      if (isolatedSet) for (const pos of [...fgPos, ...bgPos]) { if (isolatedSet.has(pos.p.ticker)) add(pos); }
      else for (const pos of fgPos) if (labeledIds.has(pos.p.ticker)) add(pos);
    }
    // Any hovered mark (foreground, search-promoted, density-promoted, alt-bg) trails.
    if (hovered) add(posByTicker.get(hovered));
    return out;
  }, [fgPos, bgPos, posByTicker, showTrails, labeledIds, hovered, isolatedSet]);

  const cursor = hovered ? "pointer" : panning ? "grabbing" : altHeld ? "crosshair" : viewDomain ? "grab" : "default";
  return (
    <svg
      ref={svgRef}
      width={width}
      height={height}
      style={{ display: "block", cursor }}
      onMouseDown={handleDown}
      onMouseMove={handleMove}
      onMouseUp={handleUp}
      onMouseLeave={handleLeave}
      onDoubleClick={handleDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
    >
      {/* Grid — ticks re-filtered to the effective (possibly zoomed) domain. */}
      {xTicks.map((t) => (
        <line key={`gx${t}`} x1={scales.x(t)} x2={scales.x(t)} y1={rect.top} y2={rect.top + rect.height} stroke="var(--bg-border)" strokeDasharray="2 4" />
      ))}
      {yTicks.map((t) => (
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

      {/* Axis tick labels — x labels sit BELOW the gutter strip so they clear it. */}
      {xTicks.map((t) => (
        <text key={`tx${t}`} x={scales.x(t)} y={gutterTop + gutterH + 14} textAnchor="middle" style={tickStyle}>
          {t}%
        </text>
      ))}
      {yTicks.map((t) => (
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

      {/* GUTTER band — below-range names (conviction < floor, or null). Extra-muted,
          never labeled or trailed; a hairline separates it from the real axis floor.
          x still comes from the breadth scale so the column structure is preserved. */}
      {gutterPos.length > 0 && (
        <g style={{ pointerEvents: "none" }}>
          <line x1={rect.left} x2={rect.left + rect.width} y1={gutterTop} y2={gutterTop} stroke="var(--bg-border)" strokeOpacity={0.9} />
          <text x={rect.left + rect.width} y={gutterCenterY + 3} textAnchor="end" style={{ fontSize: 9, fill: "var(--text-muted)", opacity: 0.7, fontStyle: "italic" }}>
            {QUADRANT_CONFIG.gutter.caption}
          </text>
          {gutterPos.map(({ p, x, y }) => {
            if (isolatedSet?.has(p.ticker)) return null; // spotlit below
            const matched = matchSet?.has(p.ticker) ?? false;
            return (
              <circle
                key={p.ticker}
                cx={x}
                cy={y}
                r={cfg.colors.backgroundRadius}
                fill={cfg.colors.background}
                fillOpacity={searching ? (matched ? 0.9 : cfg.search.dimOpacity) : isolatedSet ? cfg.gutter.opacity * 0.4 : cfg.gutter.opacity}
                stroke={matched ? "var(--text-primary)" : "none"}
                strokeWidth={matched ? 1 : 0}
              />
            );
          })}
        </g>
      )}

      {/* BACKGROUND layer — context only, never intercepts hover/click. Matched
          (search) and density-promoted names are pulled out and re-drawn below. */}
      <g style={{ pointerEvents: "none" }}>
        {bgPos.map(({ p, x, y }) =>
          matchSet?.has(p.ticker) || promotedByDensity.has(p.ticker) || isolatedSet?.has(p.ticker) ? null : (
            <circle
              key={p.ticker}
              cx={x}
              cy={y}
              r={p.r}
              fill={p.fill}
              fillOpacity={searching ? cfg.search.dimOpacity : isolatedSet ? cfg.colors.backgroundOpacity * 0.35 : altHeld ? cfg.colors.backgroundOpacity * 1.8 : cfg.colors.backgroundOpacity}
            />
          ),
        )}
      </g>

      {/* DENSITY-PROMOTED — context marks that self-promoted under a sparse zoom.
          Rendered at foreground fidelity (flow color + size); labels/hover handled
          like foreground. Render-state only — demoted again on zoom-out. */}
      {promotedByDensity.size > 0 && (
        <g style={{ pointerEvents: "none" }}>
          {bgPos.map(({ p, x, y }) =>
            promotedByDensity.has(p.ticker) && !(matchSet?.has(p.ticker)) ? (
              <circle
                key={`dp-${p.ticker}`}
                cx={x}
                cy={y}
                r={flowRadius(p.deltaHolders)}
                fill={flowColor(p.deltaHolders)}
                fillOpacity={hovered === p.ticker ? 1 : 0.85}
                stroke={hovered === p.ticker ? "var(--text-primary)" : "none"}
                strokeWidth={hovered === p.ticker ? 1 : 0}
              />
            ) : null,
          )}
        </g>
      )}

      {/* TRAILS — QoQ movement from last quarter's position to this one. */}
      <g style={{ pointerEvents: "none" }}>
        {trailPositions.map(({ p, x, y }) => {
          // Same jitter offset as the current mark so the trail shifts as a unit.
          const px = scales.x(p.prev!.breadth + breadthJitter(p.ticker, p.fundsHolding));
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
          let op = !searching ? 0.75 : matched ? 1 : cfg.search.dimOpacity;
          // Zone isolation: the isolated zone pops to full opacity; the rest fade.
          if (isolatedSet) op = isolatedSet.has(p.ticker) ? 1 : 0.12;
          const outlined = hovered === p.ticker || matched || (isolatedSet?.has(p.ticker) ?? false);
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

      {/* SPOTLIT — isolation promotes background/gutter members (e.g. watchlist
          holdings that are context marks) to foreground fidelity: flow color +
          size + outline, so they read like signal names. Foreground members
          already pop in the layer above. */}
      {isolatedSet && (
        <g style={{ pointerEvents: "none" }}>
          {[...isolatedSet].map((t) => {
            if (fgSet.has(t)) return null;
            const pos = posByTicker.get(t);
            if (!pos) return null;
            const r = Math.max(flowRadius(pos.p.deltaHolders), cfg.radius.base);
            return (
              <circle
                key={`sp-${t}`}
                cx={pos.x}
                cy={pos.y}
                r={r}
                fill={flowColor(pos.p.deltaHolders)}
                fillOpacity={1}
                stroke={hovered === t ? "var(--text-primary)" : "var(--text-secondary)"}
                strokeWidth={hovered === t ? 1.5 : 0.75}
              />
            );
          })}
        </g>
      )}

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

      {/* USER-PROMOTED — names pinned from the region inspector: full-opacity
          outline + a persistent accent label (any layer, including the gutter). */}
      {promoted.size > 0 && (
        <g style={{ pointerEvents: "none" }}>
          {[...promoted].map((t) => {
            const pos = posByTicker.get(t);
            if (!pos) return null;
            const r = Math.max(pos.p.r, cfg.radius.base);
            return (
              <g key={`pin-${t}`}>
                <circle cx={pos.x} cy={pos.y} r={r} fill={pos.p.fill} fillOpacity={1} stroke="var(--color-accent)" strokeWidth={1.5} />
                <text x={pos.x + r + 4} y={pos.y + 3} textAnchor="start" style={{ fontSize: cfg.labels.fontSize, fill: "var(--color-accent)", fontWeight: 700 }}>
                  {t}
                </text>
              </g>
            );
          })}
        </g>
      )}

      {/* WATCHLIST RINGS (Part 4c) — hollow ring on portfolio-held names, any layer. */}
      {watchlist.size > 0 && (
        <g style={{ pointerEvents: "none" }}>
          {[...watchlist].map((t) => {
            const pos = posByTicker.get(t);
            if (!pos) return null;
            const r = Math.max(pos.p.r, cfg.colors.backgroundRadius) + 3;
            return <circle key={`wl-${t}`} cx={pos.x} cy={pos.y} r={r} fill="none" stroke={cfg.colors.watchlistRing} strokeWidth={1.25} strokeOpacity={0.9} />;
          })}
        </g>
      )}

      {/* FLAG GLYPHS (Part 4d) — data-quality flags from the shared leaderboard
          rows: verify (red ⚠) or partial-data (muted ◐). */}
      <g style={{ pointerEvents: "none" }}>
        {[...posByTicker.values()]
          .filter(({ p }) => p.verifyData || p.partialData)
          .map(({ p, x, y }) => (
            <text
              key={`flag-${p.ticker}`}
              x={x + p.r + 1}
              y={y - p.r}
              textAnchor="start"
              style={{ fontSize: 9, fill: p.verifyData ? "var(--color-neg, #e34948)" : "var(--text-muted)" }}
            >
              {p.verifyData ? "⚠" : "◐"}
            </text>
          ))}
      </g>

      {/* HIGHLIGHT — a name emphasized from a census / danger-vector row click. */}
      {highlight &&
        posByTicker.get(highlight) &&
        (() => {
          const pos = posByTicker.get(highlight)!;
          const r = Math.max(pos.p.r, cfg.radius.base) + 5;
          return <circle cx={pos.x} cy={pos.y} r={r} fill="none" stroke="var(--bb-highlight-text)" strokeWidth={2} strokeOpacity={0.95} />;
        })()}

      {/* Box-select rectangle (in progress). */}
      {selRect && (
        <rect
          x={selRect.x0}
          y={selRect.y0}
          width={selRect.x1 - selRect.x0}
          height={selRect.y1 - selRect.y0}
          fill="var(--color-accent)"
          fillOpacity={0.08}
          stroke="var(--color-accent)"
          strokeDasharray="3 3"
          style={{ pointerEvents: "none" }}
        />
      )}
    </svg>
  );
}
