"use client";

import { useMemo, useState } from "react";
import type { DiscoveryRow } from "./types";

const HALF = 150; // px each side of the zero axis

export function AccrualsScreen({
  rows,
  onSelectTicker,
}: {
  rows: DiscoveryRow[];
  onSelectTicker: (t: string) => void;
}) {
  const [topN, setTopN] = useState(40);

  const usable = useMemo(
    () => rows.filter((r) => r.accrualsDivergence != null && Number.isFinite(r.accrualsDivergence)),
    [rows],
  );

  const { worst, scale } = useMemo(() => {
    const sorted = [...usable].sort(
      (a, b) => (b.accrualsDivergence as number) - (a.accrualsDivergence as number),
    );
    const top = sorted.slice(0, topN);
    const maxAbs = Math.max(0.01, ...top.map((r) => Math.abs(r.accrualsDivergence as number)));
    return { worst: top, scale: HALF / maxAbs };
  }, [usable, topN]);

  if (usable.length === 0) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
        No accruals data yet (needs operating cash flow from the cash-flow statement).
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>
          NI-growth minus cash-flow-growth. <span style={{ color: "var(--bb-red)" }}>Right (red)</span> = net income
          outrunning cash = trap risk; <span style={{ color: "var(--color-positive)" }}>left (green)</span> =
          cash-backed.
        </span>
        <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
          Top
          <select value={topN} onChange={(e) => setTopN(Number(e.target.value))} style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11 }}>
            {[20, 40, 60, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        {worst.map((r) => {
          const v = r.accrualsDivergence as number;
          const w = Math.min(HALF, Math.abs(v) * scale);
          const bad = v >= 0;
          return (
            <div key={r.ticker} style={{ display: "flex", alignItems: "center", gap: 8, borderTop: "1px solid var(--chrome-border)", padding: "3px 0", fontSize: 11 }}>
              <button type="button" onClick={() => onSelectTicker(r.ticker)} style={{ color: "var(--color-accent)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0, width: 56, textAlign: "left" }}>
                {r.ticker}
              </button>
              {r.trapFlag ? <span style={{ fontSize: 8, fontWeight: 700, color: "#fff", background: "var(--bb-red)", padding: "0 3px" }}>TRAP</span> : <span style={{ width: 28 }} />}
              <div style={{ position: "relative", width: HALF * 2, height: 12 }}>
                <div style={{ position: "absolute", left: HALF, top: 0, width: 1, height: 12, background: "var(--text-muted)" }} />
                <div
                  style={{
                    position: "absolute",
                    top: 1,
                    height: 10,
                    width: w,
                    left: bad ? HALF : HALF - w,
                    background: bad ? "var(--bb-red)" : "var(--color-positive)",
                  }}
                />
              </div>
              <span className="bb-num" style={{ color: bad ? "var(--bb-red)" : "var(--color-positive)", width: 70, textAlign: "right" }}>
                {v >= 0 ? "+" : ""}{v.toFixed(3)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
