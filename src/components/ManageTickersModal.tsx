"use client";

import type { CSSProperties, DragEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ParsedUniverseRow } from "@/domain/universe/parse";

type TabId = "csv" | "paste" | "current";

type Constituent = {
  ticker: string;
  name: string;
  sector: string;
  subTheme: string;
};

type ResyncStatusState = "idle" | "running" | "done" | "error";

type DefaultUniverse = {
  id: string;
  name: string;
  constituentCount: number;
};

const CSV_SAMPLE =
  "AAPL,Apple Inc.,Tech,Hardware\n" +
  "MSFT,Microsoft Corp.,Tech,Software\n" +
  "NVDA,NVIDIA Corp.,Semis & AI,Semiconductors";
const PASTE_SAMPLE =
  "NVDA\tNVIDIA Corp.\tSemis & AI\tAI/Compute\n" +
  "AAPL\tApple Inc.\tTech\tHardware\n" +
  "MSFT\tMicrosoft Corp.\tTech\tSoftware";

export function ManageTickersModal({
  open,
  onClose,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  onApplied?: () => void;
}) {
  const [tab, setTab] = useState<TabId>("csv");
  const [universe, setUniverse] = useState<DefaultUniverse | null>(null);
  const [constituents, setConstituents] = useState<Constituent[]>([]);
  const [loadingUniverse, setLoadingUniverse] = useState(false);

  const [csvText, setCsvText] = useState("");
  const [pasteText, setPasteText] = useState("");
  const [preview, setPreview] = useState<ParsedUniverseRow[] | null>(null);
  const [previewFormat, setPreviewFormat] = useState<"csv" | "paste" | null>(null);
  const [parseErr, setParseErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [editingTicker, setEditingTicker] = useState<string | null>(null);
  // Working copy of the Current-tab rows. Edits/adds/removes mutate this only;
  // nothing is persisted until the user clicks "Save & Apply".
  const [draftRows, setDraftRows] = useState<Constituent[]>([]);
  const [applyingCurrent, setApplyingCurrent] = useState(false);
  const [resyncStatus, setResyncStatus] = useState<ResyncStatusState>("idle");
  const [nameFillStatus, setNameFillStatus] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Guards the automatic name backfill so it runs at most once per modal open.
  const backfillAttemptedRef = useRef(false);

  const loadUniverse = useCallback(async () => {
    setLoadingUniverse(true);
    try {
      const def = await fetch("/api/universe/default", { cache: "no-store" })
        .then((r) => r.json() as Promise<DefaultUniverse>);
      setUniverse(def);
      const full = await fetch(`/api/universes/${def.id}`, { cache: "no-store" })
        .then((r) => r.json() as Promise<{
          universe: {
            constituents: {
              sector: string;
              subTheme: string;
              security: { ticker: string; name: string };
            }[];
          };
        }>);
      const rows: Constituent[] = (full.universe?.constituents ?? []).map(
        (c) => ({
          ticker: c.security.ticker,
          name: c.security.name,
          sector: c.sector,
          subTheme: c.subTheme,
        })
      );
      setConstituents(rows);
      setDraftRows(rows);
    } catch {
      setUniverse(null);
      setConstituents([]);
      setDraftRows([]);
    } finally {
      setLoadingUniverse(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setMsg(null);
    setParseErr(null);
    setPreview(null);
    setPreviewFormat(null);
    setEditingTicker(null);
    setResyncStatus("idle");
    setNameFillStatus(null);
    backfillAttemptedRef.current = false;
    void loadUniverse();
  }, [open, loadUniverse]);

  // Auto-fill display names for any constituent whose name still equals its
  // ticker. Runs once per modal open (the ref guard); a partial / failed fill
  // leaves the rows for a later open rather than looping. Resolved names are
  // written straight to the DB by the endpoint, so reloading surfaces them and
  // re-opening finds nothing left to fill. Non-admins get a 403 we ignore.
  useEffect(() => {
    if (!open || !universe || backfillAttemptedRef.current) return;
    const missing = constituents.filter((c) => c.name.trim() === c.ticker.trim());
    if (missing.length === 0) return;
    backfillAttemptedRef.current = true;
    setNameFillStatus(`Filling ${missing.length} name${missing.length === 1 ? "" : "s"}…`);
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/universes/${universe.id}/backfill-names`, {
          method: "POST",
        });
        const body = (await res.json().catch(() => null)) as
          | { ok?: boolean; filled?: number }
          | null;
        if (cancelled) return;
        if (res.ok && body?.ok && (body.filled ?? 0) > 0) {
          setNameFillStatus(`Filled ${body.filled} name${body.filled === 1 ? "" : "s"}.`);
          await loadUniverse();
        } else {
          setNameFillStatus(null);
        }
      } catch {
        if (!cancelled) setNameFillStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, universe, constituents, loadUniverse]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Kick off the background engine resync (sync RevisionReference + re-score
  // Research/Fundamentals) after a taxonomy change. Fire-and-forget on the
  // server; we move to "running" and poll for completion below.
  const triggerResync = useCallback(async () => {
    if (!universe) return;
    try {
      const res = await fetch(`/api/universes/${universe.id}/resync-engines`, {
        method: "POST",
      });
      if (res.ok) setResyncStatus("running");
    } catch {
      // Best-effort; the next weekly job will still reconcile.
    }
  }, [universe]);

  // Poll the resync status while a background recompute is running so the modal
  // can surface "resyncing… / done" and refresh dependent views on completion.
  useEffect(() => {
    if (resyncStatus !== "running" || !universe) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await fetch(`/api/universes/${universe.id}/resync-engines`, {
          cache: "no-store",
        });
        const body = (await res.json().catch(() => null)) as
          | { status?: ResyncStatusState }
          | null;
        if (cancelled) return;
        if (body?.status === "done") {
          setResyncStatus("done");
          onApplied?.();
        } else if (body?.status === "error") {
          setResyncStatus("error");
        }
      } catch {
        // Keep polling; transient errors shouldn't abort the watcher.
      }
    };
    void poll();
    const id = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [resyncStatus, universe, onApplied]);

  const onParse = async (format: "csv" | "paste") => {
    setParseErr(null);
    setPreview(null);
    setPreviewFormat(null);
    setMsg(null);
    const text = format === "csv" ? csvText : pasteText;
    if (!text.trim()) {
      setParseErr("Nothing to parse.");
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/parse-universe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, format }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        const errs: { line: number; message: string }[] = Array.isArray(j.errors)
          ? j.errors
          : [];
        if (errs.length === 0) {
          setParseErr(
            typeof j.error === "string"
              ? j.error
              : `Parse failed (HTTP ${res.status}).`
          );
        } else {
          // Include the total error count so a few bad rows in a long paste
          // don't make the user think the entire paste is broken.
          const sample = errs
            .slice(0, 3)
            .map((e) => `line ${e.line}: ${e.message}`)
            .join(" · ");
          const more = errs.length > 3 ? ` · …and ${errs.length - 3} more` : "";
          setParseErr(`${errs.length} row(s) failed — ${sample}${more}`);
        }
        return;
      }
      setPreview(j.rows);
      setPreviewFormat(format);
    } catch (e) {
      setParseErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onApply = async () => {
    if (!preview || !universe) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/universes/${universe.id}/constituents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: preview }),
      });
      // Always read the response as JSON if possible — the route returns
      // a structured { error: string } body even on 5xx so the user can see
      // what actually went wrong (timeout, validation, etc.) instead of a
      // raw HTML error page or empty string.
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            applied?: number;
            created?: number;
            reactivated?: number;
            renamed?: number;
            duplicatesDropped?: number;
          }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(
          body?.error ?? `Failed to save tickers (HTTP ${res.status})`
        );
      }

      // Kick off price ingestion for any newly-added tickers in the
      // background. The dashboard polls and will pick up bars as they land.
      void fetch(
        `/api/universes/${universe.id}/ingest?mode=missing`,
        { method: "POST", keepalive: true }
      ).catch(() => undefined);
      void fetch(`/api/benchmarks/ingest?mode=missing`, {
        method: "POST",
        keepalive: true,
      }).catch(() => undefined);

      const parts: string[] = [
        `Applied ${body.applied ?? preview.length} tickers`,
      ];
      if (body.created != null && body.created > 0) {
        parts.push(`${body.created} new`);
      }
      if (body.duplicatesDropped != null && body.duplicatesDropped > 0) {
        parts.push(`${body.duplicatesDropped} duplicate dropped`);
      }
      setMsg(
        `${parts.join(" · ")} — pulling prices and resyncing engines in the background.`
      );
      setPreview(null);
      setPreviewFormat(null);
      await loadUniverse();
      onApplied?.();
      await triggerResync();
      setTab("current");
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Staged edits — these mutate the in-memory draft only. Nothing is persisted
  // until "Save & Apply".
  const onStageRemove = useCallback((ticker: string) => {
    setDraftRows((prev) => prev.filter((c) => c.ticker !== ticker));
    setEditingTicker((cur) => (cur === ticker ? null : cur));
  }, []);

  const onStageAdd = useCallback(
    async (row: ParsedUniverseRow): Promise<boolean> => {
      const ticker = row.ticker.trim().toUpperCase();
      if (!ticker) return false;
      const next: Constituent = {
        ticker,
        name: row.companyName.trim(),
        sector: row.sector.trim(),
        subTheme: row.subTheme.trim(),
      };
      setDraftRows((prev) => {
        const idx = prev.findIndex((c) => c.ticker.toUpperCase() === ticker);
        if (idx >= 0) {
          const copy = [...prev];
          copy[idx] = next;
          return copy;
        }
        return [...prev, next];
      });
      setMsg(null);
      return true;
    },
    []
  );

  const onStageUpdate = useCallback(
    async (
      ticker: string,
      fields: { companyName: string; sector: string; subTheme: string }
    ): Promise<boolean> => {
      setDraftRows((prev) =>
        prev.map((c) =>
          c.ticker === ticker
            ? {
                ...c,
                name: fields.companyName.trim(),
                sector: fields.sector.trim(),
                subTheme: fields.subTheme.trim(),
              }
            : c
        )
      );
      setEditingTicker(null);
      setMsg(null);
      return true;
    },
    []
  );

  const dirty = useMemo(
    () => rowsSignature(draftRows) !== rowsSignature(constituents),
    [draftRows, constituents]
  );

  const onReloadCurrent = useCallback(() => {
    if (
      dirty &&
      typeof window !== "undefined" &&
      !window.confirm("Discard unsaved changes and reload the saved list?")
    ) {
      return;
    }
    setEditingTicker(null);
    setMsg(null);
    void loadUniverse();
  }, [dirty, loadUniverse]);

  const onSaveApply = useCallback(async () => {
    if (!universe) return;
    if (draftRows.length === 0) {
      setMsg("Add at least one ticker before applying.");
      return;
    }
    setApplyingCurrent(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/universes/${universe.id}/constituents`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rows: draftRows.map((r) => ({
            ticker: r.ticker,
            companyName: r.name,
            sector: r.sector,
            subTheme: r.subTheme,
          })),
        }),
      });
      const body = (await res.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            applied?: number;
            created?: number;
            duplicatesDropped?: number;
          }
        | null;
      if (!res.ok || !body?.ok) {
        throw new Error(
          body?.error ?? `Failed to apply changes (HTTP ${res.status})`
        );
      }

      // Pull prices for any newly-added tickers in the background.
      void fetch(`/api/universes/${universe.id}/ingest?mode=missing`, {
        method: "POST",
        keepalive: true,
      }).catch(() => undefined);

      const parts: string[] = [
        `Applied ${body.applied ?? draftRows.length} tickers`,
      ];
      if (body.duplicatesDropped != null && body.duplicatesDropped > 0) {
        parts.push(`${body.duplicatesDropped} duplicate dropped`);
      }
      setMsg(
        `${parts.join(" · ")} — resyncing Research & Fundamentals in the background.`
      );
      await loadUniverse();
      onApplied?.();
      await triggerResync();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyingCurrent(false);
    }
  }, [universe, draftRows, loadUniverse, onApplied, triggerResync]);

  const onFile = async (file: File) => {
    const text = await file.text();
    setCsvText(text);
    setParseErr(null);
    setPreview(null);
    setPreviewFormat(null);
    setMsg(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void onFile(file);
  };

  if (!open) return null;

  const count = universe?.constituentCount ?? constituents.length;

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-label="Manage tickers">
      <div style={backdrop} onClick={onClose} />
      <div style={panel}>
        <div style={header}>
          <h2 style={title}>Manage Tickers</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={closeBtn}
          >
            ×
          </button>
        </div>

        <div style={tabs}>
          <TabBtn id="csv" active={tab === "csv"} onClick={() => setTab("csv")}>
            CSV Import
          </TabBtn>
          <TabBtn id="paste" active={tab === "paste"} onClick={() => setTab("paste")}>
            Paste Tickers
          </TabBtn>
          <TabBtn
            id="current"
            active={tab === "current"}
            onClick={() => setTab("current")}
          >
            Current ({draftRows.length})
          </TabBtn>
        </div>

        <div style={body}>
          {tab === "csv" && (
            <div>
              <p style={hint}>
                Upload a CSV (or TSV pasted from a spreadsheet) with 4 columns:{" "}
                <code style={code}>ticker, name, sector, sub-theme</code>. Headers
                optional.
              </p>
              <div
                style={{
                  ...dropZone,
                  borderColor: dragActive ? "#4a8bf0" : "#384454",
                  background: dragActive ? "#1e2a3b" : "#121821",
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragActive(true);
                }}
                onDragLeave={() => setDragActive(false)}
                onDrop={onDrop}
                onClick={() => fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
              >
                <span style={{ color: "#c7d0dc" }}>
                  Drop CSV here or{" "}
                  <span style={{ color: "#6aa6ff", textDecoration: "underline" }}>
                    browse
                  </span>
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void onFile(f);
                  }}
                />
              </div>
              <div style={{ marginTop: "0.75rem" }}>
                <div style={{ ...hint, marginBottom: "0.35rem" }}>
                  Or paste CSV directly:
                </div>
                <textarea
                  value={csvText}
                  onChange={(e) => setCsvText(e.target.value)}
                  placeholder={CSV_SAMPLE}
                  rows={6}
                  style={textarea}
                />
              </div>
              <div style={actionRow}>
                <button
                  type="button"
                  onClick={() => void onParse("csv")}
                  disabled={busy || !csvText.trim()}
                  style={btnPrimary}
                >
                  Parse &amp; Preview →
                </button>
                {preview && previewFormat === "csv" && (
                  <button
                    type="button"
                    onClick={() => void onApply()}
                    disabled={busy}
                    style={btnSuccess}
                  >
                    Apply to current list ({preview.length})
                  </button>
                )}
              </div>
              {parseErr && <p style={errStyle}>{parseErr}</p>}
              {preview && previewFormat === "csv" && (
                <PreviewTable rows={preview} />
              )}
            </div>
          )}

          {tab === "paste" && (
            <div>
              <p style={hint}>
                Paste 4 columns separated by <strong>tabs</strong> (or 2+ spaces):{" "}
                <code style={code}>Ticker · Name · Theme · Sub-Theme</code>.
              </p>
              <textarea
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={PASTE_SAMPLE}
                rows={12}
                style={textarea}
              />
              <div style={actionRow}>
                <button
                  type="button"
                  onClick={() => void onParse("paste")}
                  disabled={busy || !pasteText.trim()}
                  style={btnPrimary}
                >
                  Parse &amp; Preview →
                </button>
                {preview && previewFormat === "paste" && (
                  <button
                    type="button"
                    onClick={() => void onApply()}
                    disabled={busy}
                    style={btnSuccess}
                  >
                    Apply to current list ({preview.length})
                  </button>
                )}
              </div>
              {parseErr && <p style={errStyle}>{parseErr}</p>}
              {preview && previewFormat === "paste" && (
                <PreviewTable rows={preview} />
              )}
            </div>
          )}

          {tab === "current" && (
            <CurrentTab
              rows={draftRows}
              loading={loadingUniverse}
              onReload={onReloadCurrent}
              onRemove={onStageRemove}
              onAdd={onStageAdd}
              editingTicker={editingTicker}
              onStartEdit={setEditingTicker}
              onCancelEdit={() => setEditingTicker(null)}
              onUpdate={onStageUpdate}
              dirty={dirty}
              applying={applyingCurrent}
              onSaveApply={() => void onSaveApply()}
              resyncStatus={resyncStatus}
              nameFillStatus={nameFillStatus}
            />
          )}
        </div>

        <div style={footer}>
          <span style={{ color: "#8c99a8", fontSize: "0.85rem" }}>
            {count} tickers in database
          </span>
          <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
            {msg && (
              <span
                style={{
                  color: isSuccessMessage(msg) ? "#7bd88f" : "#ff8d8d",
                  fontSize: "0.85rem",
                }}
              >
                {msg}
              </span>
            )}
            <button type="button" onClick={onClose} style={btnGhost}>
              {preview ? "Cancel" : "Close"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function isSuccessMessage(msg: string): boolean {
  return /^(Applied|Removed|Added|Updated)\b/.test(msg);
}

function TabBtn({
  id,
  active,
  onClick,
  children,
}: {
  id: string;
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      aria-controls={`tab-panel-${id}`}
      onClick={onClick}
      style={{
        ...tabBtn,
        color: active ? "#6aa6ff" : "#c7d0dc",
        borderBottom: active ? "2px solid #6aa6ff" : "2px solid transparent",
      }}
    >
      {children}
    </button>
  );
}

function PreviewTable({ rows }: { rows: ParsedUniverseRow[] }) {
  const shown = rows.slice(0, 50);
  return (
    <div style={{ marginTop: "0.75rem" }}>
      <div style={{ color: "#8c99a8", fontSize: "0.8rem", marginBottom: "0.3rem" }}>
        Preview — {rows.length} row{rows.length === 1 ? "" : "s"}
        {rows.length > shown.length ? ` (showing first ${shown.length})` : ""}
      </div>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Ticker</th>
              <th style={th}>Name</th>
              <th style={th}>Theme</th>
              <th style={th}>Subtheme</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => (
              <tr key={`${r.ticker}-${r.subTheme}`}>
                <td style={tdTicker}>{r.ticker}</td>
                <td style={td}>{r.companyName}</td>
                <td style={td}>{r.sector}</td>
                <td style={tdSub}>{r.subTheme}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * Order-independent signature of a constituent set, used to detect whether the
 * working draft differs from the saved list (enables the Save & Apply button).
 */
function rowsSignature(rows: Constituent[]): string {
  return rows
    .map((r) => `${r.ticker}\u0001${r.name}\u0001${r.sector}\u0001${r.subTheme}`)
    .sort()
    .join("\u0002");
}

function computeSectorOptions(rows: Constituent[]): string[] {
  const set = new Set<string>();
  for (const r of rows) if (r.sector) set.add(r.sector);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function computeSubThemeOptions(rows: Constituent[], sector: string): string[] {
  const s = sector.trim().toLowerCase();
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.subTheme) continue;
    if (s && r.sector.trim().toLowerCase() !== s) continue;
    set.add(r.subTheme);
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function ConstituentRow({
  row,
  allRows,
  isEditing,
  isUpdating,
  actionsDisabled,
  onStartEdit,
  onCancelEdit,
  onSave,
  onRemove,
  isRemoving,
}: {
  row: Constituent;
  allRows: Constituent[];
  isEditing: boolean;
  isUpdating: boolean;
  actionsDisabled: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (fields: {
    companyName: string;
    sector: string;
    subTheme: string;
  }) => Promise<boolean>;
  onRemove: () => void;
  isRemoving: boolean;
}) {
  const [name, setName] = useState(row.name);
  const [sector, setSector] = useState(row.sector);
  const [subTheme, setSubTheme] = useState(row.subTheme);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (isEditing) {
      setName(row.name);
      setSector(row.sector);
      setSubTheme(row.subTheme);
      setErr(null);
    }
  }, [isEditing, row.name, row.sector, row.subTheme]);

  const sectorOptions = useMemo(() => computeSectorOptions(allRows), [allRows]);
  const subThemeOptions = useMemo(
    () => computeSubThemeOptions(allRows, sector),
    [allRows, sector]
  );

  const sectorListId = `edit-sector-${row.ticker}`;
  const subThemeListId = `edit-subtheme-${row.ticker}`;

  const save = useCallback(async () => {
    setErr(null);
    if (!name.trim() || !sector.trim() || !subTheme.trim()) {
      setErr("Name, theme and sub-theme are all required.");
      return;
    }
    await onSave({
      companyName: name.trim(),
      sector: sector.trim(),
      subTheme: subTheme.trim(),
    });
  }, [name, sector, subTheme, onSave]);

  return (
    <tr>
      <td style={tdTicker}>{row.ticker}</td>
      {isEditing ? (
        <>
          <td style={td}>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={cellInput}
              aria-label={`Name for ${row.ticker}`}
            />
          </td>
          <td style={td}>
            <input
              list={sectorListId}
              value={sector}
              onChange={(e) => setSector(e.target.value)}
              style={cellInput}
              placeholder="Type to add or pick a theme"
              aria-label={`Theme for ${row.ticker}`}
            />
            <datalist id={sectorListId}>
              {sectorOptions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </td>
          <td style={tdSub}>
            <input
              list={subThemeListId}
              value={subTheme}
              onChange={(e) => setSubTheme(e.target.value)}
              style={cellInput}
              placeholder="Type to add or pick a sub-theme"
              aria-label={`Subtheme for ${row.ticker}`}
            />
            <datalist id={subThemeListId}>
              {subThemeOptions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </td>
          <td style={actionTd}>
            <div style={actionGroup}>
              <button
                type="button"
                onClick={() => void save()}
                disabled={isUpdating}
                style={{ ...btnPrimary, ...btnCompact }}
              >
                {isUpdating ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={onCancelEdit}
                disabled={isUpdating}
                style={{ ...btnGhost, ...btnCompact }}
              >
                Cancel
              </button>
            </div>
            {err && (
              <div style={{ color: "#ff8d8d", fontSize: "0.75rem", marginTop: 2 }}>
                {err}
              </div>
            )}
          </td>
        </>
      ) : (
        <>
          <td style={td}>{row.name}</td>
          <td style={td}>{row.sector}</td>
          <td style={tdSub}>{row.subTheme}</td>
          <td style={actionTd}>
            <div style={actionGroup}>
              <button
                type="button"
                onClick={onStartEdit}
                disabled={actionsDisabled}
                title={`Edit ${row.ticker}`}
                aria-label={`Edit ${row.ticker}`}
                style={editBtn}
              >
                ✎
              </button>
              <button
                type="button"
                onClick={onRemove}
                disabled={actionsDisabled || isRemoving}
                title={`Remove ${row.ticker}`}
                aria-label={`Remove ${row.ticker}`}
                style={removeBtn}
              >
                {isRemoving ? "…" : "×"}
              </button>
            </div>
          </td>
        </>
      )}
    </tr>
  );
}

function CurrentTab({
  rows,
  loading,
  onReload,
  onRemove,
  onAdd,
  editingTicker,
  onStartEdit,
  onCancelEdit,
  onUpdate,
  dirty,
  applying,
  onSaveApply,
  resyncStatus,
  nameFillStatus,
}: {
  rows: Constituent[];
  loading: boolean;
  onReload: () => void;
  onRemove: (ticker: string) => void;
  onAdd: (row: ParsedUniverseRow) => Promise<boolean>;
  editingTicker: string | null;
  onStartEdit: (ticker: string) => void;
  onCancelEdit: () => void;
  onUpdate: (
    ticker: string,
    fields: { companyName: string; sector: string; subTheme: string }
  ) => Promise<boolean>;
  dirty: boolean;
  applying: boolean;
  onSaveApply: () => void;
  resyncStatus: ResyncStatusState;
  nameFillStatus: string | null;
}) {
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");
  const [subTheme, setSubTheme] = useState("");

  const filtered = useMemo(() => {
    const t = ticker.trim().toLowerCase();
    const n = name.trim().toLowerCase();
    const s = sector.trim().toLowerCase();
    const st = subTheme.trim().toLowerCase();
    return rows.filter((r) => {
      if (t && !r.ticker.toLowerCase().includes(t)) return false;
      if (n && !r.name.toLowerCase().includes(n)) return false;
      if (s && !r.sector.toLowerCase().includes(s)) return false;
      if (st && !r.subTheme.toLowerCase().includes(st)) return false;
      return true;
    });
  }, [rows, ticker, name, sector, subTheme]);

  return (
    <div>
      <AddStockForm rows={rows} onAdd={onAdd} />
      <p style={{ ...hint, marginBottom: "0.5rem" }}>
        Edit a row, then click <strong>Save &amp; Apply</strong> below. Theme and
        sub-theme accept new values — just type one in. Changes propagate to every
        tab (Research &amp; Fundamentals resync in the background).
      </p>
      <div style={filterRow}>
        <FilterInput
          label="Ticker"
          placeholder="e.g. NVDA"
          value={ticker}
          onChange={setTicker}
        />
        <FilterInput
          label="Name"
          placeholder="e.g. NVIDIA"
          value={name}
          onChange={setName}
        />
        <FilterInput
          label="Theme"
          placeholder="e.g. Tech"
          value={sector}
          onChange={setSector}
        />
        <FilterInput
          label="Subtheme"
          placeholder="e.g. Hardware"
          value={subTheme}
          onChange={setSubTheme}
        />
      </div>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th}>Ticker</th>
              <th style={th}>Name</th>
              <th style={th}>Theme</th>
              <th style={th}>Subtheme</th>
              <th style={{ ...th, minWidth: 120, textAlign: "right" }} aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#8c99a8" }}>
                  Loading…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ ...td, color: "#8c99a8" }}>
                  No tickers match.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const isEditing = editingTicker === r.ticker;
                const actionsDisabled = editingTicker !== null && !isEditing;
                return (
                  <ConstituentRow
                    key={r.ticker}
                    row={r}
                    allRows={rows}
                    isEditing={isEditing}
                    isUpdating={false}
                    actionsDisabled={actionsDisabled}
                    onStartEdit={() => onStartEdit(r.ticker)}
                    onCancelEdit={onCancelEdit}
                    onSave={(fields) => onUpdate(r.ticker, fields)}
                    onRemove={() => onRemove(r.ticker)}
                    isRemoving={false}
                  />
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <div
        style={{
          marginTop: "0.6rem",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "0.75rem",
        }}
      >
        <span style={{ fontSize: "0.8rem", color: resyncStatusColor(resyncStatus) }}>
          {nameFillStatus ?? resyncStatusLabel(resyncStatus, dirty)}
        </span>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={onReload}
            title="Discard unsaved changes and reload the saved list"
            style={btnGhost}
          >
            Reload
          </button>
          <button
            type="button"
            onClick={onSaveApply}
            disabled={!dirty || applying}
            style={{ ...btnSuccess, opacity: !dirty || applying ? 0.5 : 1 }}
            title={
              dirty
                ? "Persist changes and resync every tab"
                : "No unsaved changes"
            }
          >
            {applying ? "Saving & applying…" : "Save & Apply"}
          </button>
        </div>
      </div>
    </div>
  );
}

function resyncStatusLabel(s: ResyncStatusState, dirty: boolean): string {
  switch (s) {
    case "running":
      return "Resyncing Research & Fundamentals…";
    case "done":
      return "Research & Fundamentals resynced.";
    case "error":
      return "Engine resync failed — will reconcile on the next weekly job.";
    default:
      return dirty ? "Unsaved changes" : "";
  }
}

function resyncStatusColor(s: ResyncStatusState): string {
  switch (s) {
    case "done":
      return "#7bd88f";
    case "error":
      return "#ff8d8d";
    case "running":
      return "#6aa6ff";
    default:
      return "#8c99a8";
  }
}

function AddStockForm({
  rows,
  onAdd,
}: {
  rows: Constituent[];
  onAdd: (row: ParsedUniverseRow) => Promise<boolean>;
}) {
  const [ticker, setTicker] = useState("");
  const [name, setName] = useState("");
  const [sector, setSector] = useState("");
  const [subTheme, setSubTheme] = useState("");
  const [lookingUp, setLookingUp] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sectorOptions = useMemo(() => computeSectorOptions(rows), [rows]);

  // Sub-themes already used under the chosen sector (free typing still allowed
  // via the datalist); fall back to all sub-themes when no sector is chosen.
  const subThemeOptions = useMemo(
    () => computeSubThemeOptions(rows, sector),
    [rows, sector]
  );

  const onTickerBlur = useCallback(async () => {
    const t = ticker.trim().toUpperCase();
    if (!t || name.trim()) return;
    setLookingUp(true);
    try {
      const res = await fetch(
        `/api/securities/lookup?ticker=${encodeURIComponent(t)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const j = (await res.json().catch(() => null)) as
        | { name?: string }
        | null;
      if (j?.name && !name.trim()) setName(j.name);
    } catch {
      // Best-effort; the user can type the name manually.
    } finally {
      setLookingUp(false);
    }
  }, [ticker, name]);

  const canAdd =
    ticker.trim().length > 0 &&
    name.trim().length > 0 &&
    sector.trim().length > 0 &&
    subTheme.trim().length > 0;

  const submit = useCallback(async () => {
    setErr(null);
    const t = ticker.trim().toUpperCase();
    if (!t || !name.trim() || !sector.trim() || !subTheme.trim()) {
      setErr("Ticker, name, theme and sub-theme are all required.");
      return;
    }
    const ok = await onAdd({
      ticker: t,
      companyName: name.trim(),
      sector: sector.trim(),
      subTheme: subTheme.trim(),
    });
    if (ok) {
      setTicker("");
      setName("");
      setSubTheme("");
      // Keep the sector selected — adding several names to the same theme is
      // the common case.
    }
  }, [ticker, name, sector, subTheme, onAdd]);

  return (
    <div style={addCard}>
      <div style={addTitle}>Add a stock</div>
      <div style={addGrid}>
        <AddField label="Ticker">
          <input
            value={ticker}
            onChange={(e) => setTicker(e.target.value)}
            onBlur={() => void onTickerBlur()}
            placeholder="NVDA"
            style={input}
            autoCapitalize="characters"
          />
        </AddField>
        <AddField label={lookingUp ? "Name (looking up…)" : "Name"}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="NVIDIA Corp."
            style={input}
          />
        </AddField>
        <AddField label="Theme">
          <input
            list="add-sector-options"
            value={sector}
            onChange={(e) => setSector(e.target.value)}
            placeholder="Pick or type a theme"
            style={input}
          />
          <datalist id="add-sector-options">
            {sectorOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </AddField>
        <AddField label="Sub-Theme">
          <input
            list="add-subtheme-options"
            value={subTheme}
            onChange={(e) => setSubTheme(e.target.value)}
            placeholder="Pick or type a sub-theme"
            style={input}
          />
          <datalist id="add-subtheme-options">
            {subThemeOptions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </AddField>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!canAdd}
          style={{ ...btnPrimary, opacity: canAdd ? 1 : 0.5, whiteSpace: "nowrap" }}
        >
          Add
        </button>
      </div>
      {err && <p style={{ ...errStyle, marginTop: "0.4rem" }}>{err}</p>}
    </div>
  );
}

function AddField({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", flex: "1 1 0", minWidth: 0 }}>
      <span style={{ color: "#8c99a8", fontSize: "0.75rem", marginBottom: 2 }}>
        {label}
      </span>
      {children}
    </label>
  );
}

function FilterInput({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", flex: "1 1 0" }}>
      <span style={{ color: "#8c99a8", fontSize: "0.75rem", marginBottom: 2 }}>
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        style={input}
      />
    </label>
  );
}

// ——— Styles ———
const overlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 50,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "1rem",
};
const backdrop: CSSProperties = {
  position: "absolute",
  inset: 0,
  background: "rgba(5, 8, 14, 0.7)",
};
const panel: CSSProperties = {
  position: "relative",
  width: "min(720px, 100%)",
  maxHeight: "90vh",
  background: "#1a2130",
  color: "#e6ebf2",
  border: "1px solid #2a3444",
  borderRadius: 10,
  boxShadow: "0 20px 60px rgba(0, 0, 0, 0.5)",
  display: "flex",
  flexDirection: "column",
};
const header: CSSProperties = {
  padding: "1rem 1.25rem 0.25rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
};
const title: CSSProperties = {
  fontSize: "1.1rem",
  fontWeight: 600,
  margin: 0,
  color: "#f2f5f9",
};
const closeBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  color: "#8c99a8",
  fontSize: "1.35rem",
  cursor: "pointer",
  lineHeight: 1,
  padding: "0.15rem 0.4rem",
};
const tabs: CSSProperties = {
  display: "flex",
  gap: "0.25rem",
  padding: "0 1.25rem",
  borderBottom: "1px solid #2a3444",
};
const tabBtn: CSSProperties = {
  background: "transparent",
  border: "none",
  padding: "0.6rem 0.75rem",
  cursor: "pointer",
  fontSize: "0.92rem",
  fontWeight: 500,
};
const body: CSSProperties = {
  padding: "1rem 1.25rem",
  overflow: "auto",
  flex: 1,
};
const footer: CSSProperties = {
  padding: "0.75rem 1.25rem",
  borderTop: "1px solid #2a3444",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "#141a25",
  borderBottomLeftRadius: 10,
  borderBottomRightRadius: 10,
};
const hint: CSSProperties = {
  color: "#8c99a8",
  fontSize: "0.85rem",
  margin: "0 0 0.5rem",
};
const code: CSSProperties = {
  background: "#0f141d",
  color: "#c7d0dc",
  padding: "0.05rem 0.3rem",
  borderRadius: 3,
  fontSize: "0.82em",
};
const dropZone: CSSProperties = {
  border: "1px dashed #384454",
  borderRadius: 8,
  padding: "1.75rem",
  textAlign: "center",
  cursor: "pointer",
  transition: "background 120ms, border-color 120ms",
};
const textarea: CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.7rem",
  background: "#0f141d",
  border: "1px solid #2a3444",
  borderRadius: 6,
  color: "#e6ebf2",
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: "0.85rem",
  resize: "vertical",
};
const input: CSSProperties = {
  width: "100%",
  boxSizing: "border-box",
  padding: "0.4rem 0.55rem",
  background: "#0f141d",
  border: "1px solid #2a3444",
  borderRadius: 5,
  color: "#e6ebf2",
  fontSize: "0.88rem",
};
const filterRow: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginBottom: "0.6rem",
};
const addCard: CSSProperties = {
  border: "1px solid #2a3444",
  borderRadius: 8,
  background: "#141a25",
  padding: "0.65rem 0.75rem",
  marginBottom: "0.75rem",
};
const addTitle: CSSProperties = {
  color: "#c7d0dc",
  fontSize: "0.8rem",
  fontWeight: 600,
  marginBottom: "0.45rem",
};
const addGrid: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "flex-end",
  flexWrap: "wrap",
};
const actionRow: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  marginTop: "0.75rem",
};
const btnBase: CSSProperties = {
  padding: "0.45rem 0.9rem",
  borderRadius: 6,
  border: "1px solid transparent",
  fontSize: "0.9rem",
  fontWeight: 500,
  cursor: "pointer",
};
const btnPrimary: CSSProperties = {
  ...btnBase,
  background: "#3a6ae4",
  color: "#fff",
  borderColor: "#3a6ae4",
};
const btnSuccess: CSSProperties = {
  ...btnBase,
  background: "#1f8a4d",
  color: "#fff",
  borderColor: "#1f8a4d",
};
const btnGhost: CSSProperties = {
  ...btnBase,
  background: "transparent",
  color: "#c7d0dc",
  borderColor: "#384454",
};
const removeBtn: CSSProperties = {
  background: "transparent",
  border: "1px solid #384454",
  color: "#ff8d8d",
  borderRadius: 4,
  width: 26,
  height: 26,
  lineHeight: 1,
  fontSize: "1rem",
  cursor: "pointer",
  padding: 0,
};
const editBtn: CSSProperties = {
  ...removeBtn,
  color: "#8c99a8",
  fontSize: "0.85rem",
};
const actionGroup: CSSProperties = {
  display: "flex",
  gap: "0.35rem",
  justifyContent: "flex-end",
  alignItems: "center",
};
const btnCompact: CSSProperties = {
  padding: "0.25rem 0.5rem",
  fontSize: "0.78rem",
};
const errStyle: CSSProperties = {
  color: "#ff8d8d",
  fontSize: "0.85rem",
  marginTop: "0.5rem",
};
const tableWrap: CSSProperties = {
  border: "1px solid #2a3444",
  borderRadius: 6,
  overflow: "auto",
  maxHeight: "40vh",
};
const table: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "0.88rem",
};
const th: CSSProperties = {
  textAlign: "left",
  padding: "0.45rem 0.65rem",
  borderBottom: "1px solid #2a3444",
  background: "#141a25",
  color: "#c7d0dc",
  fontWeight: 600,
  position: "sticky",
  top: 0,
};
const td: CSSProperties = {
  padding: "0.4rem 0.65rem",
  borderBottom: "1px solid #222b3a",
  color: "#e6ebf2",
};
const tdTicker: CSSProperties = {
  ...td,
  fontWeight: 600,
  color: "#f2f5f9",
  fontFamily: "ui-monospace, Menlo, monospace",
};
const tdSub: CSSProperties = {
  ...td,
  color: "#6aa6ff",
};
const actionTd: CSSProperties = {
  ...td,
  textAlign: "right",
  padding: "0.25rem 0.5rem",
  verticalAlign: "middle",
};
const cellInput: CSSProperties = {
  ...input,
  padding: "0.25rem 0.4rem",
  fontSize: "0.85rem",
};
