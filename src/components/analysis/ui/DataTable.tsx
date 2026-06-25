"use client";
import { useState, useMemo, type ReactNode } from "react";

export interface Column<T> {
  key: string;
  label: ReactNode;
  align?: "left" | "right" | "center";
  render?: (row: T) => React.ReactNode;
  sortValue?: (row: T) => number | string;
  colorize?: (row: T) => "positive" | "negative" | "warning" | "neutral" | null;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T) => string;
  searchable?: boolean;
  searchFields?: (row: T) => string;
  pageSize?: number;
  exportFilename?: string;
  /** Pinned summary row — excluded from search, sort, and pagination. */
  footerRow?: T;
}

function labelToCsvHeader(label: ReactNode): string {
  if (typeof label === "string" || typeof label === "number") return String(label);
  return "";
}

function exportCsv<T>(columns: Column<T>[], rows: T[], filename: string) {
  const header = columns.map((c) => labelToCsvHeader(c.label)).join(",");
  const body = rows
    .map((row) =>
      columns
        .map((c) => {
          const raw = c.render ? "" : (row as Record<string, unknown>)[c.key];
          return `"${String(raw ?? "").replace(/"/g, '""')}"`;
        })
        .join(","),
    )
    .join("\n");
  const blob = new Blob([header + "\n" + body], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "export.csv";
  a.click();
  URL.revokeObjectURL(url);
}

const SEMANTIC: Record<string, string> = {
  positive: "var(--color-positive)",
  negative: "var(--color-negative)",
  warning: "var(--color-warning)",
  neutral: "var(--color-neutral)",
};

const btnFlat = {
  padding: "3px 8px",
  borderRadius: 0,
  border: "1px solid var(--chrome-border)",
  background: "var(--bg-base)",
  fontSize: 11,
} as const;

export function DataTable<T>({
  columns,
  rows,
  getRowKey,
  searchable = true,
  searchFields,
  pageSize = 25,
  exportFilename = "export.csv",
  footerRow,
}: DataTableProps<T>) {
  const [search, setSearch] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    if (!search || !searchFields) return rows;
    const q = search.toLowerCase();
    return rows.filter((r) => searchFields(r).toLowerCase().includes(q));
  }, [rows, search, searchFields]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sortValue!(a);
      const bv = col.sortValue!(b);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir, columns]);

  const paged = useMemo(
    () => sorted.slice(page * pageSize, (page + 1) * pageSize),
    [sorted, page, pageSize],
  );
  const totalPages = Math.ceil(sorted.length / pageSize);

  const handleSort = (key: string) => {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
    setPage(0);
  };

  const renderDataRow = (row: T, isFooter: boolean) => (
    <tr
      key={isFooter ? `footer-${getRowKey(row)}` : getRowKey(row)}
      style={
        isFooter
          ? { borderTop: "2px solid var(--color-accent)" }
          : { borderBottom: "1px solid var(--bg-border)" }
      }
    >
      {columns.map((col, colIdx) => {
        const colorKey = col.colorize?.(row);
        const cellColor = colorKey ? SEMANTIC[colorKey] : undefined;
        const isNum = col.align === "right";
        return (
          <td
            key={col.key}
            className={isNum ? "bb-num" : undefined}
            style={{
              textAlign: col.align ?? "left",
              color: cellColor ?? (isFooter && colIdx === 0 ? "var(--color-accent)" : "#fff"),
              fontFamily: isNum ? "var(--font-mono, monospace)" : undefined,
              fontVariantNumeric: isNum ? "tabular-nums" : undefined,
              fontWeight: isFooter ? 700 : undefined,
              background: isFooter ? "rgba(240,182,93,0.10)" : undefined,
              letterSpacing: isFooter && colIdx === 0 ? "0.06em" : undefined,
            }}
          >
            {col.render
              ? col.render(row)
              : String((row as Record<string, unknown>)[col.key] ?? "")}
          </td>
        );
      })}
    </tr>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {(searchable || exportFilename) && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {searchable && (
            <input
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(0);
              }}
              placeholder="Search…"
              style={{
                flex: 1,
                padding: "0 6px",
                height: 18,
                borderRadius: 0,
                border: "1px solid var(--bg-border)",
                background: "var(--bg-elevated)",
                color: "var(--text-primary)",
                fontSize: 12,
                outline: "none",
              }}
            />
          )}
          <button
            type="button"
            onClick={() =>
              exportCsv(
                columns,
                footerRow ? [...sorted, footerRow] : sorted,
                exportFilename,
              )
            }
            style={{
              ...btnFlat,
              color: "var(--text-secondary)",
              cursor: "pointer",
            }}
          >
            ↓ CSV
          </button>
        </div>
      )}

      <div
        style={{
          overflowX: "auto",
          borderRadius: 0,
          border: "1px solid var(--bg-border)",
        }}
      >
        <table
          className="data-table"
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 12,
          }}
        >
          <thead>
            <tr
              style={{
                background: "var(--bg-surface)",
                position: "sticky",
                top: 0,
              }}
            >
              {columns.map((col) => (
                <th
                  key={col.key}
                  onClick={() => col.sortValue && handleSort(col.key)}
                  style={{
                    padding: "7px 8px",
                    textAlign: col.align ?? "left",
                    fontSize: 12,
                    fontWeight: 700,
                    color: "var(--text-primary)",
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    cursor: col.sortValue ? "pointer" : "default",
                    whiteSpace: "normal",
                    lineHeight: 1.2,
                    borderBottom: "1px solid var(--bg-border)",
                    userSelect: "none",
                  }}
                >
                  {col.label}
                  {sortKey === col.key && (
                    <span style={{ marginLeft: 4, fontSize: 9 }}>{sortDir === "asc" ? "▲" : "▼"}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paged.map((row) => renderDataRow(row, false))}
            {footerRow && renderDataRow(footerRow, true)}
            {paged.length === 0 && !footerRow && (
              <tr>
                <td
                  colSpan={columns.length}
                  style={{
                    padding: 24,
                    textAlign: "center",
                    color: "var(--text-muted)",
                    fontSize: 12,
                  }}
                >
                  No data
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, alignItems: "center" }}>
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, sorted.length)} of {sorted.length}
          </span>
          <button
            type="button"
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            style={{
              ...btnFlat,
              color: page === 0 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: page === 0 ? "not-allowed" : "pointer",
            }}
          >
            ←
          </button>
          <button
            type="button"
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page >= totalPages - 1}
            style={{
              ...btnFlat,
              color: page >= totalPages - 1 ? "var(--text-muted)" : "var(--text-secondary)",
              cursor: page >= totalPages - 1 ? "not-allowed" : "pointer",
            }}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
