"use client";
/**
 * Price-deck editor (create + edit): all the levers — strip tenor with quick
 * presets, terminal rule (flat $ by group / whole-window strip average /
 * trailing-12M-of-strip "LTM" / escalation), haircut, horizon. Portal modal,
 * ESC/backdrop close, same conventions as ManageSetsModal.
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { DeckTerminalRuleCode, PriceDeckDto } from "@/types/commodities";
import { usePriceDeckMutations } from "./useCommodities";

const STRIP_PRESETS = [12, 24, 36, 60];

const RULES: { id: DeckTerminalRuleCode; label: string; hint: string }[] = [
  { id: "FLAT", label: "FLAT NUMBER", hint: "hold a fixed $ by commodity group" },
  { id: "STRIP_AVG", label: "STRIP AVG", hint: "hold the average of the whole strip window" },
  { id: "TRAILING_STRIP_AVG", label: "LTM OF STRIP", hint: "hold the average of the final 12 strip months (60mo window → months 48–60)" },
  { id: "ESCALATE", label: "ESCALATE", hint: "strip avg compounding %/yr" },
];

interface Draft {
  name: string;
  stripMonths: number;
  terminalRule: DeckTerminalRuleCode;
  terminalValueOil: string;
  terminalValueGas: string;
  terminalValueNgl: string;
  escalationPctPerYear: string;
  haircutPct: string;
  horizonMonths: number;
}

function draftFrom(deck: PriceDeckDto | null): Draft {
  return {
    name: deck?.name ?? "",
    stripMonths: deck?.stripMonths ?? 36,
    terminalRule: deck?.terminalRule ?? "FLAT",
    terminalValueOil: deck?.terminalValueOil?.toString() ?? "",
    terminalValueGas: deck?.terminalValueGas?.toString() ?? "",
    terminalValueNgl: deck?.terminalValueNgl?.toString() ?? "",
    escalationPctPerYear: deck?.escalationPctPerYear?.toString() ?? "",
    haircutPct: deck?.haircutPct?.toString() ?? "",
    horizonMonths: deck?.horizonMonths ?? 360,
  };
}

function numOrNull(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const inputStyle = {
  fontFamily: "var(--font-mono)",
  fontSize: 11,
  background: "#0d0d0d",
  color: "#fff",
  border: "1px solid #2a2a2a",
  padding: "3px 6px",
} as const;

export function DeckEditorModal({
  open,
  deck,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** null = create mode. */
  deck: PriceDeckDto | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const { create, update } = usePriceDeckMutations();
  const [mounted, setMounted] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftFrom(deck));

  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (open) setDraft(draftFrom(deck));
  }, [open, deck]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted || !open) return null;

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  const save = () => {
    const name = draft.name.trim();
    if (!name) {
      onSaved("DECK NAME REQUIRED");
      return;
    }
    const body = {
      name,
      stripMonths: Math.max(1, Math.min(120, Math.round(draft.stripMonths) || 36)),
      terminalRule: draft.terminalRule,
      terminalValueOil: numOrNull(draft.terminalValueOil),
      terminalValueGas: numOrNull(draft.terminalValueGas),
      terminalValueNgl: numOrNull(draft.terminalValueNgl),
      escalationPctPerYear: numOrNull(draft.escalationPctPerYear),
      haircutPct: numOrNull(draft.haircutPct),
      horizonMonths: Math.max(12, Math.min(600, Math.round(draft.horizonMonths) || 360)),
    };
    const done = () => {
      onSaved(deck ? "DECK UPDATED" : "DECK CREATED");
      onClose();
    };
    if (deck) update.mutate({ id: deck.id, ...body }, { onSuccess: done, onError: (e) => onSaved(e.message) });
    else create.mutate(body, { onSuccess: done, onError: (e) => onSaved(e.message) });
  };

  const row = { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 } as const;

  return createPortal(
    <div
      className="cmdx-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdx-modal" style={{ width: 460 }}>
        <div className="cmdx-phead">
          <span className="t">{deck ? "EDIT PRICE DECK" : "NEW PRICE DECK"}</span>
          <div className="right">
            <button className="cmdx-btn-ghost" onClick={onClose}>
              ✕ CLOSE
            </button>
          </div>
        </div>
        <div style={{ padding: 12 }}>
          <div style={row}>
            <span className="cmdx-lbl" style={{ width: 92 }}>
              NAME
            </span>
            <input
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. PDP HEDGE DECK"
              style={{ ...inputStyle, flex: 1 }}
            />
          </div>

          <div style={row}>
            <span className="cmdx-lbl" style={{ width: 92 }}>
              STRIP TENOR
            </span>
            <input
              type="number"
              min={1}
              max={120}
              value={draft.stripMonths}
              onChange={(e) => set({ stripMonths: Number(e.target.value) })}
              style={{ ...inputStyle, width: 64 }}
            />
            <span className="cmdx-footnote">MO</span>
            <div className="cmdx-seg">
              {STRIP_PRESETS.map((m) => (
                <button key={m} className={draft.stripMonths === m ? "on" : ""} onClick={() => set({ stripMonths: m })}>
                  {m}
                </button>
              ))}
            </div>
          </div>

          <div style={{ ...row, alignItems: "flex-start" }}>
            <span className="cmdx-lbl" style={{ width: 92, paddingTop: 4 }}>
              THEREAFTER
            </span>
            <div style={{ flex: 1 }}>
              {RULES.map((r) => (
                <label key={r.id} style={{ display: "flex", alignItems: "baseline", gap: 7, marginBottom: 4, cursor: "pointer" }}>
                  <input
                    type="radio"
                    name="cmdx-deck-rule"
                    checked={draft.terminalRule === r.id}
                    onChange={() => set({ terminalRule: r.id })}
                    style={{ accentColor: "#ffb700", margin: 0 }}
                  />
                  <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: draft.terminalRule === r.id ? "var(--bb-amber-bg)" : "#e8eef6", fontWeight: 600 }}>
                    {r.label}
                  </span>
                  <span className="cmdx-footnote">{r.hint}</span>
                </label>
              ))}
            </div>
          </div>

          {draft.terminalRule === "FLAT" && (
            <div style={row}>
              <span className="cmdx-lbl" style={{ width: 92 }}>
                FLAT VALUES
              </span>
              <span className="cmdx-footnote">OIL $</span>
              <input value={draft.terminalValueOil} onChange={(e) => set({ terminalValueOil: e.target.value })} placeholder="65" style={{ ...inputStyle, width: 58 }} />
              <span className="cmdx-footnote">GAS $</span>
              <input value={draft.terminalValueGas} onChange={(e) => set({ terminalValueGas: e.target.value })} placeholder="3.75" style={{ ...inputStyle, width: 58 }} />
              <span className="cmdx-footnote">NGL ¢</span>
              <input value={draft.terminalValueNgl} onChange={(e) => set({ terminalValueNgl: e.target.value })} placeholder="62" style={{ ...inputStyle, width: 58 }} />
            </div>
          )}
          {draft.terminalRule === "ESCALATE" && (
            <div style={row}>
              <span className="cmdx-lbl" style={{ width: 92 }}>
                ESCALATION
              </span>
              <input value={draft.escalationPctPerYear} onChange={(e) => set({ escalationPctPerYear: e.target.value })} placeholder="2" style={{ ...inputStyle, width: 58 }} />
              <span className="cmdx-footnote">% PER YEAR (compounds off the strip avg)</span>
            </div>
          )}

          <div style={row}>
            <span className="cmdx-lbl" style={{ width: 92 }}>
              HAIRCUT
            </span>
            <input value={draft.haircutPct} onChange={(e) => set({ haircutPct: e.target.value })} placeholder="—" style={{ ...inputStyle, width: 58 }} />
            <span className="cmdx-footnote">% OFF THE STRIP PORTION (e.g. 5 → ×0.95); flows into strip-based terminals</span>
          </div>

          <div style={row}>
            <span className="cmdx-lbl" style={{ width: 92 }}>
              HORIZON
            </span>
            <input
              type="number"
              min={12}
              max={600}
              value={draft.horizonMonths}
              onChange={(e) => set({ horizonMonths: Number(e.target.value) })}
              style={{ ...inputStyle, width: 64 }}
            />
            <span className="cmdx-footnote">MONTHS OF OUTPUT (default 360 = 30Y)</span>
          </div>

          <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
            <button className="cmdx-btn-primary" style={{ flex: 1, padding: "5px 0" }} onClick={save}>
              {deck ? "SAVE CHANGES" : "CREATE DECK"}
            </button>
            <button className="cmdx-btn-ghost" style={{ flex: 0.4 }} onClick={onClose}>
              CANCEL
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
