"use client";
import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAnalysisStore } from "@/store/analysis";
import { useIsAdmin } from "@/lib/api/useMe";
import { Card, CardLabel, SectionHeading } from "@/components/analysis/ui/Card";
import { DataTable, type Column } from "@/components/analysis/ui/DataTable";
import { StatusBadge } from "@/components/analysis/ui/StatusBadge";
import { Skeleton } from "@/components/analysis/ui/Skeleton";
import { TickerSearchCombobox } from "@/components/analysis/shared/TickerSearchCombobox";
import { DeferUntilVisible } from "@/components/analysis/shared/DeferUntilVisible";

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
  isCash: boolean;
  cashAmount: number | null;
}

// -- Brokerage link (SnapTrade) ---------------------------------------------

interface BrokerageSkipped {
  symbol: string | null;
  kind: string;
  reason: string;
}

interface BrokerageAccount {
  id: string;
  portfolioId: string;
  institutionName: string | null;
  accountMask: string | null;
  lastSyncAt: string | null;
  lastSyncStatus: string | null;
  lastSyncError: string | null;
  positionCount: number;
  skipped: BrokerageSkipped[];
}

interface BrokerageStatus {
  configured: boolean;
  linked: boolean;
  accounts: BrokerageAccount[];
}

function useBrokerageStatus() {
  return useQuery<BrokerageStatus>({
    queryKey: ["brokerage-status"],
    queryFn: () => fetch("/api/analysis/brokerage/status").then((r) => r.json()),
    staleTime: 30_000,
  });
}

function formatSyncTime(iso: string | null): string {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function PortfolioManager() {
  const { activePortfolioId, setActivePortfolio, addToast } = useAnalysisStore();
  const qc = useQueryClient();

  const invalidatePortfolioPnl = useCallback(() => {
    if (!activePortfolioId) return;
    qc.invalidateQueries({ queryKey: ["pnl", activePortfolioId] });
    qc.invalidateQueries({ queryKey: ["pnl-summary", activePortfolioId] });
  }, [activePortfolioId, qc]);

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
    cashAmount: string;
    isShort: boolean;
    sector: string;
  }>({ shares: "", cashAmount: "", isShort: false, sector: "" });

  const startEdit = (pos: PositionDetail) => {
    setEditingPositionId(pos.id);
    setEditDraft({
      shares: String(pos.shares),
      cashAmount: pos.cashAmount != null ? String(pos.cashAmount) : "",
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
      invalidatePortfolioPnl();
      setEditingPositionId(null);
      addToast({ severity: "success", message: "Position updated" });
    },
    onError: () => addToast({ severity: "error", message: "Update failed" }),
  });

  const saveEdit = (id: string, pos: PositionDetail) => {
    if (pos.isCash) {
      updatePositionMut.mutate({
        id,
        patch: { cashAmount: parseFloat(editDraft.cashAmount) },
      });
      return;
    }
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

  const { data: brokerage } = useBrokerageStatus();
  const managedByPortfolio = useMemo(() => {
    const m = new Map<string, BrokerageAccount>();
    for (const a of brokerage?.accounts ?? []) m.set(a.portfolioId, a);
    return m;
  }, [brokerage]);
  const activeManaged = activePortfolioId ? managedByPortfolio.get(activePortfolioId) ?? null : null;

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

  const duplicateMut = useMutation({
    mutationFn: (id: string) =>
      fetch(`/api/analysis/portfolios/${id}/duplicate`, { method: "POST" }).then((r) =>
        r.json(),
      ),
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ["portfolios-list"] });
      setActivePortfolio(d.id);
      addToast({ severity: "success", message: `Duplicated to ${d.name}` });
    },
    onError: () => addToast({ severity: "error", message: "Duplicate failed" }),
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
      invalidatePortfolioPnl();
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
              qc.invalidateQueries({ queryKey: ["positions", p.id] });
              qc.invalidateQueries({ queryKey: ["pnl", p.id] });
              qc.invalidateQueries({ queryKey: ["pnl-summary", p.id] });
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
                  {activeManaged && (
                    <span
                      title={`Read-only: synced from ${activeManaged.institutionName ?? "your brokerage"}. Disconnect in the brokerage panel to edit manually.`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        marginLeft: 10,
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: "0.04em",
                        textTransform: "uppercase",
                        padding: "2px 8px",
                        borderRadius: 999,
                        border: "1px solid var(--color-accent)",
                        color: "var(--color-accent)",
                      }}
                    >
                      Synced · {formatSyncTime(activeManaged.lastSyncAt)}
                    </span>
                  )}
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
                <button
                  onClick={() => duplicateMut.mutate(activePortfolio.id)}
                  disabled={duplicateMut.isPending}
                  style={{
                    ...btnBase,
                    border: "1px solid var(--bg-border)",
                    background: "transparent",
                    color: "var(--text-secondary)",
                  }}
                >
                  {duplicateMut.isPending ? "Duplicating..." : "Duplicate"}
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
                        {/* Shares / Amount */}
                        <td style={{ padding: "4px 8px", textAlign: "right" }}>
                          {isEditing ? (
                            pos.isCash ? (
                              <input
                                type="number"
                                min={0}
                                step="any"
                                value={editDraft.cashAmount}
                                onChange={(e) => setEditDraft((d) => ({ ...d, cashAmount: e.target.value }))}
                                style={editInput(true)}
                                placeholder="Amount ($)"
                              />
                            ) : (
                              <input type="number" min={0} step="any" value={editDraft.shares}
                                onChange={(e) => setEditDraft((d) => ({ ...d, shares: e.target.value }))}
                                style={editInput(true)} />
                            )
                          ) : (
                            <span style={{ fontFamily: "var(--font-mono, monospace)", color: "var(--text-primary)" }}>
                              {pos.isCash
                                ? `$${(pos.cashAmount ?? 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
                                : pos.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                            </span>
                          )}
                        </td>
                        {/* L / S direction */}
                        <td style={{ padding: "4px 8px", textAlign: "center" }}>
                          {pos.isCash ? (
                            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>—</span>
                          ) : isEditing ? (
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
                          {activeManaged ? (
                            <span style={{ color: "var(--text-muted)" }}>—</span>
                          ) : isEditing ? (
                            <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <button onClick={() => saveEdit(pos.id, pos)} disabled={updatePositionMut.isPending}
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
                          {activeManaged || isEditing ? null : isConfirming ? (
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

          {activeManaged ? (
            <div
              style={{
                borderTop: "1px solid var(--bg-border)",
                marginTop: 16,
                paddingTop: 16,
                fontSize: 12,
                color: "var(--text-muted)",
              }}
            >
              Holdings are synced from {activeManaged.institutionName ?? "your linked brokerage"} and
              can&apos;t be edited here. Manage the connection in the Brokerage panel above.
              {activeManaged.skipped.length > 0 && (
                <div style={{ marginTop: 6, color: "var(--color-warning)" }}>
                  Not mirrored:{" "}
                  {activeManaged.skipped.map((s) => s.symbol ?? s.kind).join(", ")} (
                  {activeManaged.skipped.length} non-equity position
                  {activeManaged.skipped.length !== 1 ? "s" : ""}).
                </div>
              )}
            </div>
          ) : (
            <ManualEntry nested />
          )}
        </div>
      )}
    </Card>
  );
}

// -- CSV Upload -------------------------------------------------------

function CsvUpload() {
  const { activePortfolioId, addToast } = useAnalysisStore();
  const { data: brokerage } = useBrokerageStatus();
  const managed = !!brokerage?.accounts?.some((a) => a.portfolioId === activePortfolioId);
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
    if (managed) {
      addToast({
        severity: "warning",
        message: "This portfolio is synced from a linked brokerage and is read-only.",
      });
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
        onClick={() => !managed && inputRef.current?.click()}
        title={managed ? "This portfolio is synced from a linked brokerage and is read-only." : undefined}
        style={{
          border: `2px dashed ${dragging ? "var(--color-accent)" : "var(--bg-border)"}`,
          borderRadius: 2,
          padding: "32px 24px",
          textAlign: "center",
          cursor: managed ? "not-allowed" : "pointer",
          background: dragging ? "rgba(99,102,241,0.05)" : "transparent",
          transition: "all 0.15s",
          opacity: managed ? 0.5 : 1,
          pointerEvents: managed ? "none" : "auto",
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

// -- Brokerage panel (SnapTrade / Robinhood) --------------------------------

interface SyncResultRow {
  accountLinkId: string;
  ok: boolean;
  deduped?: boolean;
  positionCount: number;
  error?: string;
}

function BrokeragePanel() {
  const { setActivePortfolio, addToast } = useAnalysisStore();
  const qc = useQueryClient();
  const isAdmin = useIsAdmin();
  const { data: status, isLoading } = useBrokerageStatus();

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["brokerage-status"] });
    qc.invalidateQueries({ queryKey: ["portfolios-list"] });
    qc.invalidateQueries({ queryKey: ["positions"] });
  }, [qc]);

  const connectMut = useMutation({
    mutationFn: () =>
      fetch("/api/analysis/brokerage/link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Failed to start linking");
        return d as { redirectURI?: string };
      }),
    onSuccess: (d) => {
      if (d.redirectURI) window.location.href = d.redirectURI;
      else addToast({ severity: "error", message: "No connection URL returned" });
    },
    onError: (e) => addToast({ severity: "error", message: (e as Error).message }),
  });

  const syncMut = useMutation({
    mutationFn: (accountLinkId?: string) =>
      fetch("/api/analysis/brokerage/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accountLinkId ? { accountLinkId } : {}),
      }).then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error ?? "Sync failed");
        return d as { results?: SyncResultRow[] };
      }),
    onSuccess: (d) => {
      invalidateAll();
      const results = d.results ?? [];
      const failed = results.find((x) => !x.ok && !x.deduped);
      if (failed) {
        addToast({ severity: "error", message: failed.error ?? "Sync failed" });
        return;
      }
      const ok = results.filter((x) => x.ok).length;
      addToast({ severity: "success", message: `Synced ${ok} account${ok !== 1 ? "s" : ""}` });
    },
    onError: (e) => addToast({ severity: "error", message: (e as Error).message }),
  });

  const disconnectMut = useMutation({
    mutationFn: (accountLinkId: string) =>
      fetch("/api/analysis/brokerage/disconnect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountLinkId }),
      }).then((r) => r.json()),
    onSuccess: () => {
      invalidateAll();
      addToast({ severity: "success", message: "Brokerage account disconnected" });
    },
    onError: () => addToast({ severity: "error", message: "Disconnect failed" }),
  });

  // When SnapTrade redirects back after connecting (?linked=1), sync once and
  // clean the query param so a refresh doesn't re-trigger.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("linked") === "1") {
      url.searchParams.delete("linked");
      window.history.replaceState({}, "", url.toString());
      syncMut.mutate(undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Admin-only, and hidden entirely when the server has no SnapTrade credentials.
  if (!isAdmin || isLoading || !status?.configured) return null;

  const accounts = status.accounts ?? [];
  const btn: React.CSSProperties = {
    padding: "6px 14px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: 13,
    fontWeight: 600,
  };

  return (
    <Card>
      <SectionHeading>Brokerage</SectionHeading>
      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 14 }}>
        Link a brokerage (Robinhood via SnapTrade) to auto-mirror its holdings into a read-only
        portfolio. Connecting is read-only and never places trades.
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: accounts.length ? 16 : 0 }}>
        <button
          onClick={() => connectMut.mutate()}
          disabled={connectMut.isPending}
          style={{ ...btn, border: "none", background: "var(--color-accent)", color: "var(--bg-base)" }}
        >
          {connectMut.isPending ? "Opening..." : accounts.length ? "Connect another account" : "Connect Robinhood"}
        </button>
        {accounts.length > 0 && (
          <button
            onClick={() => syncMut.mutate(undefined)}
            disabled={syncMut.isPending}
            style={{ ...btn, border: "1px solid var(--bg-border)", background: "transparent", color: "var(--text-secondary)" }}
          >
            {syncMut.isPending ? "Syncing..." : "Sync all"}
          </button>
        )}
      </div>

      {accounts.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {accounts.map((a) => (
            <div
              key={a.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "10px 12px",
                background: "var(--bg-elevated)",
                borderRadius: 6,
                border: "1px solid var(--bg-border)",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={() => setActivePortfolio(a.portfolioId)}
                title="Show this portfolio"
                style={{
                  background: "transparent",
                  border: "none",
                  padding: 0,
                  cursor: "pointer",
                  textAlign: "left",
                  flex: 1,
                  minWidth: 180,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
                  {a.institutionName ?? "Brokerage account"}
                  {a.accountMask ? ` · …${a.accountMask}` : ""}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {a.positionCount} position{a.positionCount !== 1 ? "s" : ""} · last sync{" "}
                  {formatSyncTime(a.lastSyncAt)}
                </div>
              </button>

              <StatusBadge
                severity={a.lastSyncStatus === "ERROR" ? "stale" : a.lastSyncStatus === "OK" ? "ok" : "warning"}
                label={a.lastSyncStatus === "ERROR" ? "Sync error" : a.lastSyncStatus === "OK" ? "Synced" : "Not synced"}
              />

              <button
                onClick={() => syncMut.mutate(a.id)}
                disabled={syncMut.isPending}
                style={{ ...btn, padding: "5px 12px", border: "1px solid var(--bg-border)", background: "transparent", color: "var(--text-secondary)" }}
              >
                Sync now
              </button>
              <button
                onClick={() => disconnectMut.mutate(a.id)}
                disabled={disconnectMut.isPending}
                style={{ ...btn, padding: "5px 12px", border: "1px solid var(--color-negative, #ef4444)", background: "transparent", color: "var(--color-negative, #ef4444)" }}
              >
                Disconnect
              </button>

              {a.lastSyncError && (
                <div style={{ flexBasis: "100%", fontSize: 11, color: "var(--color-negative, #ef4444)" }}>
                  {a.lastSyncError}
                </div>
              )}
              {a.skipped.length > 0 && (
                <div style={{ flexBasis: "100%", fontSize: 11, color: "var(--color-warning)" }}>
                  Not mirrored: {a.skipped.map((s) => s.symbol ?? s.kind).join(", ")} (
                  {a.skipped.length} non-equity position{a.skipped.length !== 1 ? "s" : ""})
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// -- Manual position entry --------------------------------------------------

function ManualEntry({ nested = false }: { nested?: boolean }) {
  const { activePortfolioId, addToast } = useAnalysisStore();
  const qc = useQueryClient();
  const [isCashMode, setIsCashMode] = useState(false);
  const [form, setForm] = useState({
    ticker: "",
    shares: "",
    cashAmount: "",
    isShort: false,
    sector: "",
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activePortfolioId) {
      addToast({ severity: "warning", message: "Select a portfolio first" });
      return;
    }

    const body = isCashMode
      ? {
          portfolioId: activePortfolioId,
          isCash: true,
          cashAmount: parseFloat(form.cashAmount),
        }
      : {
          portfolioId: activePortfolioId,
          ticker: form.ticker.toUpperCase(),
          shares: parseFloat(form.shares),
          isShort: form.isShort,
          sector: form.sector || undefined,
        };

    const r = await fetch("/api/analysis/portfolio/positions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (r.ok) {
      addToast({
        severity: "success",
        message: isCashMode ? "Cash added" : `${form.ticker.toUpperCase()} added`,
      });
      qc.invalidateQueries({ queryKey: ["positions", activePortfolioId] });
      qc.invalidateQueries({ queryKey: ["pnl", activePortfolioId] });
      qc.invalidateQueries({ queryKey: ["pnl-summary", activePortfolioId] });
      setForm({
        ticker: "",
        shares: "",
        cashAmount: "",
        isShort: false,
        sector: form.sector,
      });
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

  const inner = (
    <>
      {nested ? (
        <CardLabel>Add Position</CardLabel>
      ) : (
        <SectionHeading>Add Position Manually</SectionHeading>
      )}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button
          type="button"
          onClick={() => setIsCashMode(false)}
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            border: "1px solid var(--bg-border)",
            background: !isCashMode ? "var(--color-accent)" : "transparent",
            color: !isCashMode ? "var(--bg-base)" : "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Equity
        </button>
        <button
          type="button"
          onClick={() => setIsCashMode(true)}
          style={{
            padding: "5px 12px",
            borderRadius: 6,
            border: "1px solid var(--bg-border)",
            background: isCashMode ? "var(--color-accent)" : "transparent",
            color: isCashMode ? "var(--bg-base)" : "var(--text-secondary)",
            cursor: "pointer",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          Cash
        </button>
      </div>
      <form
        onSubmit={handleSubmit}
        style={{
          display: "grid",
          gridTemplateColumns: isCashMode ? "1fr auto" : "1.4fr 1fr 0.6fr 1fr",
          gap: 12,
        }}
      >
        {isCashMode ? (
          field(
            "Amount ($)",
            <input
              type="number"
              value={form.cashAmount}
              onChange={(e) => setForm((f) => ({ ...f, cashAmount: e.target.value }))}
              placeholder="50000"
              min={0}
              step="any"
              style={inputStyle(true)}
              required
            />,
          )
        ) : (
          <>
        {field("Ticker",
          <TickerSearchCombobox
            value={form.ticker}
            onChange={(t) => setForm((f) => ({ ...f, ticker: t }))}
            onSelect={(_ticker, s) => {
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
          </>
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
              fontWeight: 600,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {isCashMode ? "Add Cash" : "Add Position"}
          </button>
        </div>
      </form>
    </>
  );

  if (nested) {
    return (
      <div style={{ borderTop: "1px solid var(--bg-border)", marginTop: 16, paddingTop: 16 }}>
        {inner}
      </div>
    );
  }
  return <Card>{inner}</Card>;
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

// -- Securities health -----------------------------------------------------

interface DelistCandidateRow {
  id: string;
  ticker: string;
  name: string;
  lastBarDate: string | null;
  firstMissedAt: string | null;
  lastMissedAt: string | null;
  consecutiveMisses: number;
  suggestedReplacement: string | null;
}

interface DelistedRow {
  id: string;
  ticker: string;
  name: string;
  lastBarDate: string | null;
  delistedAt: string | null;
  suggestedReplacement: string | null;
}

function fmtDate(d: string | null): string {
  if (!d) return "—";
  return d.length > 10 ? d.slice(0, 10) : d;
}

function SecuritiesHealth() {
  const qc = useQueryClient();
  const { addToast } = useAnalysisStore();
  const isAdmin = useIsAdmin();
  const { data, isLoading } = useQuery<{
    candidates: DelistCandidateRow[];
    delisted: DelistedRow[];
  }>({
    queryKey: ["securities-health"],
    queryFn: () => fetch("/api/analysis/securities/health").then((r) => r.json()),
    refetchInterval: 60_000,
  });

  const actionMut = useMutation({
    mutationFn: async (vars: { action: string; securityId: string }) => {
      const r = await fetch("/api/analysis/securities/health", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(vars),
      });
      if (!r.ok) throw new Error((await r.json()).error ?? "Failed");
      return r.json();
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["securities-health"] });
      qc.invalidateQueries({ queryKey: ["market-map"] });
      addToast({
        severity: "success",
        message:
          vars.action === "confirm-delist"
            ? "Ticker deactivated"
            : vars.action === "mark-live"
            ? "Marked live — counters cleared"
            : "Reactivated",
      });
    },
    onError: (e: Error) => {
      addToast({ severity: "error", message: e.message });
    },
  });

  if (isLoading) return <Skeleton height={120} />;
  const candidates = data?.candidates ?? [];
  const delisted = data?.delisted ?? [];

  if (candidates.length === 0 && delisted.length === 0) {
    return (
      <Card>
        <SectionHeading>Securities Health</SectionHeading>
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
          No delist candidates and no deactivated tickers.
        </div>
      </Card>
    );
  }

  const cellStyle: React.CSSProperties = {
    padding: "8px 10px",
    borderBottom: "1px solid var(--bg-border)",
    fontSize: 12,
    color: "var(--text-secondary)",
    verticalAlign: "middle",
  };
  const headStyle: React.CSSProperties = {
    ...cellStyle,
    color: "var(--text-muted)",
    fontWeight: 600,
    textAlign: "left" as const,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
  const btn = (color: string): React.CSSProperties => ({
    padding: "4px 10px",
    fontSize: 11,
    fontWeight: 600,
    borderRadius: 2,
    border: `1px solid ${color}`,
    background: "transparent",
    color,
    cursor: "pointer",
  });

  return (
    <Card>
      <SectionHeading>Securities Health</SectionHeading>

      <div style={{ marginBottom: 20 }}>
        <CardLabel>
          Delist candidates ({candidates.length})
        </CardLabel>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 12px" }}>
          Yahoo has returned a hard-delist signal repeatedly for these tickers
          over at least 90 days. Confirm to deactivate (hidden from the grid,
          historical bars retained), or mark live to reset the counter.
        </p>
        {candidates.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>None.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={headStyle}>Ticker</th>
                  <th style={headStyle}>Name</th>
                  <th style={headStyle}>Last bar</th>
                  <th style={headStyle}>First missed</th>
                  <th style={headStyle}>Misses</th>
                  <th style={headStyle}>Suggested rename</th>
                  <th style={headStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...cellStyle, fontFamily: "monospace", color: "var(--text-primary)", fontWeight: 600 }}>
                      {c.ticker}
                    </td>
                    <td style={cellStyle}>{c.name}</td>
                    <td style={cellStyle}>{fmtDate(c.lastBarDate)}</td>
                    <td style={cellStyle}>{fmtDate(c.firstMissedAt)}</td>
                    <td style={cellStyle}>{c.consecutiveMisses}</td>
                    <td style={cellStyle}>
                      {c.suggestedReplacement ? (
                        <span style={{ fontFamily: "monospace", color: "var(--color-accent)" }}>
                          → {c.suggestedReplacement}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isAdmin ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            style={btn("var(--color-negative)")}
                            disabled={actionMut.isPending}
                            onClick={() =>
                              actionMut.mutate({
                                action: "confirm-delist",
                                securityId: c.id,
                              })
                            }
                          >
                            Confirm delist
                          </button>
                          <button
                            style={btn("var(--text-secondary)")}
                            disabled={actionMut.isPending}
                            onClick={() =>
                              actionMut.mutate({
                                action: "mark-live",
                                securityId: c.id,
                              })
                            }
                          >
                            Mark live
                          </button>
                        </div>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          Admin only
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <CardLabel>
          Delisted (auto-hidden) ({delisted.length})
        </CardLabel>
        <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0 12px" }}>
          Already deactivated. They won&apos;t ingest or render until you reactivate.
        </p>
        {delisted.length === 0 ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)" }}>None.</div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={headStyle}>Ticker</th>
                  <th style={headStyle}>Name</th>
                  <th style={headStyle}>Last bar</th>
                  <th style={headStyle}>Delisted at</th>
                  <th style={headStyle}>Suggested rename</th>
                  <th style={headStyle}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {delisted.map((d) => (
                  <tr key={d.id}>
                    <td style={{ ...cellStyle, fontFamily: "monospace", color: "var(--text-primary)", fontWeight: 600 }}>
                      {d.ticker}
                    </td>
                    <td style={cellStyle}>{d.name}</td>
                    <td style={cellStyle}>{fmtDate(d.lastBarDate)}</td>
                    <td style={cellStyle}>{fmtDate(d.delistedAt)}</td>
                    <td style={cellStyle}>
                      {d.suggestedReplacement ? (
                        <span style={{ fontFamily: "monospace", color: "var(--color-accent)" }}>
                          → {d.suggestedReplacement}
                        </span>
                      ) : (
                        <span style={{ color: "var(--text-muted)" }}>—</span>
                      )}
                    </td>
                    <td style={cellStyle}>
                      {isAdmin ? (
                        <button
                          style={btn("var(--color-accent)")}
                          disabled={actionMut.isPending}
                          onClick={() =>
                            actionMut.mutate({
                              action: "reactivate",
                              securityId: d.id,
                            })
                          }
                        >
                          Reactivate
                        </button>
                      ) : (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                          Admin only
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
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

// -- Users (admin only) -----------------------------------------------------

interface UserRow {
  email: string;
  role: "ADMIN" | "USER";
  lastLoginAt: string | null;
  createdAt: string;
}

function UsersPanel() {
  const isAdmin = useIsAdmin();
  const { data, isLoading } = useQuery<{ users: UserRow[] }>({
    queryKey: ["admin-users"],
    queryFn: () => fetch("/api/admin/users").then((r) => r.json()),
    enabled: isAdmin,
    refetchInterval: 60_000,
  });

  if (!isAdmin) return null;

  const cellStyle: React.CSSProperties = {
    padding: "8px 10px",
    borderBottom: "1px solid var(--bg-border)",
    fontSize: 12,
    color: "var(--text-secondary)",
    verticalAlign: "middle",
  };
  const headStyle: React.CSSProperties = {
    ...cellStyle,
    color: "var(--text-muted)",
    fontWeight: 600,
    textAlign: "left" as const,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  const users = data?.users ?? [];

  return (
    <Card>
      <SectionHeading>Users</SectionHeading>
      <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "0 0 12px" }}>
        Everyone who has signed in via Cloudflare Access. Each user has their own
        portfolios; the admin alone controls the shared ticker universe and
        securities. Roles derive from the <code>ADMIN_EMAILS</code> allow-list.
      </p>
      {isLoading ? (
        <Skeleton height={80} />
      ) : users.length === 0 ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)" }}>No users yet.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={headStyle}>Email</th>
                <th style={headStyle}>Role</th>
                <th style={headStyle}>Last login</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.email}>
                  <td style={{ ...cellStyle, color: "var(--text-primary)" }}>{u.email}</td>
                  <td style={cellStyle}>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 700,
                        letterSpacing: "0.06em",
                        padding: "2px 6px",
                        borderRadius: 3,
                        border: `1px solid ${u.role === "ADMIN" ? "var(--color-accent)" : "var(--bg-border)"}`,
                        color: u.role === "ADMIN" ? "var(--color-accent)" : "var(--text-secondary)",
                      }}
                    >
                      {u.role}
                    </span>
                  </td>
                  <td style={cellStyle}>
                    {u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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

      <BrokeragePanel />
      <PortfolioManager />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <CsvUpload />
        <DemoLoader />
      </div>
      {/* The sections below the position editor each fire their own polling
          query on mount. Defer them until scrolled into view so editing a
          position at the top of the page doesn't kick off the 30s/60s polls. */}
      <DeferUntilVisible minHeight={120}>
        <DataSourceStatus />
      </DeferUntilVisible>
      <DeferUntilVisible minHeight={200}>
        <SecuritiesHealth />
      </DeferUntilVisible>
      <DeferUntilVisible minHeight={120}>
        <UsersPanel />
      </DeferUntilVisible>
      <DeferUntilVisible minHeight={200}>
        <AuditLogTable />
      </DeferUntilVisible>
    </div>
  );
}



