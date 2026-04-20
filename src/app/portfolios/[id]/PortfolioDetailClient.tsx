<<<<<<< Current (Your changes)
=======
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Holding = {
  ticker: string;
  weight: number;
  shares: string;     // stored as string for free-form input
  entryDate: string;  // "YYYY-MM-DD" or ""
  sector: string;
};

type Analytics = {
  annualizedReturn: number | null;
  annualizedVol: number | null;
  sharpe: number | null;
  benchmarkAnnReturn: number | null;
  benchmarkAnnVol: number | null;
  benchmarkSharpe: number | null;
};

function makeEmptyRow(): Holding {
  return { ticker: "", weight: 0, shares: "", entryDate: "", sector: "" };
}

function autoWeightsFromShares(lines: Holding[]): Holding[] {
  const totShares = lines.reduce((s, h) => s + (parseFloat(h.shares) || 0), 0);
  if (totShares === 0) return lines;
  return lines.map((h) => {
    const sh = parseFloat(h.shares) || 0;
    return { ...h, weight: parseFloat((sh / totShares).toFixed(6)) };
  });
}

export function PortfolioDetailClient({ id }: { id: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [draftName, setDraftName] = useState("");
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [lines, setLines] = useState<Holding[]>([makeEmptyRow()]);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [bench, setBench] = useState<"SP500" | "NASDAQ" | "DOW">("SP500");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/portfolios/${id}`, { cache: "no-store" });
    if (!res.ok) return;
    const j = await res.json();
    const p = j.portfolio;
    if (!p) return;
    setName(p.name);
    setDraftName(p.name);
    if (p.holdings?.length) {
      setLines(
        p.holdings.map(
          (h: {
            security: { ticker: string };
            weight: { toString(): string };
            shares: { toString(): string } | null;
            entryDate: string | null;
            sector: string | null;
          }) => ({
            ticker: h.security.ticker,
            weight: Number(h.weight.toString()),
            shares: h.shares ? h.shares.toString() : "",
            entryDate: h.entryDate ? h.entryDate.slice(0, 10) : "",
            sector: h.sector ?? "",
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

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadAnalytics(); }, [loadAnalytics]);

  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  // ── Holdings helpers ────────────────────────────────────────────────────────

  const updateLine = (i: number, field: keyof Holding, v: string) => {
    setLines((prev) => {
      const next = [...prev];
      const row = { ...next[i]! };
      if (field === "ticker") row.ticker = v.toUpperCase();
      else (row as Record<string, string | number>)[field] = v;
      next[i] = row;
      return next;
    });
  };

  const addLine = () => setLines((p) => [...p, makeEmptyRow()]);

  const removeLine = (i: number) =>
    setLines((p) => p.filter((_, idx) => idx !== i));

  const rebalanceFromShares = () =>
    setLines((prev) => autoWeightsFromShares(prev));

  // ── Save holdings ───────────────────────────────────────────────────────────

  const saveHoldings = async () => {
    setMsg(null);
    setSaving(true);
    const payload = lines.map((h) => ({
      ticker: h.ticker,
      weight: h.weight,
      shares: h.shares ? parseFloat(h.shares) : null,
      entryDate: h.entryDate || null,
      sector: h.sector || null,
    }));
    const res = await fetch(`/api/portfolios/${id}/holdings`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdings: payload }),
    });
    const j = await res.json();
    setSaving(false);
    if (!res.ok) {
      setMsg({ text: j.error ?? JSON.stringify(j.errors ?? j), ok: false });
      return;
    }
    setMsg({ text: "Holdings saved.", ok: true });
    void loadAnalytics();
  };

  // ── Rename ──────────────────────────────────────────────────────────────────

  const saveName = async () => {
    if (!draftName.trim() || draftName === name) {
      setEditingName(false);
      return;
    }
    const res = await fetch(`/api/portfolios/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: draftName.trim() }),
    });
    if (res.ok) {
      setName(draftName.trim());
      setMsg({ text: "Portfolio renamed.", ok: true });
    } else {
      setMsg({ text: "Rename failed.", ok: false });
    }
    setEditingName(false);
  };

  // ── Delete ──────────────────────────────────────────────────────────────────

  const doDelete = async () => {
    setDeleting(true);
    const res = await fetch(`/api/portfolios/${id}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/portfolios");
    } else {
      setMsg({ text: "Delete failed.", ok: false });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  // ── Derived ─────────────────────────────────────────────────────────────────

  const weightSum = lines.reduce((s, h) => s + (h.weight || 0), 0);
  const weightOk = Math.abs(weightSum - 1) < 0.001;

  return (
    <div style={{ maxWidth: 900, padding: "1.5rem", fontFamily: "system-ui, sans-serif" }}>

      {/* ── Title row ──────────────────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", marginBottom: "0.25rem" }}>
        {editingName ? (
          <>
            <input
              ref={nameInputRef}
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") setEditingName(false);
              }}
              style={{ ...inp, fontSize: "1.25rem", fontWeight: 700, minWidth: "18rem" }}
            />
            <button type="button" onClick={() => void saveName()} style={btn}>Save</button>
            <button type="button" onClick={() => setEditingName(false)} style={btnGhost}>Cancel</button>
          </>
        ) : (
          <>
            <h1 style={{ margin: 0, fontSize: "1.35rem" }}>{name || "Portfolio"}</h1>
            <button
              type="button"
              onClick={() => { setDraftName(name); setEditingName(true); }}
              style={{ ...btnGhost, fontSize: "0.8rem", padding: "0.25rem 0.5rem" }}
            >
              Rename
            </button>
          </>
        )}

        <div style={{ flex: 1 }} />

        {/* Delete */}
        {!confirmDelete ? (
          <button
            type="button"
            onClick={() => setConfirmDelete(true)}
            style={btnDanger}
          >
            Delete portfolio
          </button>
        ) : (
          <span style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            <span style={{ fontSize: "0.85rem", color: "#9b2c2c" }}>Delete permanently?</span>
            <button
              type="button"
              onClick={() => void doDelete()}
              disabled={deleting}
              style={btnDanger}
            >
              {deleting ? "Deleting…" : "Yes, delete"}
            </button>
            <button type="button" onClick={() => setConfirmDelete(false)} style={btnGhost}>
              Cancel
            </button>
          </span>
        )}
      </div>

      {/* ── Holdings ───────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: "1.05rem", marginTop: "1.5rem", marginBottom: "0.25rem" }}>Holdings</h2>

      <div style={{ display: "flex", gap: "0.75rem", marginBottom: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: "0.82rem", color: weightOk ? "#276749" : "#9b2c2c" }}>
          Weight sum: <strong>{weightSum.toFixed(4)}</strong>
          {weightOk ? " ✓" : " (must equal 1.0)"}
        </span>
        <button
          type="button"
          onClick={rebalanceFromShares}
          style={{ ...btnGhost, fontSize: "0.8rem", padding: "0.2rem 0.5rem" }}
          title="Auto-calculate weights from share counts (proportional)"
        >
          Auto-weight from shares
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 640 }}>
          <thead>
            <tr style={{ background: "#f0f2f6" }}>
              <th style={th}>Ticker</th>
              <th style={th}>Shares</th>
              <th style={th}>Weight (0–1)</th>
              <th style={th}>Entry Date</th>
              <th style={th}>Sector</th>
              <th style={th} />
            </tr>
          </thead>
          <tbody>
            {lines.map((row, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? "#fff" : "#f8f9fb" }}>
                <td style={td}>
                  <input
                    value={row.ticker}
                    onChange={(e) => updateLine(i, "ticker", e.target.value)}
                    placeholder="AAPL"
                    style={{ ...inp, width: 80 }}
                  />
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min="0"
                    step="0.0001"
                    value={row.shares}
                    onChange={(e) => updateLine(i, "shares", e.target.value)}
                    placeholder="100"
                    style={{ ...inp, width: 90 }}
                  />
                </td>
                <td style={td}>
                  <input
                    type="number"
                    min="0"
                    max="1"
                    step="0.0001"
                    value={row.weight}
                    onChange={(e) => updateLine(i, "weight", e.target.value)}
                    placeholder="0.25"
                    style={{ ...inp, width: 80 }}
                  />
                </td>
                <td style={td}>
                  <input
                    type="date"
                    value={row.entryDate}
                    onChange={(e) => updateLine(i, "entryDate", e.target.value)}
                    style={{ ...inp, width: 140 }}
                  />
                </td>
                <td style={td}>
                  <input
                    value={row.sector}
                    onChange={(e) => updateLine(i, "sector", e.target.value)}
                    placeholder="Technology"
                    style={{ ...inp, width: 130 }}
                  />
                </td>
                <td style={td}>
                  <button
                    type="button"
                    onClick={() => removeLine(i)}
                    style={{ ...btnGhost, color: "#9b2c2c", borderColor: "#9b2c2c", padding: "0.2rem 0.5rem", fontSize: "0.8rem" }}
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button type="button" onClick={addLine} style={btnGhost}>
          + Add ticker
        </button>
        <button
          type="button"
          onClick={() => void saveHoldings()}
          disabled={saving || !weightOk}
          style={{ ...btn, opacity: saving || !weightOk ? 0.6 : 1 }}
        >
          {saving ? "Saving…" : "Save holdings"}
        </button>
      </div>

      {msg && (
        <p style={{ marginTop: "0.75rem", fontSize: "0.9rem", color: msg.ok ? "#276749" : "#9b2c2c" }}>
          {msg.text}
        </p>
      )}

      {/* ── Analytics ──────────────────────────────────────────────────────── */}
      <h2 style={{ fontSize: "1.05rem", marginTop: "2rem" }}>Analytics</h2>
      <label style={{ fontSize: "0.9rem" }}>
        Benchmark:{" "}
        <select
          value={bench}
          onChange={(e) => setBench(e.target.value as typeof bench)}
          style={{ marginLeft: "0.25rem" }}
        >
          <option value="SP500">S&amp;P 500</option>
          <option value="NASDAQ">NASDAQ</option>
          <option value="DOW">DOW</option>
        </select>
      </label>
      {analytics && (
        <table style={{ marginTop: "0.75rem", borderCollapse: "collapse", fontSize: "0.9rem" }}>
          <tbody>
            {[
              ["Portfolio ann. return", fmtPct(analytics.annualizedReturn)],
              ["Portfolio ann. realized vol", fmtPct(analytics.annualizedVol)],
              ["Portfolio Sharpe", fmtNum(analytics.sharpe)],
              ["Benchmark ann. return", fmtPct(analytics.benchmarkAnnReturn)],
              ["Benchmark ann. vol", fmtPct(analytics.benchmarkAnnVol)],
              ["Benchmark Sharpe", fmtNum(analytics.benchmarkSharpe)],
            ].map(([label, val]) => (
              <tr key={label}>
                <td style={{ ...td, color: "#4a5a6b", paddingRight: "2rem" }}>{label}</td>
                <td style={{ ...td, fontWeight: 600 }}>{val}</td>
              </tr>
            ))}
          </tbody>
        </table>
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

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.5rem",
  borderBottom: "2px solid #cfd6e0",
  fontSize: "0.82rem",
  color: "#4a5a6b",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "0.3rem 0.5rem",
  borderBottom: "1px solid #eceef2",
  verticalAlign: "middle",
};
const inp: React.CSSProperties = {
  padding: "0.25rem 0.35rem",
  borderRadius: 4,
  border: "1px solid #b8c0cc",
  fontSize: "0.88rem",
};
const btn: React.CSSProperties = {
  padding: "0.4rem 0.75rem",
  borderRadius: 4,
  border: "1px solid #1a3a5c",
  background: "#1a3a5c",
  color: "#fff",
  cursor: "pointer",
  fontSize: "0.88rem",
};
const btnGhost: React.CSSProperties = {
  ...btn,
  background: "#fff",
  color: "#1a3a5c",
};
const btnDanger: React.CSSProperties = {
  ...btn,
  border: "1px solid #9b2c2c",
  background: "#9b2c2c",
};
>>>>>>> Incoming (Background Agent changes)
