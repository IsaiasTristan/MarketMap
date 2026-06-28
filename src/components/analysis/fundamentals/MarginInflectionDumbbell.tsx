"use client";

import { useMemo, useState } from "react";
import type { DiscoveryRow } from "./types";

const TRACK_W = 260;

export function MarginInflectionDumbbell({
  rows,
  onSelectTicker,
}: {
  rows: DiscoveryRow[];
  onSelectTicker: (t: string) => void;
}) {
  const [topN, setTopN] = useState(40);
  const [direction, setDirection] = useState<"up" | "down">("up");

  const usable = useMemo(
    () => rows.filter((r) => r.marginNow != null && r.marginPrior != null),
    [rows],
  );

  const { ranked, lo, hi } = useMemo(() => {
    const withTurn = usable.map((r) => ({ r, turn: (r.marginNow as number) - (r.marginPrior as number) }));
    withTurn.sort((a, b) => (direction === "up" ? b.turn - a.turn : a.turn - b.turn));
    const top = withTurn.slice(0, topN);
    const vals = top.flatMap((t) => [t.r.marginNow as number, t.r.marginPrior as number]);
    return {
      ranked: top,
      lo: vals.length ? Math.min(...vals) : 0,
      hi: vals.length ? Math.max(...vals) : 1,
    };
  }, [usable, topN, direction]);

  const x = (v: number) => {
    if (hi - lo < 1e-9) return 0;
    return ((v - lo) / (hi - lo)) * TRACK_W;
  };
  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

  if (usable.length === 0) {
    return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>No margin history yet.</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>
          EBITDA margin: ~8 quarters ago <span style={{ color: "var(--text-muted)" }}>●</span> → now{" "}
          <span style={{ color: "var(--color-accent)" }}>●</span>, ranked by size of turn.
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          Show
          <select value={direction} onChange={(e) => setDirection(e.target.value as "up" | "down")} style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11 }}>
            <option value="up">biggest expansions</option>
            <option value="down">biggest contractions</option>
          </select>
        </label>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          Top
          <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11 }}>
            {[20, 40, 60, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {ranked.map(({ r, turn }) => {
          const prior = r.marginPrior as number;
          const now = r.marginNow as number;
          const xPrior = x(prior);
          const xNow = x(now);
          const left = Math.min(xPrior, xNow);
          const width = Math.abs(xNow - xPrior);
          const lineColor = turn >= 0 ? "var(--color-positive)" : "var(--bb-red)";
          return (
            <div key={r.ticker} style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--chrome-border)", padding: "3px 0", fontSize: 11 }}>
              <button type="button" onClick={() => onSelectTicker(r.ticker)} style={{ color: "var(--color-accent)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0, width: 56, textAlign: "left" }}>
                {r.ticker}
              </button>
              {r.trapFlag ? <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: "var(--bb-red)", padding: "0 3px" }}>TRAP</span> : null}
              <div style={{ position: "relative", width: TRACK_W, height: 14 }}>
                <div style={{ position: "absolute", top: 6, left: 0, width: TRACK_W, height: 1, background: "var(--chrome-border)" }} />
                <div style={{ position: "absolute", top: 5, left, width: Math.max(1, width), height: 3, background: lineColor }} />
                <span style={{ position: "absolute", top: 3, left: xPrior - 3, width: 7, height: 7, borderRadius: "50%", background: "var(--text-muted)" }} title={`prior ${pct(prior)}`} />
                <span style={{ position: "absolute", top: 3, left: xNow - 3, width: 7, height: 7, borderRadius: "50%", background: "var(--color-accent)" }} title={`now ${pct(now)}`} />
              </div>
              <span className="bb-num" style={{ color: lineColor, width: 64, textAlign: "right" }}>
                {turn >= 0 ? "+" : ""}{(turn * 100).toFixed(1)} pp
              </span>
              <span className="bb-num" style={{ color: "var(--text-muted)", width: 110 }}>{pct(prior)} → {pct(now)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
