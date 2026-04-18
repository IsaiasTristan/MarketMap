"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

export function PortfoliosPageClient() {
  const [list, setList] = useState<
    { id: string; name: string; _count: { holdings: number } }[]
  >([]);
  const [name, setName] = useState("Core sleeve");
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/portfolios", { cache: "no-store" });
    const j = await res.json();
    setList(j.portfolios ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onCreate = async () => {
    setMsg(null);
    const res = await fetch("/api/portfolios", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    const j = await res.json();
    if (!res.ok) {
      setMsg(JSON.stringify(j));
      return;
    }
    setMsg("Created.");
    await load();
  };

  return (
    <div style={{ maxWidth: 720, padding: "1.5rem" }}>
      <h1 style={{ fontSize: "1.35rem" }}>Portfolios</h1>
      <p style={{ color: "#4a5a6b", fontSize: "0.95rem" }}>
        Holdings must reference tickers already in the database (save a universe
        and run price refresh first).
      </p>
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1.25rem" }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Portfolio name"
          style={{
            padding: "0.35rem 0.5rem",
            borderRadius: 4,
            border: "1px solid #b8c0cc",
            minWidth: "14rem",
          }}
        />
        <button
          type="button"
          onClick={() => void onCreate()}
          style={{
            padding: "0.4rem 0.75rem",
            borderRadius: 4,
            border: "1px solid #1a3a5c",
            background: "#1a3a5c",
            color: "#fff",
            cursor: "pointer",
          }}
        >
          Create
        </button>
      </div>
      {msg && <p style={{ fontSize: "0.9rem", color: "#1a5a30" }}>{msg}</p>}
      <ul style={{ listStyle: "none", padding: 0 }}>
        {list.map((p) => (
          <li
            key={p.id}
            style={{
              marginBottom: "0.65rem",
              paddingBottom: "0.65rem",
              borderBottom: "1px solid #e4e8ee",
            }}
          >
            <Link
              href={`/portfolios/${p.id}`}
              style={{ fontWeight: 600, color: "#1a3a5c" }}
            >
              {p.name}
            </Link>
            <span style={{ color: "#6a7a8b", marginLeft: "0.5rem" }}>
              {p._count.holdings} holdings
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
