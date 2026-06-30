"use client";

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { getUsMarketSession } from "@/lib/market-map/market-session";
import type { PortfolioNewsResult } from "@/server/services/portfolio-news.service";

export interface PortfolioNewsProps {
  portfolioId: string | null;
}

const PAGE_SIZE = 10;
const MAX_ARTICLES = 40;

function formatPublished(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

const cellBase: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--bg-border)",
  verticalAlign: "middle",
  fontSize: 12,
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 0,
};

export function PortfolioNews({ portfolioId }: PortfolioNewsProps) {
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [portfolioId]);

  const { data, isLoading, error } = useQuery<PortfolioNewsResult>({
    queryKey: ["portfolio-news", portfolioId],
    queryFn: async () => {
      const r = await fetch(
        `/api/analysis/portfolio/news?portfolioId=${portfolioId}&limit=${MAX_ARTICLES}`,
      );
      if (!r.ok) {
        throw new Error(
          (await r.json().catch(() => ({}))).error ?? "Failed to load news",
        );
      }
      return r.json();
    },
    enabled: !!portfolioId,
    staleTime: 5 * 60_000,
    refetchInterval: () =>
      getUsMarketSession(new Date()) === "REGULAR" ? 60_000 : 300_000,
  });

  const rows = data?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  const pageRows = rows.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <ChartCard title="Market News">
      {isLoading ? (
        <div style={msgStyle}>Loading news.</div>
      ) : error ? (
        <div style={{ ...msgStyle, color: "var(--color-negative)" }}>
          {error instanceof Error ? error.message : "Failed to load news."}
        </div>
      ) : rows.length === 0 ? (
        <div style={msgStyle}>No recent news found for this portfolio&apos;s holdings.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: 64 }} />
                <col style={{ width: 180 }} />
                <col style={{ width: "32%" }} />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <th style={headStyle}>Ticker</th>
                  <th style={headStyle}>Company</th>
                  <th style={headStyle}>Title</th>
                  <th style={headStyle}>Preview</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => (
                  <tr key={`${row.url}-${i}`}>
                    <td
                      style={{
                        ...cellBase,
                        fontFamily: "var(--font-mono, monospace)",
                        fontWeight: 700,
                        color: "var(--color-accent)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {row.ticker}
                    </td>
                    <td style={{ ...cellBase, color: "var(--text-secondary)" }} title={row.companyName}>
                      {row.companyName}
                    </td>
                    <td
                      style={{ ...cellBase }}
                      title={[
                        row.title,
                        [row.site || row.publisher, formatPublished(row.publishedDate)]
                          .filter(Boolean)
                          .join(" · "),
                      ]
                        .filter(Boolean)
                        .join("\n")}
                    >
                      {row.isPressRelease && <span style={prChipStyle}>PR</span>}
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        style={{ color: "var(--text-primary)", fontWeight: 600, textDecoration: "none" }}
                      >
                        {row.title}
                      </a>
                    </td>
                    <td style={{ ...cellBase, color: "var(--text-secondary)" }} title={row.preview}>
                      {row.preview || <span style={{ color: "var(--text-muted)" }}>—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {rows.length > PAGE_SIZE ? (
            <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, color: "var(--text-muted)" }}>
              <button
                type="button"
                className="bb-tab"
                disabled={safePage <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                style={{ border: "1px solid var(--chrome-border)", opacity: safePage <= 1 ? 0.4 : 1 }}
              >
                Prev
              </button>
              <span>
                Page {safePage} of {totalPages} · showing {(safePage - 1) * PAGE_SIZE + 1}–
                {Math.min(safePage * PAGE_SIZE, rows.length)} of {rows.length}
              </span>
              <button
                type="button"
                className="bb-tab"
                disabled={safePage >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                style={{ border: "1px solid var(--chrome-border)", opacity: safePage >= totalPages ? 0.4 : 1 }}
              >
                Next
              </button>
            </div>
          ) : null}
        </div>
      )}
    </ChartCard>
  );
}

const prChipStyle: React.CSSProperties = {
  display: "inline-block",
  marginRight: 6,
  padding: "0 4px",
  fontSize: 9,
  fontWeight: 700,
  letterSpacing: "0.05em",
  color: "var(--bb-chrome-text, #fff)",
  background: "var(--color-accent)",
  borderRadius: 2,
  verticalAlign: "middle",
};

const msgStyle: React.CSSProperties = {
  padding: 32,
  textAlign: "center",
  color: "var(--text-secondary)",
  fontSize: 12,
};

const headStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "5px 10px",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  color: "var(--text-muted)",
  borderBottom: "1px solid var(--bg-border)",
  position: "sticky",
  top: 0,
  background: "var(--bg-base)",
};
