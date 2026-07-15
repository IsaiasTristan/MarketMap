"use client";
/**
 * CURVE DIRECTORY: the full AEGIS catalog (~455 curves), browsable by group
 * (OIL / GAS / NGL / OTHER) with product sub-headings and a filter box.
 * Adding a directory-only curve activates it server-side and kicks a
 * background single-curve ingest — the strip appears within seconds.
 */
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { CommodityGroupCode, CurveInfoDto } from "@/types/commodities";

const GROUP_TABS: CommodityGroupCode[] = ["OIL", "GAS", "NGL", "OTHER"];

export function CurveDirectoryModal({
  open,
  onClose,
  registry,
  inSetCodes,
  onAdd,
}: {
  open: boolean;
  onClose: () => void;
  registry: CurveInfoDto[];
  inSetCodes: Set<string>;
  onAdd: (code: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [group, setGroup] = useState<CommodityGroupCode>("OIL");
  const [filter, setFilter] = useState("");

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const counts = useMemo(() => {
    const m = new Map<CommodityGroupCode, number>();
    for (const c of registry) m.set(c.group, (m.get(c.group) ?? 0) + 1);
    return m;
  }, [registry]);

  const sections = useMemo(() => {
    const q = filter.trim().toUpperCase();
    const rows = registry
      .filter((c) => c.group === group)
      .filter((c) => !q || (c.name + c.code + (c.product ?? "")).toUpperCase().includes(q));
    const byProduct = new Map<string, CurveInfoDto[]>();
    for (const c of rows) {
      const key = c.product ?? "Other";
      const list = byProduct.get(key) ?? [];
      list.push(c);
      byProduct.set(key, list);
    }
    return [...byProduct.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([product, curves]) => ({
        product,
        curves: curves.sort((a, b) => (a.name < b.name ? -1 : 1)),
      }));
  }, [registry, group, filter]);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      className="cmdx-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdx-modal" style={{ width: 720 }}>
        <div className="cmdx-phead">
          <span className="t">CURVE DIRECTORY</span>
          <span className="sub">{registry.length} AEGIS products · click + ADD to pull a curve into your set</span>
          <div className="right">
            <button className="cmdx-btn-ghost" onClick={onClose}>
              ✕ CLOSE
            </button>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: "8px 10px", borderBottom: "1px solid var(--bg-border)" }}>
          <div className="cmdx-seg">
            {GROUP_TABS.map((g) => (
              <button key={g} className={g === group ? "on" : ""} onClick={() => setGroup(g)}>
                {g} ({counts.get(g) ?? 0})
              </button>
            ))}
          </div>
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="FILTER — e.g. GASOLINE, MIDLAND, RBOB…"
            style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, background: "#0d0d0d", color: "#fff", border: "1px solid #2a2a2a", padding: "4px 8px" }}
            autoFocus
          />
        </div>
        <div style={{ maxHeight: "62vh", overflow: "auto", padding: "4px 10px 10px" }}>
          {sections.length === 0 && <div className="cmdx-accruing">NO MATCH IN {group}</div>}
          {sections.map((s) => (
            <div key={s.product}>
              <div className="cmdx-lbl" style={{ margin: "10px 0 4px" }}>
                {s.product.toUpperCase()} ({s.curves.length})
              </div>
              {s.curves.map((c) => {
                const inSet = inSetCodes.has(c.code);
                return (
                  <div
                    key={c.code}
                    className="cmdx-exprow"
                    onClick={() => {
                      if (!inSet) onAdd(c.code);
                    }}
                    style={inSet ? { cursor: "default", opacity: 0.55 } : undefined}
                  >
                    <span className={`cmdx-grp ${c.group}`}>{c.group}</span>
                    <span>{c.name}</span>
                    <span className="u">
                      {c.kind === "BASIS" ? `BASIS${c.benchCode ? ` vs ${c.benchCode}` : ""}` : "FLAT"} · {c.unit}
                      {!c.isActive ? " · NOT YET INGESTED" : ""}
                    </span>
                    <span style={{ color: inSet ? "#5a5a5a" : "var(--bb-amber-bg)", fontSize: 10, whiteSpace: "nowrap" }}>
                      {inSet ? "IN SET" : "+ ADD"}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cmdx-footnote" style={{ padding: "0 10px 8px" }}>
          NOT-YET-INGESTED CURVES PULL THEIR STRIP + 1Y OF VINTAGES ON FIRST ADD (SECONDS FOR THE STRIP, ~1 MIN FOR VINTAGES).
        </div>
      </div>
    </div>,
    document.body,
  );
}
