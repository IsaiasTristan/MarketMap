"use client";
/**
 * MANAGE SETS modal: create/rename/delete sets, add/remove/reorder curves
 * within the selected set. Flat dark panel, ESC/backdrop close. All writes
 * go through the /api/commodities/sets CRUD hooks.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CurveInfoDto, CurveSetDto } from "@/types/commodities";
import { useCurveSetMutations } from "./useCommodities";

export function ManageSetsModal({
  open,
  onClose,
  sets,
  registry,
  activeSetId,
  onSelectSet,
}: {
  open: boolean;
  onClose: () => void;
  sets: CurveSetDto[];
  registry: CurveInfoDto[];
  activeSetId: string | null;
  onSelectSet: (id: string) => void;
}) {
  const { create, rename, remove, replaceItems } = useCurveSetMutations();
  const [mounted, setMounted] = useState(false);
  const [editSetId, setEditSetId] = useState<string | null>(activeSetId);
  const [draftName, setDraftName] = useState("");
  const [renaming, setRenaming] = useState(false);

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (open) setEditSetId(activeSetId ?? sets[0]?.id ?? null);
  }, [open, activeSetId, sets]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;
  const editSet = sets.find((s) => s.id === editSetId) ?? null;
  const inSet = new Set(editSet?.items.map((i) => i.curveCode) ?? []);

  const mutateItems = (items: { curveCode: string; pinned: boolean }[]) => {
    if (!editSet) return;
    replaceItems.mutate({ id: editSet.id, items });
  };

  const move = (code: string, dir: -1 | 1) => {
    if (!editSet) return;
    const items = editSet.items.map((i) => ({ curveCode: i.curveCode, pinned: i.pinned }));
    const idx = items.findIndex((i) => i.curveCode === code);
    const j = idx + dir;
    if (idx < 0 || j < 0 || j >= items.length) return;
    [items[idx], items[j]] = [items[j]!, items[idx]!];
    mutateItems(items);
  };

  return createPortal(
    <div
      className="cmdx-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdx-modal" style={{ width: 640 }}>
        <div className="cmdx-phead">
          <span className="t">MANAGE CURVE SETS</span>
          <div className="right">
            <button className="cmdx-btn-ghost" onClick={onClose}>
              ✕ CLOSE
            </button>
          </div>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 8, padding: 10, maxHeight: "68vh", overflow: "auto" }}>
          <div>
            <div className="cmdx-lbl" style={{ marginBottom: 6 }}>
              SETS
            </div>
            {sets.map((s) => (
              <div
                key={s.id}
                className={`cmdx-deck${s.id === editSetId ? " on" : ""}`}
                onClick={() => setEditSetId(s.id)}
              >
                <div className="name">{s.name}</div>
                <div className="cta">
                  <button
                    className="cmdx-btn-ghost"
                    title="delete set"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove.mutate(s.id);
                      if (editSetId === s.id) setEditSetId(null);
                    }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
            <div style={{ display: "flex", gap: 5, marginTop: 8 }}>
              <input
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={renaming ? "NEW NAME" : "NEW SET NAME"}
                style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 10.5, background: "#0d0d0d", color: "#fff", border: "1px solid #2a2a2a", padding: "3px 6px" }}
              />
              <button
                className="cmdx-btn-primary"
                style={{ fontSize: 10 }}
                onClick={() => {
                  const name = draftName.trim();
                  if (!name) return;
                  if (renaming && editSet) {
                    rename.mutate({ id: editSet.id, name });
                  } else {
                    create.mutate(
                      { name },
                      { onSuccess: (s) => { setEditSetId(s.id); onSelectSet(s.id); } },
                    );
                  }
                  setDraftName("");
                  setRenaming(false);
                }}
              >
                {renaming ? "RENAME" : "ADD"}
              </button>
            </div>
            {editSet && (
              <button className="cmdx-btn-ghost" style={{ marginTop: 6, fontSize: 10 }} onClick={() => setRenaming((v) => !v)}>
                {renaming ? "CANCEL RENAME" : `RENAME "${editSet.name}"`}
              </button>
            )}
          </div>
          <div>
            <div className="cmdx-lbl" style={{ marginBottom: 6 }}>
              {editSet ? `CURVES IN "${editSet.name}" — click ✕ to remove, ▲▼ to reorder` : "SELECT A SET"}
            </div>
            {editSet?.items.map((item) => {
              const c = registry.find((r) => r.code === item.curveCode);
              if (!c) return null;
              return (
                <div key={item.curveCode} className="cmdx-exprow" style={{ cursor: "default" }}>
                  <span className={`cmdx-grp ${c.group}`}>{c.group}</span>
                  <span>{c.name}</span>
                  <span className="u">{c.unit}</span>
                  <button className="cmdx-btn-ghost" style={{ fontSize: 9 }} onClick={() => move(item.curveCode, -1)}>
                    ▲
                  </button>
                  <button className="cmdx-btn-ghost" style={{ fontSize: 9 }} onClick={() => move(item.curveCode, 1)}>
                    ▼
                  </button>
                  <button
                    className="cmdx-btn-ghost"
                    style={{ fontSize: 9, color: "var(--color-negative)" }}
                    onClick={() =>
                      mutateItems(
                        editSet.items.filter((i) => i.curveCode !== item.curveCode).map((i) => ({ curveCode: i.curveCode, pinned: i.pinned })),
                      )
                    }
                  >
                    ✕
                  </button>
                </div>
              );
            })}
            {editSet && (
              <>
                <div className="cmdx-lbl" style={{ margin: "10px 0 6px" }}>
                  ADD FROM REGISTRY
                </div>
                {registry
                  .filter((r) => !inSet.has(r.code))
                  .map((c) => (
                    <div
                      key={c.code}
                      className="cmdx-exprow"
                      onClick={() =>
                        mutateItems([...editSet.items.map((i) => ({ curveCode: i.curveCode, pinned: i.pinned })), { curveCode: c.code, pinned: true }])
                      }
                    >
                      <span className={`cmdx-grp ${c.group}`}>{c.group}</span>
                      <span>{c.name}</span>
                      <span className="u">
                        {c.kind === "BASIS" ? `BASIS vs ${c.benchCode}` : "FLAT"} · {c.unit}
                      </span>
                      <span style={{ color: "var(--bb-amber-bg)", fontSize: 10 }}>+ ADD</span>
                    </div>
                  ))}
              </>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
