"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface TrajectoryPoint {
  snapshotDate: string;
  composite: number | null;
  rank: number | null;
  subsectorDecile: number | null;
  newArrival: boolean;
  signals: Record<string, number | null>;
  epsAvg: number | null;
  ptConsensus: number | null;
}

interface TrajectoryResult {
  ticker: string;
  points: TrajectoryPoint[];
}

export function RevisionTrajectory({
  ticker,
  onPickTicker,
}: {
  ticker: string | null;
  onPickTicker: (t: string) => void;
}) {
  const [input, setInput] = useState(ticker ?? "");

  const { data, isLoading, error } = useQuery<TrajectoryResult>({
    queryKey: ["research-trajectory", ticker],
    enabled: !!ticker,
    queryFn: async () => {
      const r = await fetch(`/api/analysis/research/trajectory?ticker=${encodeURIComponent(ticker!)}`);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Failed");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const chartData = (data?.points ?? []).map((p) => ({
    date: p.snapshotDate,
    composite: p.composite,
    epsRevision: p.signals.epsRevision ?? null,
    ratingMomentum: p.signals.ratingMomentum ?? null,
    ptRevision: p.signals.ptRevision ?? null,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>Ticker</span>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter" && input.trim()) onPickTicker(input.trim());
          }}
          placeholder="e.g. AAPL"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11, padding: "2px 6px", width: 100 }}
        />
        <button
          type="button"
          className="bb-tab"
          style={{ border: "1px solid var(--chrome-border)" }}
          onClick={() => input.trim() && onPickTicker(input.trim())}
        >
          Show
        </button>
        {data?.ticker ? <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{data.ticker}</span> : null}
      </div>

      {!ticker ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
          Pick a ticker from the Master Rank table, or type one above. Trajectory shows whether the
          revision signal is a durable climb, a spike, or a round-trip over the stored weeks.
        </div>
      ) : isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading trajectory…</div>
      ) : error ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
          No stored revision history for {ticker} yet — Leg A series accrues weekly.
        </div>
      ) : (
        <>
          <div style={{ height: 280, background: "var(--bg-surface)", padding: 6 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 4, left: -8 }}>
                <CartesianGrid stroke="var(--chrome-border)" strokeDasharray="2 2" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
                <YAxis tick={{ fontSize: 9, fill: "var(--text-muted)" }} />
                <Tooltip
                  contentStyle={{ background: "var(--bg-base)", border: "1px solid var(--chrome-border)", fontSize: 11 }}
                  labelStyle={{ color: "var(--text-muted)" }}
                />
                <Line type="monotone" dataKey="composite" name="Composite z" stroke="var(--color-accent)" dot={false} strokeWidth={2} connectNulls />
                <Line type="monotone" dataKey="ratingMomentum" name="Rating momentum" stroke="var(--color-positive)" dot={false} connectNulls />
                <Line type="monotone" dataKey="ptRevision" name="PT revision" stroke="#5aa0ff" dot={false} connectNulls />
                <Line type="monotone" dataKey="epsRevision" name="EPS revision" stroke="#d8a0ff" dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
            {data?.points.length ?? 0} weekly observations. Leg B (rating/PT) fills from day one via
            backfill; Leg A (estimates) accrues forward as snapshots accumulate.
          </div>
        </>
      )}
    </div>
  );
}
