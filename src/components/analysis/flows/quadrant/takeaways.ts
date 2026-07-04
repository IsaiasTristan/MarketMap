/**
 * Stated takeaways for the crowding × conviction scatter (Part 4) — the numbers
 * the tab asserts without the user hovering anything: a per-zone census, the
 * regime drift vector, and the two danger-vector lists. All pure — no React/DOM.
 * Computed over the FOREGROUND set (gutter/below-range names are excluded), plus
 * server-joined elite-exit data for the "elite leaving crowded" list.
 */
import type { PlottedPoint } from "./quadrantModel";
import { classifyZone, ZONE_ORDER, type Zone } from "./zones";

// ── Zone census ──────────────────────────────────────────────────────────────
export interface ZoneCensus {
  zone: Zone;
  count: number;
  /** count now − count of the same names last quarter (movement in/out of zone). */
  qoqDelta: number;
  /** Sum of Δholders for names currently in the zone. */
  netFlow: number;
}

/**
 * Census per zone over the foreground. qoqDelta re-classifies each name's prior
 * position (p.prev) against the SAME p75 boundaries, so it reads as net movement
 * into/out of the zone this quarter.
 */
export function zoneCensus(foreground: PlottedPoint[], p75Breadth: number, p75Conviction: number): ZoneCensus[] {
  const now = new Map<Zone, number>();
  const prev = new Map<Zone, number>();
  const flow = new Map<Zone, number>();
  for (const z of ZONE_ORDER) {
    now.set(z, 0);
    prev.set(z, 0);
    flow.set(z, 0);
  }
  for (const p of foreground) {
    const z = classifyZone(p.breadth, p.conviction, p75Breadth, p75Conviction);
    now.set(z, now.get(z)! + 1);
    flow.set(z, flow.get(z)! + p.deltaHolders);
    if (p.prev) {
      const pz = classifyZone(p.prev.breadth, p.prev.conviction, p75Breadth, p75Conviction);
      prev.set(pz, prev.get(pz)! + 1);
    }
  }
  return ZONE_ORDER.map((zone) => ({ zone, count: now.get(zone)!, qoqDelta: now.get(zone)! - prev.get(zone)!, netFlow: flow.get(zone)! }));
}

// ── Regime vector ────────────────────────────────────────────────────────────
export interface RegimeVector {
  /** Mean log-space breadth / conviction drift of the foreground. */
  dx: number;
  dy: number;
  magnitude: number;
  direction: "crowding" | "de-crowding" | "neutral";
}

export interface VectorConfig {
  topN: number;
  minTrailQuarters: number;
  breadthWeight: number;
  convictionWeight: number;
  neutralEps: number;
}

/** Names with a usable single-segment trail (prior + current, both positive). */
function trailable(p: PlottedPoint): p is PlottedPoint & { prev: { breadth: number; conviction: number } } {
  return !!p.prev && p.prev.conviction !== null && p.conviction !== null && p.prev.conviction > 0 && p.conviction > 0 && p.prev.breadth > 0 && p.breadth > 0;
}

/**
 * Mean trail vector of the foreground in normalized log-space. The regime is
 * "crowding" when the net drift heads toward the crowded corner (breadth and
 * conviction both rising, projected onto dx+dy), "de-crowding" for the reverse,
 * "neutral" inside the log-space dead-zone.
 */
export function regimeVector(foreground: PlottedPoint[], cfg: VectorConfig): RegimeVector {
  const vecs = foreground.filter(trailable).map((p) => ({
    dx: Math.log(p.breadth) - Math.log(p.prev.breadth),
    dy: Math.log(p.conviction!) - Math.log(p.prev.conviction),
  }));
  if (vecs.length === 0) return { dx: 0, dy: 0, magnitude: 0, direction: "neutral" };
  const dx = vecs.reduce((s, v) => s + v.dx, 0) / vecs.length;
  const dy = vecs.reduce((s, v) => s + v.dy, 0) / vecs.length;
  const proj = dx + dy;
  const direction = proj > cfg.neutralEps ? "crowding" : proj < -cfg.neutralEps ? "de-crowding" : "neutral";
  return { dx, dy, magnitude: Math.hypot(dx, dy), direction };
}

// ── Danger vectors ───────────────────────────────────────────────────────────
export interface DangerRow {
  ticker: string;
  companyName: string | null;
  /** Ranking value (velocity, or elite-trim intensity). */
  value: number;
  /** One-line human stat for the row. */
  stat: string;
}

/**
 * "Moving into crowding fastest": foreground names on a sustained run
 * (|holderStreak| ≥ minTrailQuarters) whose trail heads toward the crowded
 * corner, ranked by a weighted velocity of the positive breadth/conviction
 * components in log-space. Single-segment trails (prev→current) — see handoff.
 */
export function movingIntoCrowding(foreground: PlottedPoint[], cfg: VectorConfig): DangerRow[] {
  return foreground
    .filter(trailable)
    .filter((p) => Math.abs(p.holderStreak) >= cfg.minTrailQuarters)
    .map((p) => {
      const dB = Math.log(p.breadth) - Math.log(p.prev.breadth);
      const dC = Math.log(p.conviction!) - Math.log(p.prev.conviction);
      const velocity = Math.max(0, dB) * cfg.breadthWeight + Math.max(0, dC) * cfg.convictionWeight;
      return { ticker: p.ticker, companyName: p.companyName, value: velocity, dB, dC };
    })
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || (a.ticker < b.ticker ? -1 : 1))
    .slice(0, cfg.topN)
    .map((r) => ({ ticker: r.ticker, companyName: r.companyName, value: r.value, stat: `breadth +${(r.dB * 100).toFixed(0)}% · conviction ${r.dC >= 0 ? "+" : ""}${(r.dC * 100).toFixed(0)}% (log qoq)` }));
}

/** Per-ticker elite-exit summary, joined server-side from the exit-cluster detector. */
export interface ExitClusterLite {
  ticker: string;
  eliteExits: number;
  eliteSizing: number;
  convictionExits: number;
}

/**
 * "Elite leaving crowded names": crowded-zone foreground names ranked by elite
 * trim count × sizing of those trims. Names with no elite exits are dropped.
 */
export function eliteLeavingCrowded(foreground: PlottedPoint[], exits: ExitClusterLite[], p75Breadth: number, p75Conviction: number, topN: number): DangerRow[] {
  const crowded = new Map<string, PlottedPoint>();
  for (const p of foreground) {
    if (classifyZone(p.breadth, p.conviction, p75Breadth, p75Conviction) === "crowded") crowded.set(p.ticker, p);
  }
  return exits
    .filter((e) => crowded.has(e.ticker) && e.eliteExits > 0)
    .map((e) => ({
      ticker: e.ticker,
      companyName: crowded.get(e.ticker)!.companyName,
      value: e.eliteExits * Math.max(1, e.eliteSizing),
      stat: `${e.eliteExits} elite trim${e.eliteExits === 1 ? "" : "s"} · ${e.eliteSizing.toFixed(1)}% sizing`,
    }))
    .sort((a, b) => b.value - a.value || (a.ticker < b.ticker ? -1 : 1))
    .slice(0, topN);
}

// ── Watchlist census (Part 4c) ───────────────────────────────────────────────
export interface WatchlistCensus {
  /** Watchlist names currently in the crowded zone. */
  crowdedNow: number;
  /** Net change vs last quarter (names moved into/out of the crowded zone). */
  crowdedQoqDelta: number;
}

export function watchlistCensus(foreground: PlottedPoint[], watchlist: Set<string>, p75Breadth: number, p75Conviction: number): WatchlistCensus {
  let now = 0;
  let prev = 0;
  for (const p of foreground) {
    if (!watchlist.has(p.ticker)) continue;
    if (classifyZone(p.breadth, p.conviction, p75Breadth, p75Conviction) === "crowded") now += 1;
    if (p.prev && classifyZone(p.prev.breadth, p.prev.conviction, p75Breadth, p75Conviction) === "crowded") prev += 1;
  }
  return { crowdedNow: now, crowdedQoqDelta: now - prev };
}
