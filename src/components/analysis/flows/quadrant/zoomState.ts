/**
 * Semantic-zoom domain math for the crowding × conviction scatter (Part 3).
 *
 * Everything is data-space and log-aware (both axes are log). Zoom overrides the
 * DOMAIN fed to makeScalesForDomain; the model is never mutated. Pure — no
 * React/DOM.
 */
import type { QueryRect } from "./spatialIndex";

export type Domain = [number, number];
export interface ZoomFrame {
  xDomain: Domain;
  yDomain: Domain;
}

/** Inverse functions from a Scales object; kept minimal so tests can fake them. */
export interface ScaleInverse {
  invertX: (px: number) => number;
  invertY: (py: number) => number;
}

/** Interpolate domain endpoints in log space; t in [0,1]. */
export function lerpLogDomain(from: Domain, to: Domain, t: number): Domain {
  const l = (a: number, b: number) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);
  return [l(from[0], to[0]), l(from[1], to[1])];
}

function clampDomain(d: Domain, base: Domain): Domain {
  return [Math.max(d[0], base[0]), Math.min(d[1], base[1])];
}

/**
 * Invert a pixel brush rect to a data-space zoom frame, clamped to `base`.
 * Pixel-y is inverted relative to conviction (top of screen = higher
 * conviction), so the y-domain is [invert(bottom), invert(top)].
 */
export function brushToFrame(rectPx: QueryRect, scales: ScaleInverse, base: ZoomFrame): ZoomFrame {
  const px0 = Math.min(rectPx.x0, rectPx.x1);
  const px1 = Math.max(rectPx.x0, rectPx.x1);
  const pyTop = Math.min(rectPx.y0, rectPx.y1);
  const pyBot = Math.max(rectPx.y0, rectPx.y1);
  const x: Domain = [scales.invertX(px0), scales.invertX(px1)];
  const y: Domain = [scales.invertY(pyBot), scales.invertY(pyTop)];
  return { xDomain: clampDomain(x, base.xDomain), yDomain: clampDomain(y, base.yDomain) };
}

/**
 * Translate a log-space domain by a pixel delta and clamp to `base`, preserving
 * width (unless the domain is already wider than base). `pxExtent` is the axis
 * length in pixels; the caller passes a signed `pxDelta` matching the axis.
 */
export function panLogDomain(domain: Domain, pxDelta: number, pxExtent: number, base: Domain): Domain {
  const lw = Math.log(domain[1]) - Math.log(domain[0]);
  const shift = (pxDelta / (pxExtent || 1)) * lw;
  let l0 = Math.log(domain[0]) + shift;
  let l1 = Math.log(domain[1]) + shift;
  const bl0 = Math.log(base[0]);
  const bl1 = Math.log(base[1]);
  if (l0 < bl0) {
    const d = bl0 - l0;
    l0 += d;
    l1 += d;
  }
  if (l1 > bl1) {
    const d = l1 - bl1;
    l0 -= d;
    l1 -= d;
  }
  l0 = Math.max(l0, bl0);
  l1 = Math.min(l1, bl1);
  return [Math.exp(l0), Math.exp(l1)];
}

/**
 * Zoom one axis by `factor` (<1 zoom in, >1 zoom out) about `cursor`, keeping the
 * data value under the cursor at the same fractional screen position, in log
 * space. The result is clamped to `base` preserving the new width; if the new
 * width reaches/exceeds the base width, the full base domain is returned (fully
 * zoomed out). Used for mouse-wheel zoom.
 */
export function zoomAxis(domain: Domain, cursor: number, factor: number, base: Domain): Domain {
  const la = Math.log(domain[0]);
  const lb = Math.log(domain[1]);
  const bla = Math.log(base[0]);
  const blb = Math.log(base[1]);
  const lw = lb - la;
  const baseLw = blb - bla;
  const newLw = Math.min(lw * factor, baseLw);
  if (newLw >= baseLw) return [base[0], base[1]];
  const lc = Math.min(Math.max(Math.log(cursor), la), lb); // clamp cursor into domain
  const frac = lw > 0 ? (lc - la) / lw : 0.5;
  let nla = lc - frac * newLw;
  let nlb = nla + newLw;
  if (nla < bla) {
    const d = bla - nla;
    nla += d;
    nlb += d;
  }
  if (nlb > blb) {
    const d = nlb - blb;
    nla -= d;
    nlb -= d;
  }
  return [Math.exp(Math.max(nla, bla)), Math.exp(Math.min(nlb, blb))];
}

/**
 * Push a zoom frame honoring `maxDepth`: once the stack is full, further zooms
 * REPLACE the top level (keeping the earlier frames) rather than growing.
 */
export function pushFrame(stack: ZoomFrame[], frame: ZoomFrame, maxDepth: number): ZoomFrame[] {
  if (stack.length >= maxDepth) return [...stack.slice(0, Math.max(0, maxDepth - 1)), frame];
  return [...stack, frame];
}

/** Pop the top zoom frame (no-op on an empty stack). */
export function popFrame(stack: ZoomFrame[]): ZoomFrame[] {
  return stack.slice(0, -1);
}
