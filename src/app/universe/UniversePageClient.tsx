"use client";

import type { CSSProperties } from "react";
import { useCallback, useEffect, useState } from "react";
import type { ParsedUniverseRow } from "@/domain/universe/parse";

const SAMPLE = `NVDA   NVIDIA      Semiconductors    AI Chips
AMD    AMD         Semiconductors    AI Chips
TSLA   Tesla       EVs               EV Manufacturers
`;

export function UniversePageClient() {
  const [name, setName] = useState("My universe");
  const [text, setText] = useState(SAMPLE);
  const [preview, setPreview] = useState<ParsedUniverseRow[] | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [universes, setUniverses] = useState<
    { id: string; name: string; _count: { constituents: number } }[]
  >([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadUniverses = useCallback(async () => {
    const res = await fetch("/api/universes", { cache: "no-store" });
    const j = (await res.json()) as {
      universes?: { id: string; name: string; _count: { constituents: number } }[];
    };
    const list = j.universes ?? [];
    setUniverses(list);
    setSelectedId((cur) => cur ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void loadUniverses();
  }, [loadUniverses]);

  const onPreview = async () => {
    setParseErr(null);
    setPreview(null);
    const res = await fetch("/api/parse-universe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const j = await res.json();
    if (!res.ok) {
      setParseErr(
        Array.isArray(j.errors)
          ? j.errors.map((e: { message: string }) => e.message).join("; ")
          : "Parse failed"
      );
      return;
    }
    setPreview(j.rows);
  };

  const onCreateUniverse = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/universes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(j));
      setSelectedId(j.id);
      setMsg("Universe created.");
      await loadUniverses();
      setSelectedId(j.id);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSaveConstituents = async () => {
    if (!selectedId || !preview?.length) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/universes/${selectedId}/constituents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview }),
      });
      if (!res.ok) throw new Error(await res.text());
      setMsg("Constituents saved.");
      await loadUniverses();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onIngest = async () => {
    if (!selectedId) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/universes/${selectedId}/ingest`, {
        method: "POST",
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setMsg(`Prices updated (${j.bars} bars across ${j.tickers} tickers).`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onBenchmarks = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/benchmarks/ingest", { method: "POST" });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error ?? res.statusText);
      setMsg(`Benchmarks updated (${j.bars} bars).`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onSetup = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch("/api/setup", { method: "POST" });
      if (!res.ok) throw new Error(await res.text());
      setMsg("Benchmark metadata seeded.");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 900, padding: "1.5rem" }}>
      <h1 style={{ fontSize: "1.35rem" }}>Universe</h1>
      <p style={{ color: "#4a5a6b", fontSize: "0.95rem" }}>
        Paste tickers (tab or 2+ spaces between columns). Preview, then save to
        the selected universe. Pull prices from Yahoo (adjusted closes) and
        refresh benchmarks for excess return.
      </p>

      <section style={{ marginBottom: "1.5rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Universes</h2>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "0.75rem" }}>
          <select
            value={selectedId ?? ""}
            onChange={(e) => setSelectedId(e.target.value || null)}
            style={sel}
          >
            <option value="">— select —</option>
            {universes.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u._count.constituents})
              </option>
            ))}
          </select>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="New universe name"
            style={{ ...sel, minWidth: "12rem" }}
          />
          <button
            type="button"
            onClick={() => void onCreateUniverse()}
            disabled={busy}
            style={btn}
          >
            Create universe
          </button>
          <button
            type="button"
            onClick={() => void onSetup()}
            disabled={busy}
            style={btnGhost}
          >
            Seed benchmark rows
          </button>
          <button
            type="button"
            onClick={() => void onBenchmarks()}
            disabled={busy}
            style={btnGhost}
          >
            Refresh benchmark prices
          </button>
          <button
            type="button"
            onClick={() => void onIngest()}
            disabled={busy || !selectedId}
            style={btn}
          >
            Refresh universe prices
          </button>
          <a
            href={selectedId ? `/market-map?universeId=${selectedId}` : "#"}
            style={{
              ...btnGhost,
              display: "inline-flex",
              alignItems: "center",
              pointerEvents: selectedId ? "auto" : "none",
              opacity: selectedId ? 1 : 0.4,
            }}
          >
            Open market map
          </a>
        </div>
      </section>

      <section style={{ marginBottom: "1rem" }}>
        <h2 style={{ fontSize: "1.05rem" }}>Paste list</h2>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          style={{
            width: "100%",
            fontFamily: "ui-monospace, monospace",
            fontSize: "0.85rem",
            padding: "0.5rem",
            borderRadius: 4,
            border: "1px solid #b8c0cc",
          }}
        />
        <div style={{ marginTop: "0.5rem", display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={() => void onPreview()}
            disabled={busy}
            style={btn}
          >
            Preview
          </button>
          <button
            type="button"
            onClick={() => void onSaveConstituents()}
            disabled={busy || !selectedId || !preview?.length}
            style={btn}
          >
            Save to universe
          </button>
        </div>
        {parseErr && (
          <p style={{ color: "#a32020", fontSize: "0.9rem" }}>{parseErr}</p>
        )}
      </section>

      {preview && preview.length > 0 && (
        <section>
          <h2 style={{ fontSize: "1.05rem" }}>Preview ({preview.length})</h2>
          <div style={{ overflowX: "auto", border: "1px solid #cfd6e0" }}>
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                fontSize: "0.88rem",
              }}
            >
              <thead>
                <tr style={{ background: "#f0f2f6" }}>
                  <th style={th}>Ticker</th>
                  <th style={th}>Company</th>
                  <th style={th}>Sector</th>
                  <th style={th}>Sub-theme</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((r) => (
                  <tr key={r.ticker + r.subTheme}>
                    <td style={td}>{r.ticker}</td>
                    <td style={td}>{r.companyName}</td>
                    <td style={td}>{r.sector}</td>
                    <td style={td}>{r.subTheme}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {msg && (
        <p style={{ marginTop: "1rem", color: "#1a5a30", fontSize: "0.9rem" }}>
          {msg}
        </p>
      )}
    </div>
  );
}

const sel: CSSProperties = {
  padding: "0.35rem 0.5rem",
  borderRadius: 4,
  border: "1px solid #b8c0cc",
};

const btn: CSSProperties = {
  padding: "0.4rem 0.75rem",
  borderRadius: 4,
  border: "1px solid #1a3a5c",
  background: "#1a3a5c",
  color: "#fff",
  cursor: "pointer",
};

const btnGhost: CSSProperties = {
  ...btn,
  background: "#fff",
  color: "#1a3a5c",
};

const th: CSSProperties = {
  textAlign: "left",
  padding: "0.4rem 0.6rem",
  borderBottom: "1px solid #cfd6e0",
};

const td: CSSProperties = {
  padding: "0.35rem 0.6rem",
  borderBottom: "1px solid #eceef2",
};
