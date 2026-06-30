"use client";

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

type RatingChangeKind = "RATING" | "PRICE_TARGET";

interface RatingChangeRow {
  kind: RatingChangeKind;
  ticker: string;
  companyName: string;
  sector: string | null;
  date: string;
  gradingCompany: string | null;
  previousGrade: string | null;
  newGrade: string | null;
  action: string | null;
  analystCompany: string | null;
  analystName: string | null;
  priceTarget: number | null;
  priceWhenPosted: number | null;
  newsPublisher: string | null;
}

interface EventsPayload {
  generatedAt: string;
  count: number;
  rows: RatingChangeRow[];
}

type KindFilter = "ALL" | "RATING" | "PRICE_TARGET";

const ARROW = "\u2192"; // right arrow glyph

function actionColor(action: string | null): string {
  const a = (action ?? "").toLowerCase();
  if (a.includes("up")) return "var(--color-positive)";
  if (a.includes("down")) return "var(--color-negative)";
  if (a.includes("init")) return "var(--color-accent)";
  return "var(--text-muted)";
}

function ActionChip({ action }: { action: string | null }) {
  if (!action) return <span style={{ color: "var(--text-muted)" }}>{"\u2014"}</span>;
  const color = actionColor(action);
  return (
    <span
      style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        color,
        border: `1px solid ${color}`,
        padding: "0 4px",
        borderRadius: 2,
        whiteSpace: "nowrap",
      }}
    >
      {action}
    </span>
  );
}

function fmtPrice(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "\u2014";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function RatingChanges({
  ticker,
  onSelectTicker,
}: {
  ticker?: string | null;
  onSelectTicker?: (t: string) => void;
}) {
  const [kind, setKind] = useState<KindFilter>("ALL");
  const [query, setQuery] = useState("");

  const url = ticker
    ? `/api/analysis/research/events?limit=500&ticker=${encodeURIComponent(ticker)}`
    : "/api/analysis/research/events?limit=500";

  const { data, isLoading, error } = useQuery<EventsPayload>({
    queryKey: ["research-events", ticker ?? "all"],
    queryFn: async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Failed to load events");
      return r.json();
    },
    staleTime: 5 * 60_000,
  });

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    const q = query.trim().toUpperCase();
    return all.filter((r) => {
      if (kind !== "ALL" && r.kind !== kind) return false;
      if (q && !r.ticker.includes(q) && !(r.companyName ?? "").toUpperCase().includes(q)) return false;
      return true;
    });
  }, [data, kind, query]);

  if (isLoading) return <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>Loading rating changes...</div>;
  if (error) {
    return (
      <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>
        No rating-change events yet. They are tailed daily from FMP once the revision runner has run (admin: &quot;Run weekly ingest&quot;, or `npm run job:revision-daily`).
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11 }}>
        <span style={{ color: "var(--text-muted)" }}>{rows.length} events</span>
        <div style={{ display: "flex", gap: 4 }}>
          {(["ALL", "RATING", "PRICE_TARGET"] as KindFilter[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              className="bb-tab"
              style={{
                fontSize: 10,
                padding: "1px 6px",
                border: "1px solid var(--chrome-border)",
                background: kind === k ? "var(--bg-surface)" : "transparent",
                color: kind === k ? "var(--text-primary)" : "var(--text-muted)",
                cursor: "pointer",
              }}
            >
              {k === "ALL" ? "All" : k === "RATING" ? "Upgrades / Downgrades" : "Price Targets"}
            </button>
          ))}
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter ticker / name"
          style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)", color: "var(--text-primary)", fontSize: 11, padding: "2px 6px" }}
        />
      </div>

      <div style={{ overflowX: "auto" }}>
        <table className="bb-table" style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left" }}>
              <th style={{ padding: "3px 6px" }}>Date</th>
              <th style={{ padding: "3px 6px" }}>Ticker</th>
              <th style={{ padding: "3px 6px" }}>Company</th>
              <th style={{ padding: "3px 6px" }}>Type</th>
              <th style={{ padding: "3px 6px" }}>Firm / Analyst</th>
              <th style={{ padding: "3px 6px" }}>Action</th>
              <th style={{ padding: "3px 6px" }}>Change</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={`${r.kind}-${r.ticker}-${r.date}-${i}`} style={{ borderTop: "1px solid var(--chrome-border)" }}>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)", whiteSpace: "nowrap" }}>{r.date}</td>
                <td style={{ padding: "2px 6px" }}>
                  {onSelectTicker ? (
                    <button
                      type="button"
                      onClick={() => onSelectTicker(r.ticker)}
                      style={{ color: "var(--color-accent)", fontWeight: 700, background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    >
                      {r.ticker}
                    </button>
                  ) : (
                    <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{r.ticker}</span>
                  )}
                </td>
                <td style={{ padding: "2px 6px", color: "var(--text-primary)", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.companyName}</td>
                <td style={{ padding: "2px 6px", color: "var(--text-muted)" }}>{r.kind === "RATING" ? "Rating" : "Price Tgt"}</td>
                <td style={{ padding: "2px 6px", color: "var(--text-primary)", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {r.kind === "RATING" ? r.gradingCompany ?? "\u2014" : r.analystCompany ?? r.analystName ?? r.newsPublisher ?? "\u2014"}
                </td>
                <td style={{ padding: "2px 6px" }}>{r.kind === "RATING" ? <ActionChip action={r.action} /> : <span style={{ color: "var(--text-muted)" }}>{"\u2014"}</span>}</td>
                <td style={{ padding: "2px 6px", whiteSpace: "nowrap" }}>
                  {r.kind === "RATING" ? (
                    <span style={{ color: "var(--text-primary)" }}>
                      <span style={{ color: "var(--text-muted)" }}>{r.previousGrade ?? "\u2014"}</span> {ARROW}{" "}
                      <span style={{ fontWeight: 600 }}>{r.newGrade ?? "\u2014"}</span>
                    </span>
                  ) : (
                    <PriceTargetChange target={r.priceTarget} prior={r.priceWhenPosted} />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <div style={{ color: "var(--text-muted)", fontSize: 11, padding: 12 }}>No events match the current filters.</div>
        ) : null}
      </div>
    </div>
  );
}

function PriceTargetChange({ target, prior }: { target: number | null; prior: number | null }) {
  const dir =
    target != null && prior != null && Number.isFinite(target) && Number.isFinite(prior)
      ? target > prior
        ? "up"
        : target < prior
          ? "down"
          : "flat"
      : "flat";
  const color = dir === "up" ? "var(--color-positive)" : dir === "down" ? "var(--color-negative)" : "var(--text-primary)";
  return (
    <span style={{ color: "var(--text-primary)" }}>
      {prior != null ? <span style={{ color: "var(--text-muted)" }}>{fmtPrice(prior)} {ARROW} </span> : null}
      <span style={{ fontWeight: 600, color }} className="bb-num">{fmtPrice(target)}</span>
    </span>
  );
}
