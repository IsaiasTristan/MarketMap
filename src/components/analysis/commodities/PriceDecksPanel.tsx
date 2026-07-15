"use client";
/**
 * PRICE DECKS: per-user deck presets. Click = overlay on the chart (cyan
 * dashed); ⧉ copies the 360-month expansion for Excel. Disabled with an
 * explanatory note whenever a basis differential is plotted — decks only make
 * sense on flat prices/outrights.
 */
import { useState } from "react";
import { contractMonthLabel } from "@/lib/commodities/format";
import type { PriceDeckDto } from "@/types/commodities";
import { copyTsv } from "./clipboard";
import { DeckEditorModal } from "./DeckEditorModal";
import { fetchDeckExpansion, usePriceDeckMutations } from "./useCommodities";

function deckRuleText(d: PriceDeckDto): string {
  const terminal =
    d.terminalRule === "FLAT"
      ? `flat ${[d.terminalValueOil !== null ? `$${d.terminalValueOil} oil` : null, d.terminalValueGas !== null ? `$${d.terminalValueGas} gas` : null, d.terminalValueNgl !== null ? `${d.terminalValueNgl}¢ ngl` : null].filter(Boolean).join(" / ") || "—"}`
      : d.terminalRule === "STRIP_AVG"
        ? "strip avg thereafter"
        : d.terminalRule === "TRAILING_STRIP_AVG"
          ? "LTM of strip thereafter"
          : `escalate ${d.escalationPctPerYear ?? 0}%/yr`;
  const haircut = d.haircutPct ? ` × ${(1 - d.haircutPct / 100).toFixed(2)} haircut` : "";
  return `strip ${d.stripMonths}${haircut} → ${terminal}`;
}

export function PriceDecksPanel({
  decks,
  deckAllowed,
  activeDeckId,
  onToggleDeck,
  focusCode,
  basisMode,
  curveName,
  unit,
  decimals,
  onCopied,
}: {
  decks: PriceDeckDto[];
  deckAllowed: boolean;
  activeDeckId: string | null;
  onToggleDeck: (id: string | null) => void;
  focusCode: string | null;
  basisMode: "DIFF" | "OUT";
  curveName: string;
  unit: string;
  decimals: number;
  onCopied: (msg: string) => void;
}) {
  const { remove } = usePriceDeckMutations();
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingDeck, setEditingDeck] = useState<PriceDeckDto | null>(null);

  const copyExpansion = async (deck: PriceDeckDto) => {
    if (!focusCode) return;
    try {
      const { months } = await fetchDeckExpansion(deck.id, focusCode, basisMode);
      const rows: (string | number)[][] = [
        ["MONTH", `${curveName} DECK — ${deck.name} (${unit})`],
        ...months.map((m) => [contractMonthLabel(m.month), m.price.toFixed(decimals)]),
      ];
      const ok = await copyTsv(rows);
      onCopied(ok ? `COPIED ${months.length}-MO DECK` : "COPY BLOCKED");
    } catch (e) {
      onCopied(e instanceof Error ? e.message : "DECK EXPANSION FAILED");
    }
  };

  return (
    <div className="cmdx-panel">
      <div className="cmdx-phead">
        <span className="t">PRICE DECKS</span>
        <span className="sub">flat-price curves only</span>
        <div className="right">
          <button
            className="cmdx-btn-ghost"
            onClick={() => {
              setEditingDeck(null);
              setEditorOpen(true);
            }}
          >
            NEW +
          </button>
        </div>
      </div>
      <div className="cmdx-pbody">
        {!deckAllowed && (
          <div className="cmdx-decknote">
            DECK OVERLAY DISABLED — A BASIS DIFFERENTIAL IS PLOTTED. SWITCH BASIS MODE TO OUTRIGHT, OR FOCUS A FLAT-PRICE CURVE.
          </div>
        )}
        {decks.length === 0 && (
          <div className="cmdx-footnote" style={{ padding: "6px 0" }}>
            NO DECKS YET — NEW + opens the editor (strip tenor, flat / strip-avg / LTM-of-strip / escalation, haircut).
          </div>
        )}
        {decks.map((d) => (
          <div
            key={d.id}
            className={`cmdx-deck${activeDeckId === d.id && deckAllowed ? " on" : ""}${deckAllowed ? "" : " disabled"}`}
            onClick={() => {
              if (!deckAllowed) return;
              onToggleDeck(activeDeckId === d.id ? null : d.id);
            }}
          >
            <div>
              <div className="name">{d.name}</div>
              <div className="rule">{deckRuleText(d)}</div>
            </div>
            <div className="cta">
              <button
                className="cmdx-btn-ghost"
                title="edit deck"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingDeck(d);
                  setEditorOpen(true);
                }}
              >
                ✎
              </button>
              <button
                className="cmdx-btn-primary"
                disabled={!deckAllowed}
                onClick={(e) => {
                  e.stopPropagation();
                  void copyExpansion(d);
                }}
              >
                ⧉ EXCEL
              </button>
              <button
                className="cmdx-btn-ghost"
                title="delete deck"
                onClick={(e) => {
                  e.stopPropagation();
                  if (activeDeckId === d.id) onToggleDeck(null);
                  remove.mutate(d.id);
                }}
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ padding: "0 10px 8px" }} className="cmdx-footnote">
        CLICK = OVERLAY ON CHART · ✎ = EDIT LEVERS · ⧉ = COPY MONTHLY SERIES FOR EXCEL
      </div>
      <DeckEditorModal open={editorOpen} deck={editingDeck} onClose={() => setEditorOpen(false)} onSaved={onCopied} />
    </div>
  );
}
