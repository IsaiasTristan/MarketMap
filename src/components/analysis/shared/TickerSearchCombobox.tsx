"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

export interface SecuritySuggestion {
  ticker: string;
  name: string;
  sector: string | null;
  isBenchmark: boolean;
}

export interface TickerSearchComboboxProps {
  /** Controlled ticker value (e.g. Data tab form). Omit for search-only mode. */
  value?: string;
  onChange?: (ticker: string) => void;
  onSelect: (ticker: string, suggestion: SecuritySuggestion) => void;
  variant?: "default" | "bbg";
  placeholder?: string;
  width?: number | string;
  /** BBG variant label prefix (default "Ticker"). */
  label?: string;
  /** Clear the input after picking a result. Defaults to true when uncontrolled. */
  clearOnSelect?: boolean;
}

export function TickerSearchCombobox({
  value,
  onChange,
  onSelect,
  variant = "default",
  placeholder,
  width,
  label = "Ticker",
  clearOnSelect,
}: TickerSearchComboboxProps) {
  const isBbg = variant === "bbg";
  const controlled = value !== undefined;
  const shouldClearOnSelect = clearOnSelect ?? !controlled;

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value ?? "");
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    if (controlled && !value) setQuery("");
    if (controlled && value) setQuery(value);
  }, [controlled, value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    onChange?.(v.toUpperCase());
    setOpen(true);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQ(v), 200);
  };

  const { data: rawSuggestions } = useQuery<SecuritySuggestion[]>({
    queryKey: ["sec-search", debouncedQ],
    queryFn: () =>
      fetch(`/api/analysis/securities/search?q=${encodeURIComponent(debouncedQ)}`)
        .then((r) => r.json())
        .then((d) => (Array.isArray(d) ? d : [])),
    enabled: debouncedQ.length > 0,
    staleTime: 30_000,
  });
  const suggestions: SecuritySuggestion[] = Array.isArray(rawSuggestions)
    ? rawSuggestions
    : [];

  const pick = (s: SecuritySuggestion) => {
    if (shouldClearOnSelect) {
      setQuery("");
      onChange?.("");
    } else {
      setQuery(s.ticker);
      onChange?.(s.ticker);
    }
    setOpen(false);
    onSelect(s.ticker, s);
  };

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const resolvedPlaceholder =
    placeholder ?? (isBbg ? "Search ticker…" : "AAPL");
  const containerStyle = {
    position: "relative" as const,
    width: width ?? (isBbg ? 200 : "100%"),
    flexShrink: isBbg ? 0 : undefined,
  };

  if (isBbg) {
    return (
      <div className="bb-ticker-search-wrap" style={{ flexShrink: 0 }}>
        <span className="bb-ticker-search__label">{label}</span>
        <div
          ref={containerRef}
          className="bb-ticker-search"
          style={containerStyle}
        >
          <input
            type="text"
            value={query}
            onChange={handleChange}
            onFocus={() => query.length > 0 && setOpen(true)}
            placeholder={resolvedPlaceholder}
            autoComplete="off"
            aria-label="Search ticker"
            className="bb-ticker-search__input"
          />
          <span className="bb-ticker-search__arrow" aria-hidden="true">
            <span className="bb-ticker-search__arrow-icon" />
          </span>
          {open && suggestions.length > 0 && (
            <ul className="bb-ticker-search__dropdown" role="listbox">
              {suggestions.map((s) => (
                <li
                  key={s.ticker}
                  role="option"
                  onMouseDown={() => pick(s)}
                  className="bb-ticker-search__option"
                >
                  <div className="bb-ticker-search__option-main">
                    <span className="bb-ticker-search__option-ticker">
                      {s.ticker}
                    </span>
                    {s.isBenchmark && (
                      <span className="bb-ticker-search__option-index">
                        INDEX
                      </span>
                    )}
                  </div>
                  <span className="bb-ticker-search__option-meta">
                    {s.name}
                    {s.sector ? `   ·   ${s.sector}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={containerStyle}>
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => query.length > 0 && setOpen(true)}
        placeholder={resolvedPlaceholder}
        autoComplete="off"
        style={{
          width: "100%",
          padding: "6px 10px",
          borderRadius: 6,
          border: "1px solid var(--bg-border)",
          background: "var(--bg-elevated)",
          color: "var(--text-primary)",
          fontSize: 13,
          boxSizing: "border-box",
          fontFamily: "var(--font-mono, monospace)",
        }}
      />
      {open && suggestions.length > 0 && (
        <ul
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            zIndex: 50,
            margin: 0,
            padding: 0,
            listStyle: "none",
            background: "var(--bg-panel, #1a2332)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
            maxHeight: 260,
            overflowY: "auto",
          }}
          role="listbox"
        >
          {suggestions.map((s) => (
            <li
              key={s.ticker}
              role="option"
              onMouseDown={() => pick(s)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                cursor: "pointer",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.background =
                  "rgba(99,102,241,0.12)";
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.background = "transparent";
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  minWidth: 0,
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--font-mono, monospace)",
                    fontSize: 13,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    flexShrink: 0,
                  }}
                >
                  {s.ticker}
                </span>
                {s.isBenchmark && (
                  <span
                    style={{
                      fontSize: 9,
                      fontWeight: 700,
                      letterSpacing: "0.08em",
                      padding: "2px 5px",
                      borderRadius: 3,
                      background: "rgba(240,182,93,0.15)",
                      color: "#f0b65d",
                      border: "1px solid rgba(240,182,93,0.3)",
                      flexShrink: 0,
                    }}
                  >
                    INDEX
                  </span>
                )}
              </div>
              <span
                style={{
                  fontSize: 12,
                  color: "var(--text-secondary)",
                  textAlign: "right",
                  marginLeft: 12,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: 180,
                }}
              >
                {s.name}
                {s.sector ? `   ·   ${s.sector}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
