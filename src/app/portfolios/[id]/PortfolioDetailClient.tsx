"use client";

import { useCallback, useEffect, useState } from "react";

type Holding = { ticker: string; weight: number };

export function PortfolioDetailClient({ id }: { id: string }) {
  const [name, setName] = useState("");
  const [lines, setLines] = useState<Holding[]>([
    { ticker: "NVDA", weight: 0.5 },
    { ticker: "AMD", weight: 0.5 },
  ]);
  const [msg, setMsg] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<{
    annualizedReturn: number | null;
    annualizedVol: number | null;
    sharpe: number | null;
    benchmarkAnnReturn: number | null;
    benchmarkAnnVol: number | null;
    benchmarkSharpe: number | null;
  } | null>(null);
  const [bench, setBench] = useState<"SP500" | "NASDAQ" | "DOW">("SP500");

  const load = useCallback(async () => {
    const res = await fetch(`/api/portfolios/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    const p = j.portfolio;
    if (!p) return;
    setName(p.name);
    if (p.holdings?.length) {
      setLines(
        p.holdings.map(
          (h: { security: { ticker: string }; weight: { toString(): string } }) => ({
            ticker: h.security.ticker,
            weight: Number(h.weight.toString()),
          })
        )
      );
    }
  }, [id]);

  const loadAnalytics = useCallback(async () => {
    const res = await fetch(
      `/api/portfolios/${id}/analytics?benchmark=${bench}`,
      { cache: "no-store" }
    );
    if (!res.ok) return;
    const j = await res.json();
    setAnalytics(j.analytics);
  }, [id, bench]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadAnalytics();
  }, [loadAnalytics]);

  const saveHoldings = async () => {
    setMsg(null);
    const res = await fetch(`/api/portfolios/${id}/holdings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdings: lines }),
    });
    const j = await res.json();
    if (!res.ok) {
      setMsg(j.error ?? JSON.stringify(j));
      return;
    }
    setMsg("Holdings saved.");
    void loadAnalytics();
  };

  const updateLine = (i: number, field: keyof Holding, v: string) => {
    setLines((prev) => {
      const next = [...prev];
      const row = { ...next[i]! };
      if (field === "ticker") row.ticker = v.toUpperCase();
      else row.weight = Number(v) || 0;
      next[i] = row;
      return next;
    });
  };

  const addLine = () => setLines((p) => [...p, { ticker: "", weight: 0 }]);
  const removeLine = (i: number) =>
    setLines((p) => p.filter((_, idx) => idx !== i));

  return (
    <div style={{ maxWidth: 720, padding: "1.5rem" }}>
      <h1 style={{ fontSize: "1.35rem" }}>{name || "Portfolio"}</h1>
      <p style={{ color: "#4a5a6b", fontSize: "0.9rem" }}>Id: {id}</p>

      <h2 style={{ fontSize: "1.05rem", marginTop: "1.25rem" }}>Holdings</h2>
      <p style={{ fontSize: "0.85rem", color: "#6a7a8b" }}>
        Weights must sum to 1.0 (e.g. 0.6 + 0.4).
      </p>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ background: "#f0f2f6" }}>
            <th style={th}>Ticker</th>
            <th style={th}>Weight</th>
            <th style={th} />
          </tr>
        </thead>
        <tbody>
          {lines.map((row, i) => (
            <tr key={i}>
              <td style={td}>
                <input
                  value={row.ticker}
                  onChange={(e) => updateLine(i, "ticker", e.target.value)}
                  style={inp}
                />
              </td>
              <td style={td}>
                <input
                  type="number"
                  step="0.0001"
                  value={row.weight}
                  onChange={(e) => updateLine(i, "weight", e.target.value)}
                  style={inp}
                />
              </td>
              <td style={td}>
                <button type="button" onClick={() => removeLine(i)}>
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
        <button type="button" onClick={addLine} style={btnGhost}>
          Add row
        </button>
        <button type="button" onClick={() => void saveHoldings()} style={btn}>
          Save holdings
        </button>
      </div>

      <h2 style={{ fontSize: "1.05rem", marginTop: "1.75rem" }}>Analytics</h2>
      <label style={{ fontSize: "0.9rem" }}>
        Benchmark:{" "}
        <select
          value={bench}
          onChange={(e) => setBench(e.target.value as typeof bench)}
        >
          <option value="SP500">S&amp;P 500</option>
          <option value="NASDAQ">NASDAQ</option>
          <option value="DOW">DOW</option>
        </select>
      </label>
      {analytics && (
        <table style={{ marginTop: "0.75rem", borderCollapse: "collapse" }}>
          <tbody>
            <tr>
              <td style={td}>Portfolio ann. return</td>
              <td style={td}>
                {fmtPct(analytics.annualizedReturn)}
              </td>
            </tr>
            <tr>
              <td style={td}>Portfolio ann. realized vol</td>
              <td style={td}>{fmtPct(analytics.annualizedVol)}</td>
            </tr>
            <tr>
              <td style={td}>Portfolio Sharpe</td>
              <td style={td}>{fmtNum(analytics.sharpe)}</td>
            </tr>
            <tr>
              <td style={td}>Benchmark ann. return</td>
              <td style={td}>{fmtPct(analytics.benchmarkAnnReturn)}</td>
            </tr>
            <tr>
              <td style={td}>Benchmark ann. vol</td>
              <td style={td}>{fmtPct(analytics.benchmarkAnnVol)}</td>
            </tr>
            <tr>
              <td style={td}>Benchmark Sharpe</td>
              <td style={td}>{fmtNum(analytics.benchmarkSharpe)}</td>
            </tr>
          </tbody>
        </table>
      )}

      {msg && (
        <p style={{ marginTop: "1rem", fontSize: "0.9rem", color: "#1a5a30" }}>
          {msg}
        </p>
      )}
    </div>
  );
}

function fmtPct(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return `${(v * 100).toFixed(2)}%`;
}

function fmtNum(v: number | null) {
  if (v == null || !Number.isFinite(v)) return "—";
  return v.toFixed(2);
}

const th = {
  textAlign: "left" as const,
  padding: "0.4rem 0.5rem",
  borderBottom: "1px solid #cfd6e0",
};
const td = { padding: "0.35rem 0.5rem", borderBottom: "1px solid #eceef2" };
const inp = {
  width: "100%",
  padding: "0.25rem 0.35rem",
  borderRadius: 4,
  border: "1px solid #b8c0cc",
};
const btn = {
  padding: "0.4rem 0.75rem",
  borderRadius: 4,
  border: "1px solid #1a3a5c",
  background: "#1a3a5c",
  color: "#fff",
  cursor: "pointer" as const,
};
const btnGhost = { ...btn, background: "#fff", color: "#1a3a5c" };
