"use client";
/**
 * Fund search palette (Fund Overview Part 6). A command-palette combobox opened by
 * Cmd/Ctrl+K from anywhere in Flows (also reused as the FUNDS-header search and the
 * dossier "switch fund" control). Fetches the small fund index once and matches in the
 * browser via the pure matcher — prefix > word > substring > fuzzy, aliases + CIK.
 * Full keyboard support (arrows / Enter / Esc), aria-combobox, focus returned on close.
 * Context-tier results carry a "context" badge. Selecting navigates via the FundLink
 * deep-link contract (/flows?tab=funds&fund=<cik>).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { searchFunds, type FundIndexEntry, type FundSearchResult } from "@/lib/institutional/fund-search";
import { FUND_OVERVIEW_CONFIG } from "@/domain/calculations/fund-overview-config";
import { useFlows } from "../useFlows";

const RECENTS_KEY = "flows-fund-recents";
const CFG = FUND_OVERVIEW_CONFIG;

function loadRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(RECENTS_KEY) ?? "[]");
  } catch {
    return [];
  }
}
function pushRecent(cik: string) {
  if (typeof window === "undefined") return;
  const next = [cik, ...loadRecents().filter((c) => c !== cik)].slice(0, CFG.search_recent_k);
  window.localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
}

const fmtAum = (n: number | null): string => {
  if (n == null) return "";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
};

export function FundSearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const restoreFocus = useRef<HTMLElement | null>(null);

  const { data } = useFlows<{ funds: FundIndexEntry[] }>(["flows-fund-search-index"], "/api/analysis/flows/fund-search-index", open);
  const index = data?.funds ?? [];

  // Empty query → recent lookups (resolved against the index), else ranked matches.
  const results: FundSearchResult[] = useMemo(() => {
    if (q.trim()) return searchFunds(q, index, { maxResults: CFG.search_max_results });
    const recents = loadRecents();
    const byCik = new Map(index.map((f) => [f.cik, f]));
    return recents
      .map((c) => byCik.get(c))
      .filter((f): f is FundIndexEntry => !!f)
      .map((f) => ({ ...f, matchKind: "prefix" as const, matchedOn: f.name, score: 0 }));
  }, [q, index]);

  useEffect(() => {
    setActive(0);
  }, [q]);

  useEffect(() => {
    if (open) {
      restoreFocus.current = document.activeElement as HTMLElement;
      setQ("");
      // Focus after mount.
      const t = setTimeout(() => inputRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    restoreFocus.current?.focus?.();
  }, [open]);

  if (!open) return null;

  const select = (r: FundSearchResult) => {
    pushRecent(r.cik);
    onClose();
    router.push(`/flows?tab=funds&fund=${encodeURIComponent(r.cik)}`);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[active];
      if (r) select(r);
    }
  };

  return (
    <div
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(0,0,0,0.55)", display: "flex", justifyContent: "center", alignItems: "flex-start", paddingTop: "12vh" }}
    >
      <div style={{ width: "min(560px, 92vw)", background: "var(--bg-base, #0b0b0b)", border: "1px solid var(--bg-border, #2a2a2a)", boxShadow: "0 12px 48px rgba(0,0,0,0.6)" }}>
        <input
          ref={inputRef}
          role="combobox"
          aria-expanded={results.length > 0}
          aria-controls="fund-search-listbox"
          aria-activedescendant={results[active] ? `fund-opt-${results[active]!.cik}` : undefined}
          aria-autocomplete="list"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Search funds — name, manager (Buffett), short name (GAMCO), or CIK…"
          style={{ width: "100%", background: "transparent", border: "none", borderBottom: "1px solid var(--bg-border)", color: "var(--text-primary)", fontSize: 14, padding: "12px 14px", outline: "none" }}
        />
        <ul id="fund-search-listbox" role="listbox" style={{ listStyle: "none", margin: 0, padding: 0, maxHeight: "50vh", overflowY: "auto" }}>
          {results.length === 0 ? (
            <li style={{ padding: 14, fontSize: 12, color: "var(--text-muted)" }}>
              {q.trim() ? (
                <>
                  no fund found ·{" "}
                  <a href="/flows?tab=watchlist" style={{ color: "var(--color-info)" }}>request it in the data-quality queue</a>
                </>
              ) : (
                "recent lookups appear here — start typing to search"
              )}
            </li>
          ) : (
            results.map((r, i) => (
              <li
                key={r.cik}
                id={`fund-opt-${r.cik}`}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => select(r)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", cursor: "pointer", background: i === active ? "var(--bg-surface)" : "transparent", borderBottom: "1px solid var(--bg-border)" }}
              >
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ color: "var(--text-primary)", fontWeight: 700 }}>{r.name}</span>
                  {r.isElite && <span title="most-respected subset" style={{ color: "var(--color-accent)", marginLeft: 5 }}>★</span>}
                  {r.tier === "context" && (
                    <span style={{ marginLeft: 6, border: "1px solid var(--bg-border)", color: "var(--text-muted)", fontSize: 9, padding: "0 4px", textTransform: "uppercase" }}>context</span>
                  )}
                  {r.matchedOn.toLowerCase() !== r.name.toLowerCase() && (
                    <span style={{ marginLeft: 6, color: "var(--text-muted)", fontSize: 10 }}>“{r.matchedOn}”</span>
                  )}
                  <span style={{ display: "block", color: "var(--text-muted)", fontSize: 10 }}>{r.category}</span>
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 11, fontVariantNumeric: "tabular-nums" }}>{fmtAum(r.aum13fUsd)}</span>
              </li>
            ))
          )}
        </ul>
        <div style={{ padding: "6px 14px", fontSize: 10, color: "var(--text-muted)", borderTop: "1px solid var(--bg-border)", display: "flex", gap: 12 }}>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
