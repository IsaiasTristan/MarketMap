"use client";
/**
 * Screen 3 — the analyst price-target panel.
 *
 * The one view the per-analyst TipRanks history uniquely enables: each
 * analyst's target as a step line that holds until their next event, over the
 * daily close, with the earnings prints marked. This IS the matched panel the
 * rank is computed from (same `meshPtSources` dedup and supersession keys), so
 * a score can be read off the chart rather than trusted.
 *
 * Inline SVG: ~10 step paths over ~370 daily closes is cheaper drawn directly
 * than through a chart library, and the step semantics (hold, then jump) are
 * not a line-chart interpolation.
 */
import { useMemo, useState } from "react";
import type { AnalystSeries, AnalystStep } from "@/server/services/revision/revision-name.service";

const W = 920;
const H = 300;
const PAD = { top: 10, right: 128, bottom: 18, left: 44 };

/** Fixed ramp: the first six analysts by recency get an identity, the rest go gray. */
const RAMP = ["#e8a33d", "#5aa0ff", "#2f8f45", "#c65ad1", "#e05c5c", "#3fbfbf"];
const GRAY = "#6b6b70";

const ACTION_FILL: Record<AnalystStep["action"], string> = {
  raise: "var(--color-positive)",
  cut: "var(--color-negative)",
  init: "#5aa0ff",
  maintain: "transparent",
};

interface Hover {
  x: number;
  y: number;
  label: string;
  lines: string[];
}

export function AnalystTargetTimeline({
  analysts,
  price,
  earningsDates,
  nextEarnings,
  summary,
  staleDays,
}: {
  analysts: AnalystSeries[];
  price: Array<{ date: string; close: number }>;
  earningsDates: string[];
  nextEarnings: string | null;
  summary: string;
  staleDays: number;
}) {
  const [hover, setHover] = useState<Hover | null>(null);

  const geom = useMemo(() => {
    const dates = [
      ...price.map((p) => p.date),
      ...analysts.flatMap((a) => a.steps.map((s) => s.date)),
      ...(nextEarnings ? [nextEarnings] : []),
    ].sort();
    if (dates.length === 0) return null;
    const t0 = Date.parse(`${dates[0]}T00:00:00Z`);
    const t1 = Date.parse(`${dates[dates.length - 1]}T00:00:00Z`);
    const span = Math.max(1, t1 - t0);

    const values = [
      ...price.map((p) => p.close),
      ...analysts.flatMap((a) => a.steps.map((s) => s.target)),
    ].filter((v) => Number.isFinite(v));
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = (hi - lo) * 0.08 || Math.max(1, hi * 0.05);

    const x = (iso: string) =>
      PAD.left + ((Date.parse(`${iso}T00:00:00Z`) - t0) / span) * (W - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad))) * (H - PAD.top - PAD.bottom);

    // Only the identified analysts get a name tag — a deeply covered name has
    // 25+ lines and every label would be illegible. The rest draw in gray and
    // are counted in the footer.
    const order = analysts
      .slice(0, RAMP.length)
      .map((a, i) => ({ i, target: a.steps[a.steps.length - 1]?.target ?? null }))
      .filter((o): o is { i: number; target: number } => o.target !== null)
      .sort((a, b) => a.target - b.target);
    const labelY = new Map<number, number>();
    let floor = H - PAD.bottom;
    for (const o of order) {
      const wanted = Math.min(floor, y(o.target));
      labelY.set(o.i, wanted);
      floor = wanted - 9;
    }

    return { x, y, lo: lo - pad, hi: hi + pad, lastDate: dates[dates.length - 1]!, labelY };
  }, [analysts, price, nextEarnings]);

  if (!geom) {
    return <div style={{ padding: 20, fontSize: 11, color: "var(--text-muted)" }}>No analyst targets on file.</div>;
  }
  const { x, y, lo, hi, lastDate, labelY } = geom;

  const pricePath = price
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.date).toFixed(1)} ${y(p.close).toFixed(1)}`)
    .join(" ");

  const ticks = [lo, (lo + hi) / 2, hi];

  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} style={{ display: "block", background: "var(--bg-base)" }}>
        {ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.left} y1={y(v)} x2={W - PAD.right} y2={y(v)} stroke="#1f1f23" />
            <text x={PAD.left - 5} y={y(v) + 3} textAnchor="end" fontSize={8} fill="#6b6b70">
              {v.toFixed(0)}
            </text>
          </g>
        ))}

        {earningsDates.map((d) => (
          <line key={d} x1={x(d)} y1={PAD.top} x2={x(d)} y2={H - PAD.bottom} stroke="#3a3a40" strokeDasharray="2 4" />
        ))}
        {nextEarnings && (
          <g>
            <line
              x1={x(nextEarnings)}
              y1={PAD.top}
              x2={x(nextEarnings)}
              y2={H - PAD.bottom}
              stroke="var(--color-accent)"
              strokeDasharray="3 3"
            />
            <text x={x(nextEarnings) + 3} y={PAD.top + 8} fontSize={8} fill="var(--color-accent)">
              next print
            </text>
          </g>
        )}

        <path d={pricePath} fill="none" stroke="#e8e8ea" strokeWidth={1.1} opacity={0.85} />

        {analysts.map((a, ai) => {
          const color = ai < RAMP.length ? RAMP[ai]! : GRAY;
          const steps = a.steps;
          if (steps.length === 0) return null;
          let d = `M${x(steps[0]!.date).toFixed(1)} ${y(steps[0]!.target).toFixed(1)}`;
          for (let i = 1; i < steps.length; i++) {
            d += ` H${x(steps[i]!.date).toFixed(1)} V${y(steps[i]!.target).toFixed(1)}`;
          }
          d += ` H${x(lastDate).toFixed(1)}`;
          const lastStep = steps[steps.length - 1]!;
          return (
            <g key={a.key}>
              <path
                d={d}
                fill="none"
                stroke={color}
                strokeWidth={a.stale ? 1 : 1.5}
                strokeDasharray={a.stale ? "3 3" : undefined}
                opacity={a.stale ? 0.6 : 1}
              />
              {/* An analyst can publish twice on one date, so the index keys it. */}
              {steps.map((s, si) => (
                <circle
                  key={`${a.key}-${si}`}
                  cx={x(s.date)}
                  cy={y(s.target)}
                  r={2.6}
                  fill={s.action === "maintain" ? "none" : ACTION_FILL[s.action]}
                  stroke={s.action === "maintain" ? color : "none"}
                  strokeWidth={1}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() =>
                    setHover({
                      x: x(s.date),
                      y: y(s.target),
                      label: a.label,
                      lines: [
                        `${s.date} · ${s.action}`,
                        `target ${s.target.toFixed(2)}`,
                        s.price === null
                          ? "no close on file"
                          : `close ${s.price.toFixed(2)} · implied ${(((s.target / s.price) - 1) * 100).toFixed(1)}%`,
                      ],
                    })
                  }
                  onMouseLeave={() => setHover(null)}
                />
              ))}
              {labelY.has(ai) && (
                <>
                  <line
                    x1={x(lastDate)}
                    y1={y(lastStep.target)}
                    x2={W - PAD.right + 3}
                    y2={labelY.get(ai)!}
                    stroke={color}
                    strokeWidth={0.6}
                    opacity={0.5}
                  />
                  <text
                    x={W - PAD.right + 5}
                    y={labelY.get(ai)! + 3}
                    fontSize={8}
                    fill={color}
                    opacity={a.stale ? 0.7 : 1}
                  >
                    {a.label.length > 22 ? `${a.label.slice(0, 21)}…` : a.label}
                    {a.stale ? " (stale)" : ""}
                  </text>
                </>
              )}
            </g>
          );
        })}
      </svg>

      {hover && (
        <div
          style={{
            position: "absolute",
            left: `${(hover.x / W) * 100}%`,
            top: hover.y + 8,
            transform: "translateX(-50%)",
            pointerEvents: "none",
            background: "#0b0b0d",
            border: "1px solid var(--chrome-border)",
            padding: "3px 6px",
            fontSize: 9,
            whiteSpace: "nowrap",
            zIndex: 2,
          }}
        >
          <div style={{ fontWeight: 700 }}>{hover.label}</div>
          {hover.lines.map((l) => (
            <div key={l} style={{ color: "var(--text-muted)" }}>
              {l}
            </div>
          ))}
        </div>
      )}

      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "4px 8px", fontSize: 9, color: "var(--text-muted)" }}>
        <span>{summary}</span>
        {analysts.length > RAMP.length && (
          <span>
            {RAMP.length} most recent movers named; the other {analysts.length - RAMP.length} draw in gray.
          </span>
        )}
        <span style={{ color: "var(--color-positive)" }}>● raised</span>
        <span style={{ color: "var(--color-negative)" }}>● cut</span>
        <span style={{ color: "#5aa0ff" }}>● initiated</span>
        <span>○ maintained</span>
        <span>Dashed line = no event in {staleDays} days; that target is evicted from the score.</span>
      </div>
    </div>
  );
}
