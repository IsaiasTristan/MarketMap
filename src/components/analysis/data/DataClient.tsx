"use client";
import { useState, useRef, useCallback, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { Card, CardLabel, SectionHeading } from "@/components/analysis/ui/Card";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { StatusBadge } from "@/components/analysis/ui/StatusBadge";
import { Skeleton } from "@/components/analysis/ui/Skeleton";

// -- Portfolio manager ------------------------------------------------------

interface PortfolioRow {
  id: string;
  name: string;
  createdAt: string;
}

interface PositionDetail {
  id: string;
  ticker: string;
  name: string;
  shares: number;
  isShort: boolean;
  sector: string | null;
}

function PortfolioManager() {
  const { activePortfolioId, setActivePortfolio, addToast } = useAnalysisStore();
  const qc = useQueryClient();

  // Create new portfolio
  const [newName, setNewName] = useState("");

  // Rename state
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");

  // Delete portfolio confirm
  const [confirmDeletePortfolio, setConfirmDeletePortfolio] = useState(false);

  // Delete position confirm (stores position id)
  const [confirmDeletePositionId, setConfirmDeletePositionId] = useState<string | null>(null);

  // Inline edit state
  const [editingPositionId, setEditingPositionId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<{
    shares: string;
    isShort: boolean;
    sector: string;
  }>({ shares: "", isShort: false, sector: "" });

  const startEdit = (pos: PositionDetail) => {
    setEditingPositionId(pos.id);
    setEditDraft({
      shares: String(pos.shares),
      isShort: pos.isShort,
      sector: pos.sector ?? "",
    });
    setConfirmDeletePositionId(null);
  };

  const cancelEdit = () => setEditingPositionId(null);

  const updatePositionMut = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Record<string, unknown> }) =>
      fetch(`/api/analysis/portfolio/positions?id=${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["positions", activePortfolioId] });
      qc.invalidateQueries({ queryKey: ["pnl", activePortfolioId] });
      setEditingPositionId(null);
      addToast({ severity: "success", message: "Position updated" });
    },
    onError: () => addToast({ severity: "error", message: "Update failed" }),
  });

  const saveEdit = (id: string) => {
    updatePositionMut.mutate({
      id,
      patch: {
        shares: parseFloat(editDraft.shares),
        isShort: editDraft.isShort,
        sector: editDraft.sector || null,
      },
    });
  };

  const { data: portfolios = [] } = useQuery<PortfolioRow[]>({
    queryKey: ["portfolios-list"],
    queryFn: () => fetch("/api/analysis/portfolios").then((r) => r.json()),
  });

  const { data: positions = [], isLoading: posLoading } = useQuery<PositionDetail[]>({
    queryKey: ["positions", activePortfolioId],
    queryFn: () =>
      fetch(`/api/analysis/portfolio/positions?portfolioId=${activePortfolioId}`).then((r) =>
        r.json(),
      ),
    enabled: !!activePortfolioId,
  });

  const activePortfolio = portfolios.find((p) => p.id === activePortfolioId) ?? null;

  // Start rename -- pre-fill with current name
  const startRename = () => {
    setRenameValue(activePortfolio?.name ?? "");
    setRenaming(true);
    setConfirmDeletePortfolio(false);
  };

  const createMut = useMutation({
    mutationFn: (name: string) =>
      fetch("/api/analysis/portfolios", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((r) => r.json()),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["portfolios-list"] });
      setActivePortfolio(d.id);
      setNewName("");
    },
  });

  const renameMut = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      fetch(`/api/analysis/portfolios/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolios-list"] });
      setRenaming(false);
      addToast({ severity: "success", message: "Portfolio renamed" });
    },
    onError: () => addToast({ severity: "error", message: "Rename failed" }),
  });

  const deletePortfolioMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/analysis/portfolios/${id}`, { method: "DELETE" }).then((r) => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolios-list"] });
      setActivePortfolio(null as unknown as string);
      setConfirmDeletePortfolio(false);
      addToast({ severity: "success", message: "Portfolio deleted" });
    },
    onError: () => addToast({ severity: "error", message: "Delete failed" }),
  });

  const deletePositionMut = useMutation({
    mutationFn: (posId: string) =>
      fetch(`/api/analysis/portfolio/positions?id=${posId}`, { method: "DELETE" }).then((r) =>
        r.json(),
      ),
    onSuccess: (_, posId) => {
      qc.invalidateQueries({ queryKey: ["positions", activePortfolioId] });
      qc.invalidateQueries({ queryKey: ["pnl", activePortfolioId] });
      setConfirmDeletePositionId(null);
      const pos = positions.find((p) => p.id === posId);
      addToast({ severity: "success", message: `${pos?.ticker ?? "Position"} removed` });
    },
    onError: () => addToast({ severity: "error", message: "Failed to remove position" }),
  });

  const sharedInputStyle: React.CSSProperties = {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--bg-border)",
    background: "var(--bg-elevated)",
    color: "var(--text-primary)",
    fontSize: 13,
  };

  const btnBase: React.CSSProperties = {
    padding: "6px 14px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 500,
  };

  return (
    <Card>
      <SectionHeading>Portfolios</SectionHeading>

      {/* Portfolio tab buttons */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14 }}>
        {portfolios.map((p) => (
          <button
            key={p.id}
            onClick={() => {
              setActivePortfolio(p.id);
              setRenaming(false);
              setConfirmDeletePortfolio(false);
              setConfirmDeletePositionId(null);
            }}
            style={{
              ...btnBase,
              border: `1px solid ${activePortfolioId === p.id ? "var(--color-accent)" : "var(--bg-border)"}`,
              background: activePortfolioId === p.id ? "var(--color-accent)" : "transparent",
              color: activePortfolioId === p.id ? "var(--bg-base)" : "var(--text-secondary)",
            }}
          >
            {p.name}
          </button>
        ))}
        {portfolios.length === 0 && (
          <span style={{ fontSize: 13, color: "var(--text-muted)" }}>No portfolios yet</span>
        )}
      </div>

      {/* Create new portfolio */}
      <div style={{ display: "flex", gap: 8, marginBottom: activePortfolio ? 20 : 0 }}>
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="New portfolio name..."
          style={{ ...sharedInputStyle, flex: 1 }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && newName.trim()) createMut.mutate(newName.trim());
          }}
        />
        <button
          onClick={() => newName.trim() && createMut.mutate(newName.trim())}
          disabled={createMut.isPending}
          style={{ ...btnBase, border: "none", background: "var(--color-accent)", color: "var(--bg-base)" }}
        >
          Create
        </button>
      </div>

      {/* -- Portfolio detail panel -- */}
      {activePortfolio && (
        <div
          style={{
            borderTop: "1px solid var(--bg-border)",
            paddingTop: 16,
          }}
        >
          {/* Header row: name + actions */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 14,
              flexWrap: "wrap",
            }}
          >
            {renaming ? (
              <>
                <input
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  autoFocus
                  style={{ ...sharedInputStyle, minWidth: 200 }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && renameValue.trim())
                      renameMut.mutate({ id: activePortfolio.id, name: renameValue.trim() });
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <button
                  onClick={() =>
                    renameValue.trim() &&
                    renameMut.mutate({ id: activePortfolio.id, name: renameValue.trim() })
                  }
                  disabled={renameMut.isPending}
                  style={{
                    ...btnBase,
                    border: "none",
                    background: "var(--color-accent)",
                    color: "var(--bg-base)",
                  }}
                >
                  Save
                </button>
                <button
                  onClick={() => setRenaming(false)}
                  style={{
                    ...btnBase,
                    border: "1px solid var(--bg-border)",
                    background: "transparent",
                    color: "var(--text-secondary)",
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span
                  style={{ fontSize: 15, fontWeight: 600, color: "var(--text-primary)", flex: 1 }}
                >
                  {activePortfolio.name}
                  <span style={{ fontSize: 11, color: "var(--text-muted)", marginLeft: 8, fontWeight: 400 }}>
                    {positions.length} position{positions.length !== 1 ? "s" : ""}
                  </span>
                </span>
                <button
                  onClick={startRename}
                  style={{
                    ...btnBase,
                    border: "1px solid var(--bg-border)",
                    background: "transparent",
                    color: "var(--text-secondary)",
                  }}
                >
                  Rename
                </button>
                {confirmDeletePortfolio ? (
                  <>
                    <span style={{ fontSize: 12, color: "var(--color-negative)" }}>
                      Delete &ldquo;{activePortfolio.name}&rdquo;? This cannot be undone.
                    </span>
                    <button
                      onClick={() => deletePortfolioMut.mutate(activePortfolio.id)}
                      disabled={deletePortfolioMut.isPending}
                      style={{
                        ...btnBase,
                        border: "none",
                        background: "var(--color-negative)",
                        color: "#fff",
                      }}
                    >
                      Confirm Delete
                    </button>
                    <button
                      onClick={() => setConfirmDeletePortfolio(false)}
                      style={{
                        ...btnBase,
                        border: "1px solid var(--bg-border)",
                        background: "transparent",
                        color: "var(--text-secondary)",
                      }}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => setConfirmDeletePortfolio(true)}
                    style={{
                      ...btnBase,
                      border: "1px solid var(--color-negative, #ef4444)",
                      background: "transparent",
                      color: "var(--color-negative, #ef4444)",
                    }}
                  >
                    Delete Portfolio
                  </button>
                )}
              </>
            )}
          </div>

          {/* Positions table */}
          {posLoading ? (
            <div style={{ fontSize: 13, color: "var(--text-muted)", padding: "12px 0" }}>
              Loading positions...
            </div>
          ) : positions.length === 0 ? (
            <div
              style={{
                fontSize: 13,
                color: "var(--text-muted)",
                padding: "20px 0",
                textAlign: "center",
              }}
            >
              No positions yet -- add one below or upload a CSV.
            </div>
          ) : (
            <div style={{ overflowX: "auto", borderRadius: 2, border: "1px solid var(--bg-border)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "var(--bg-elevated)" }}>
                    {["Ticker", "Name", "Shares", "L / S", "Sector", "", ""].map(
                      (h, i) => (
                        <th
                          key={`${h}-${i}`}
                          style={{
                            padding: "9px 12px",
                            textAlign: h === "" ? "center" : "left",
                            fontSize: 11,
                            fontWeight: 600,
                            color: "var(--text-secondary)",
                            textTransform: "uppercase",
                            letterSpacing: "0.04em",
                            borderBottom: "1px solid var(--bg-border)",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {positions.map((pos, i) => {
                    const isConfirming = confirmDeletePositionId === pos.id;
                    const isEditing = editingPositionId === pos.id;
                    const editInput = (mono = false): React.CSSProperties => ({
                      padding: "4px 6px",
                      borderRadius: 4,
                      border: "1px solid var(--bg-border)",
                      background: "var(--bg-surface)",
                      color: "var(--text-primary)",
                      fontSize: 12,
                      fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
                      width: "100%",
                      boxSizing: "border-box" as const,
                    });
                    return (
                      <tr
                        key={pos.id}
                        style={{
                          background: isEditing
                            ? "rgba(99,102,241,0.06)"
                            : i % 2 === 0 ? "var(--bg-surface)" : "var(--bg-base)",
                          borderBottom: "1px solid var(--bg-border)",
                        }}
                      >
                        {/* Ticker — never editable */}
                        <td style={{ padding: "8px 12px", fontFamily: "var(--font-mono, monospace)", fontWeight: 700, color: "var(--text-primary)" }}>
                          {pos.ticker}
                        </td>
                        {/* Name */}
                        <td style={{ padding: "8px 12px", color: "var(--text-secondary)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {pos.name}
                        </td>
                        {/* Shares */}
                        <td style={{ padding: "4px 8px", textAlign: "right" }}>
                          {isEditing ? (
                            <input type="number" min={0} step="any" value={editDraft.shares}
                              onChange={(e) => setEditDraft((d) => ({ ...d, shares: e.target.value }))}
                              style={editInput(true)} />
                          ) : (
                            <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--text-primary)" }}>
                              {pos.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                            </span>
                          )}
                        </td>
                        {/* L / S direction */}
                        <td style={{ padding: "4px 8px", textAlign: "center" }}>
                          {isEditing ? (
                            <select
                              value={editDraft.isShort ? "S" : "L"}
                              onChange={(e) => setEditDraft((d) => ({ ...d, isShort: e.target.value === "S" }))}
                              style={{ ...editInput(true), background: editDraft.isShort ? "rgba(239,68,68,0.08)" : "var(--bg-surface)", textAlign: "center", width: 56 }}
                            >
                              <option value="L">L</option>
                              <option value="S">S</option>
                            </select>
                          ) : (
                            <span
                              style={{
                                fontFamily: "var(--font-mono, monospace)",
                                fontWeight: 700,
                                color: pos.isShort ? "var(--color-negative, #ef4444)" : "var(--color-positive, #22c55e)",
                                padding: "2px 8px",
                                borderRadius: 3,
                                background: pos.isShort ? "rgba(239,68,68,0.10)" : "rgba(34,197,94,0.10)",
                              }}
                              title={pos.isShort ? "Short — gains when price drops" : "Long — gains when price rises"}
                            >
                              {pos.isShort ? "S" : "L"}
                            </span>
                          )}
                        </td>
                        {/* Sector */}
                        <td style={{ padding: "4px 8px" }}>
                          {isEditing ? (
                            <input type="text" value={editDraft.sector}
                              onChange={(e) => setEditDraft((d) => ({ ...d, sector: e.target.value }))}
                              placeholder="e.g. Technology"
                              style={editInput()} />
                          ) : (
                            <span style={{ color: "var(--text-muted)" }}>{pos.sector ?? "—"}</span>
                          )}
                        </td>
                        {/* Edit / Save-Cancel */}
                        <td style={{ padding: "4px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                          {isEditing ? (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <button onClick={() => saveEdit(pos.id)} disabled={updatePositionMut.isPending}
                                style={{ padding: "3px 10px", borderRadius: 4, border: "none", background: "var(--color-accent)", color: "var(--bg-base)", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                                Save
                              </button>
                              <button onClick={cancelEdit}
                                style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--bg-border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11 }}>
                                ✕
                              </button>
                            </span>
                          ) : (
                            <button onClick={() => { setConfirmDeletePositionId(null); startEdit(pos); }}
                              title={`Edit ${pos.ticker}`}
                              style={{ padding: "3px 10px", borderRadius: 4, border: "1px solid var(--bg-border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11, fontWeight: 500 }}>
                              Edit
                            </button>
                          )}
                        </td>
                        {/* Delete */}
                        <td style={{ padding: "4px 8px", textAlign: "center", whiteSpace: "nowrap" }}>
                          {isEditing ? null : isConfirming ? (
                            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                              <button onClick={() => deletePositionMut.mutate(pos.id)} disabled={deletePositionMut.isPending}
                                style={{ padding: "3px 10px", borderRadius: 4, border: "none", background: "var(--color-negative, #ef4444)", color: "#fff", cursor: "pointer", fontSize: 11, fontWeight: 600 }}>
                                Remove
                              </button>
                              <button onClick={() => setConfirmDeletePositionId(null)}
                                style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid var(--bg-border)", background: "transparent", color: "var(--text-secondary)", cursor: "pointer", fontSize: 11 }}>
                                ✕
                              </button>
                            </span>
                          ) : (
                            <button onClick={() => { setEditingPositionId(null); setConfirmDeletePositionId(pos.id); }}
                              title={`Remove ${pos.ticker}`}
                              style={{ padding: "3px 8px", borderRadius: 4, border: "1px solid transparent", background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 14, lineHeight: 1 }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--color-negative, #ef4444)"; (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--color-negative, #ef4444)"; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = "var(--text-muted)"; (e.currentTarget as HTMLButtonElement).style.borderColor = "transparent"; }}>
                              ×
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// -- CSV Upload -------------------------------------------------------

function CsvUpload() {
  const { activePortfolioId, addToast } = useAnalysisStore();
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<{
    imported?: number;
    parseErrors?: string[];
    importErrors?: string[];
  } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    if (!activePortfolioId) {
      addToast({ severity: "warning", message: "Please select a portfolio first" });
      return;
    }
    const fd = new FormData();
    fd.append("file", file);
    fd.append("portfolioId", activePortfolioId);
    const r = await fetch("/api/analysis/portfolio/upload", { method: "POST", body: fd });
    const d = await r.json();
    setResult(d);
    if (d.imported > 0) {
      addToast({ severity: "success", message: `${d.imported} positions loaded successfully` });
    }
    if (d.error) addToast({ severity: "error", message: d.error });
  };

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) upload(f);
  }, [activePortfolioId]);

  return (
    <Card>
      <SectionHeading>Upload Portfolio CSV</SectionHeading>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        Required columns: <code>ticker, shares</code>. Optional:{" "}
        <code>direction</code> (L or S; defaults to L), <code>sector</code>.
      </div>
      <div
        onDragEnter={() => setDragging(true)}
        onDragLeave={() => setDragging(false)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        style={{
          border: `2px dashed ${dragging ? "var(--color-accent)" : "var(--bg-border)"}`,
          borderRadius: 2,
          padding: "32px 24px",
          textAlign: "center",
          cursor: "pointer",
          background: dragging ? "rgba(99,102,241,0.05)" : "transparent",
          transition: "all 0.15s",
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}></div>
        <div style={{ fontSize: 14, color: "var(--text-primary)", fontWeight: 600 }}>
          Drop CSV here or click to browse
        </div>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 4 }}>
          CSV or TSV, up to 10MB
        </div>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.tsv,.txt"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload(f);
          }}
        />
      </div>

      {result && (
        <div style={{ marginTop: 12 }}>
          {result.imported != null && (
            <StatusBadge
              severity={result.imported > 0 ? "ok" : "warning"}
              label={`${result.imported} positions imported`}
            />
          )}
          {[...(result.parseErrors ?? []), ...(result.importErrors ?? [])].map((e, i) => (
            <div key={i} style={{ fontSize: 12, color: "var(--color-warning)", marginTop: 4 }}>
              {e}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// -- Ticker autocomplete ----------------------------------------------------

interface SecuritySuggestion {
  ticker: string;
  name: string;
  sector: string | null;
  isBenchmark: boolean;
}

interface TickerComboboxProps {
  value: string;
  onChange: (ticker: string) => void;
  onSelect: (s: SecuritySuggestion) => void;
}

function TickerCombobox({ value, onChange, onSelect }: TickerComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState(value);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQ, setDebouncedQ] = useState("");

  // Sync external value reset (e.g. after form submit)
  useEffect(() => {
    if (!value) setQuery("");
  }, [value]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    onChange(v.toUpperCase());
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
  const suggestions: SecuritySuggestion[] = Array.isArray(rawSuggestions) ? rawSuggestions : [];

  const pick = (s: SecuritySuggestion) => {
    setQuery(s.ticker);
    setOpen(false);
    onSelect(s);
  };

  // Close on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => query.length > 0 && setOpen(true)}
        placeholder="AAPL"
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
        >
          {suggestions.map((s) => (
            <li
              key={s.ticker}
              onMouseDown={() => pick(s)}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                padding: "8px 12px",
                cursor: "pointer",
                borderBottom: "1px solid rgba(255,255,255,0.04)",
              }}
              onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.background = "rgba(99,102,241,0.12)")}
              onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.background = "transparent")}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                <span style={{ fontFamily: "var(--font-mono, monospace)", fontSize: 13, fontWeight: 700, color: "var(--text-primary)", flexShrink: 0 }}>
                  {s.ticker}
                </span>
                {s.isBenchmark && (
                  <span style={{
                    fontSize: 9,
                    fontWeight: 700,
                    letterSpacing: "0.08em",
                    padding: "2px 5px",
                    borderRadius: 3,
                    background: "rgba(240,182,93,0.15)",
                    color: "#f0b65d",
                    border: "1px solid rgba(240,182,93,0.3)",
                    flexShrink: 0,
                  }}>
                    INDEX
                  </span>
                )}
              </div>
              <span style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "right", marginLeft: 12, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 180 }}>
                {s.name}{s.sector ? `   ·   ${s.sector}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// -- Manual position entry --------------------------------------------------

function ManualEntry() {
  const { activePortfolioId, addToast } = useAnalysisStore();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    ticker: "",
    shares: "",
    isShort: false,
    sector: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePortfolioId) {
      addToast({ severity: "warning", message: "Select a portfolio first" });
      return;
    }
    const r = await fetch("/api/analysis/portfolio/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        portfolioId: activePortfolioId,
        ticker: form.ticker.toUpperCase(),
        shares: parseFloat(form.shares),
        isShort: form.isShort,
        sector: form.sector || undefined,
      }),
    });
    if (r.ok) {
      addToast({ severity: "success", message: `${form.ticker.toUpperCase()} added` });
      qc.invalidateQueries({ queryKey: ["positions", activePortfolioId] });
      setForm({ ticker: "", shares: "", isShort: false, sector: form.sector });
    } else {
      const text = await r.text();
      let message = `Failed to add position (${r.status})`;
      if (text) {
        try {
          const d = JSON.parse(text);
          message = d.error ?? message;
        } catch {
          message = text.slice(0, 200);
        }
      }
      addToast({ severity: "error", message });
    }
  };

  const field = (label: string, children: React.ReactNode) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 11, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}
      </label>
      {children}
    </div>
  );

  const inputStyle = (mono = false): React.CSSProperties => ({
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--bg-border)",
    background: "var(--bg-elevated)",
    color: "var(--text-primary)",
    fontSize: 13,
    fontFamily: mono ? "var(--font-mono, monospace)" : "inherit",
  });

  return (
    <Card>
      <SectionHeading>Add Position Manually</SectionHeading>
      <form onSubmit={handleSubmit} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr 0.6fr 1fr", gap: 12 }}>

        {field("Ticker",
          <TickerCombobox
            value={form.ticker}
            onChange={(t) => setForm((f) => ({ ...f, ticker: t }))}
            onSelect={(s) => {
              setForm((f) => ({ ...f, ticker: s.ticker, sector: s.sector ?? f.sector }));
            }}
          />
        )}

        {field("Shares",
          <input
            type="number"
            value={form.shares}
            onChange={(e) => setForm((f) => ({ ...f, shares: e.target.value }))}
            placeholder="100"
            min={0}
            step="any"
            style={inputStyle(true)}
          />
        )}

        {field("L / S",
          <select
            value={form.isShort ? "S" : "L"}
            onChange={(e) => setForm((f) => ({ ...f, isShort: e.target.value === "S" }))}
            style={{
              ...inputStyle(true),
              textAlign: "center",
              background: form.isShort ? "rgba(239,68,68,0.08)" : "var(--bg-elevated)",
            }}
            title="L = long (gains when price rises). S = short (gains when price drops)."
          >
            <option value="L">L</option>
            <option value="S">S</option>
          </select>
        )}

        {field("Sector (optional)",
          <input
            type="text"
            value={form.sector}
            onChange={(e) => setForm((f) => ({ ...f, sector: e.target.value }))}
            placeholder="Technology"
            style={inputStyle()}
          />
        )}

        <div style={{ gridColumn: "1/-1", display: "flex", justifyContent: "flex-end" }}>
          <button
            type="submit"
            style={{
              padding: "8px 20px",
              borderRadius: 2,
              border: "none",
              background: "var(--color-accent)",
              color: "var(--bg-base)",
              cursor: "pointer",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Add Position
          </button>
        </div>
      </form>
    </Card>
  );
}

// -- Demo portfolio ---------------------------------------------------------

function DemoLoader() {
  const { addToast, setActivePortfolio } = useAnalysisStore();
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/analysis/portfolio/demo", { method: "POST" });
      const d = await r.json();
      setActivePortfolio(d.portfolioId);
      addToast({ severity: "success", message: `Demo portfolio loaded with ${d.imported} positions` });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card>
      <SectionHeading>Demo Portfolio</SectionHeading>
      <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: "0 0 12px" }}>
        Load a pre-built portfolio of 15 diversified positions across sectors -- no data needed to explore the app.
      </p>
      <button
        onClick={load}
        disabled={loading}
        style={{
          padding: "8px 20px",
          borderRadius: 6,
          border: "1px solid var(--color-accent)",
          background: "transparent",
          color: "var(--color-accent)",
          cursor: "pointer",
          fontSize: 13,
          fontWeight: 600,
        }}
      >
        {loading ? "Loading..." : "Load Demo Portfolio"}
      </button>
    </Card>
  );
}

// -- Data source status -----------------------------------------------------

function DataSourceStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ["data-status"],
    queryFn: () => fetch("/api/analysis/data/status").then((r) => r.json()),
    refetchInterval: 30_000,
  });

  if (isLoading) return <Skeleton height={100} />;

  const sources = [
    { label: "Price Data", info: data?.prices, source: "Yahoo Finance" },
    { label: "Risk-Free Rate", info: data?.riskFreeRate, source: "FRED TB3MS" },
    { label: "Factor Data", info: data?.factors, source: "Fama-French + ETF Proxies" },
  ];

  return (
    <Card>
      <SectionHeading>Data Source Status</SectionHeading>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {sources.map((s) => (
          <div
            key={s.label}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "10px 12px",
              background: "var(--bg-elevated)",
              borderRadius: 2,
            }}
          >
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                {s.label}
              </div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{s.source}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <StatusBadge
                severity={s.info?.lastUpdated ? "ok" : "stale"}
                label={s.info?.lastUpdated ? `Updated ${s.info.lastUpdated}` : "No data"}
              />
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

// -- Audit log -------------------------------------------------------------

const auditCols: Column<{ id: string; at: string; action: string; actor: string; payloadJson: unknown }>[] = [
  { key: "at", label: "Time", render: (r) => new Date(r.at).toLocaleString() },
  { key: "actor", label: "Actor" },
  { key: "action", label: "Action", sortValue: (r) => r.action },
  {
    key: "payloadJson",
    label: "Detail",
    render: (r) => (
      <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono, monospace)" }}>
        {JSON.stringify(r.payloadJson).slice(0, 80)}
      </span>
    ),
  },
];

function AuditLogTable() {
  const { data, isLoading } = useQuery({
    queryKey: ["data-status"],
    queryFn: () => fetch("/api/analysis/data/status").then((r) => r.json()),
  });

  if (isLoading) return <Skeleton height={200} />;
  const logs = data?.auditLog ?? [];

  return (
    <Card>
      <SectionHeading>Audit Log</SectionHeading>
      <DataTable
        columns={auditCols}
        rows={logs}
        getRowKey={(r) => r.id}
        searchFields={(r) => `${r.action} ${r.actor}`}
        pageSize={10}
        exportFilename="audit-log.csv"
      />
    </Card>
  );
}

// -- Main -------------------------------------------------------------------

export function DataClient() {
  return (
    <div style={{ maxWidth: 900, margin: "0 auto", display: "flex", flexDirection: "column", gap: 24 }}>
      <div>
        <h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--text-primary)", margin: "0 0 4px" }}>
          Data Management
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", margin: 0 }}>
          Upload your portfolio, manage positions, and monitor data sources.
        </p>
      </div>

      <PortfolioManager />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <CsvUpload />
        <DemoLoader />
      </div>
      <ManualEntry />
      <DataSourceStatus />
      <AuditLogTable />
    </div>
  );
}



