"use client";
/**
 * COMMODITIES — forward-curve workstation. Pinnable curve sets, vintage
 * overlays on the amber ramp, realized-history bridge, basis differentials as
 * first-class curves, strip boards, price decks, futures-only exports.
 * UI spec: docs/mockups/commodities-dashboard-mockup-v4.html.
 */
import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import "@/app/(analysis)/commodities/commodities.css";
import { contractMonthLabel, shortDate } from "@/lib/commodities/format";
import { useAnalysisStore } from "@/store/analysis";
import type { CurveInfoDto } from "@/types/commodities";
import { PanelState, Muted } from "@/components/analysis/ui/PanelState";
import { AssetExportPanel } from "./AssetExportPanel";
import { CurveStructurePanel, SeasonalityPanel, StripBoard } from "./BoardPanels";
import { alignToMonths, buildChartModel, VINTAGE_ORDER, VINTAGE_RAMP } from "./chartModel";
import { copyTsv } from "./clipboard";
import { CurveChart } from "./CurveChart";
import { CurveDataModal } from "./CurveDataModal";
import { CurveDirectoryModal } from "./CurveDirectoryModal";
import { ManageSetsModal } from "./ManageSetsModal";
import { PinnedMultiples } from "./PinnedMultiples";
import { PriceDecksPanel } from "./PriceDecksPanel";
import { StripChangeTable } from "./StripChangeTable";
import { useCurveAnalytics, useCurveRegistry, useCurveSetMutations, useCurveSets, useCurveVintages, usePriceDecks } from "./useCommodities";

const GROUPS = ["ALL", "OIL", "GAS", "NGL", "OTHER"] as const;
const HISTORY_MONTH_COUNT = { OFF: 0, "1Y": 12, "2Y": 24 } as const;

export function CommoditiesClient() {
  const ui = useAnalysisStore((s) => s.commoditiesUi);
  const setUi = useAnalysisStore((s) => s.setCommoditiesUi);
  const addToast = useAnalysisStore((s) => s.addToast);
  const toast = (message: string) => addToast({ message, severity: "success" });

  const [groupFilter, setGroupFilter] = useState<(typeof GROUPS)[number]>("ALL");
  const [selection, setSelection] = useState<[number, number] | null>(null);
  const [dataModalOpen, setDataModalOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [directoryOpen, setDirectoryOpen] = useState(false);
  const [search, setSearch] = useState("");
  const qc = useQueryClient();

  const registryQ = useCurveRegistry();
  const setsQ = useCurveSets();
  const decksQ = usePriceDecks();
  const { replaceItems } = useCurveSetMutations();

  const registry = registryQ.data?.curves ?? [];
  const sets = setsQ.data?.sets ?? [];
  const activeSet = sets.find((s) => s.id === ui.setId) ?? sets[0] ?? null;
  const byCode = useMemo(() => new Map(registry.map((c) => [c.code, c])), [registry]);
  const setCurves = (activeSet?.items ?? [])
    .map((i) => byCode.get(i.curveCode))
    .filter((c): c is CurveInfoDto => !!c);
  const focusCode = ui.focusCode && setCurves.some((c) => c.code === ui.focusCode) ? ui.focusCode : (setCurves[0]?.code ?? null);
  const focusCurve = focusCode ? (byCode.get(focusCode) ?? null) : null;

  const historyMonths = HISTORY_MONTH_COUNT[ui.historyWindow];
  const activeVintageIds = VINTAGE_ORDER.filter((id) => id !== "LATEST" && ui.vintageToggles[id]);
  // Always fetch the full vintage set so legend toggles flip instantly.
  const vintagesQ = useCurveVintages(focusCode, ["1D", "1W", "1M", "3M", "6M", "1Y"], ui.basisMode, historyMonths as 0 | 12 | 24);
  const analyticsQ = useCurveAnalytics(focusCode, ui.basisMode);
  const dto = vintagesQ.data ?? null;

  const model = useMemo(
    () => (dto ? buildChartModel(dto, ui.vintageToggles, historyMonths) : null),
    [dto, ui.vintageToggles, historyMonths],
  );

  const deckAllowed = !!focusCurve && !(focusCurve.kind === "BASIS" && ui.basisMode === "DIFF");
  const activeDeck = (decksQ.data?.decks ?? []).find((d) => d.id === ui.deckId) ?? null;
  const deckExpQ = useQuery({
    queryKey: ["cmdx-deck-exp", ui.deckId, focusCode, ui.basisMode],
    enabled: !!activeDeck && !!focusCode && deckAllowed,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(`/api/commodities/decks/${ui.deckId}/expanded?curve=${focusCode}&basisMode=${ui.basisMode}`);
      if (!r.ok) return null;
      return (await r.json()) as { months: { month: string; price: number }[] };
    },
  });
  const deckOverlay =
    activeDeck && deckAllowed && model && deckExpQ.data
      ? {
          name: activeDeck.name,
          values: alignToMonths(
            deckExpQ.data.months.map((m) => ({ contractMonth: m.month, price: m.price })),
            model.months,
          ),
        }
      : null;

  const mutateSetItems = (items: { curveCode: string; pinned: boolean }[]) => {
    if (!activeSet) return;
    replaceItems.mutate({ id: activeSet.id, items });
  };

  const addCurveToSet = (code: string) => {
    if (!activeSet) return;
    const items = activeSet.items.map((i) => ({ curveCode: i.curveCode, pinned: i.pinned }));
    const wasInactive = byCode.get(code)?.isActive === false;
    if (!items.some((i) => i.curveCode === code)) {
      replaceItems.mutate(
        { id: activeSet.id, items: [...items, { curveCode: code, pinned: true }] },
        {
          onSuccess: () => {
            qc.invalidateQueries({ queryKey: ["cmdx-curves"] });
            if (wasInactive) {
              // The background single-curve ingest lands the strip within a
              // few seconds — refetch the fresh curve's data when it does.
              toast(`PULLING ${code} FROM AEGIS — STRIP LANDS IN SECONDS`);
              for (const delayMs of [4000, 12000, 30000]) {
                setTimeout(() => {
                  qc.invalidateQueries({ queryKey: ["cmdx-vintages", code] });
                  qc.invalidateQueries({ queryKey: ["cmdx-analytics", code] });
                  qc.invalidateQueries({ queryKey: ["cmdx-curves"] });
                }, delayMs);
              }
            }
          },
        },
      );
    }
    setUi({ focusCode: code });
    setSearch("");
  };

  const copyRange = async (a: number, b: number) => {
    if (!model || !dto) return;
    const rows: (string | number | null)[][] = [
      ["CONTRACT", "TYPE", ...(model.histLen > 0 ? [`REALIZED MO AVG (${dto.unit})`] : []), ...model.series.map((s) => `${dto.name} ${s.id} (${shortDate(s.resolvedDate)})`)],
    ];
    for (let i = a; i <= b; i++) {
      const isH = i < model.histLen;
      rows.push([
        model.labels[i]!,
        isH ? "HIST" : "FUT",
        ...(model.histLen > 0 ? [isH ? model.history[i]!.price.toFixed(dto.decimals) : ""] : []),
        ...model.series.map((s) => {
          if (isH) return "";
          const v = s.values[i - model.histLen];
          return v === null || v === undefined ? "" : v.toFixed(dto.decimals);
        }),
      ]);
    }
    const ok = await copyTsv(rows);
    toast(ok ? `COPIED ${b - a + 1} ROWS (${a < model.histLen ? "HIST+FUT" : "FUT"})` : "COPY BLOCKED");
  };

  const searchHits = search.trim()
    ? registry.filter((c) => (c.name + c.code).toUpperCase().includes(search.trim().toUpperCase())).slice(0, 10)
    : [];

  const chartTitle = focusCurve
    ? `${focusCurve.name}${focusCurve.kind === "BASIS" && ui.basisMode === "DIFF" ? " BASIS" : ""}`
    : "—";
  const chartModeTxt = focusCurve
    ? focusCurve.kind === "BASIS"
      ? ui.basisMode === "DIFF"
        ? `BASIS vs ${byCode.get(focusCurve.benchCode ?? "")?.name ?? focusCurve.benchCode}`
        : "OUTRIGHT (BENCH + BASIS)"
      : "FLAT PRICE"
    : "";
  const contractRange = model && model.months.length > 0
    ? `${contractMonthLabel(model.months[0]!)} → ${contractMonthLabel(model.months[model.months.length - 1]!)}`
    : null;
  const oneMonthDate = dto?.resolved.find((r) => r.id === "1M")?.resolvedDate ?? null;

  return (
    <div>
      {/* controls */}
      <div className="cmdx-controls">
        <span className="cmdx-lbl">CURVE SET</span>
        <select
          value={activeSet?.id ?? ""}
          onChange={(e) => setUi({ setId: e.target.value, focusCode: null })}
        >
          {sets.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="cmdx-btn-ghost" onClick={() => setManageOpen(true)}>
          MANAGE SETS +
        </button>
        <span className="cmdx-lbl" style={{ marginLeft: 12 }}>
          FILTER
        </span>
        <div className="cmdx-seg">
          {GROUPS.map((g) => (
            <button key={g} className={g === groupFilter ? "on" : ""} onClick={() => setGroupFilter(g)}>
              {g}
            </button>
          ))}
        </div>
        <span className="cmdx-lbl" style={{ marginLeft: 12 }}>
          BASIS MODE
        </span>
        <div className="cmdx-seg">
          <button className={ui.basisMode === "DIFF" ? "on" : ""} onClick={() => setUi({ basisMode: "DIFF" })}>
            DIFFERENTIAL
          </button>
          <button className={ui.basisMode === "OUT" ? "on" : ""} onClick={() => setUi({ basisMode: "OUT" })}>
            OUTRIGHT
          </button>
        </div>
        <span className="cmdx-lbl" style={{ marginLeft: 12 }}>
          HISTORY
        </span>
        <div className="cmdx-seg">
          {(["OFF", "1Y", "2Y"] as const).map((h) => (
            <button
              key={h}
              className={ui.historyWindow === h ? "on" : ""}
              onClick={() => {
                setSelection(null);
                setUi({ historyWindow: h });
              }}
            >
              {h}
            </button>
          ))}
        </div>
        <span className="cmdx-footnote" style={{ marginLeft: "auto" }}>
          {dto
            ? `LATEST SETTLE ${shortDate(dto.latestSettleDate)} · SRC: AEGIS ODATA · SNAPSHOTS ${Math.min(dto.snapshotCount, 251)}/251 DAYS`
            : "SRC: AEGIS ODATA"}
        </span>
      </div>

      {/* curve chips + search */}
      <div className="cmdx-chipbar">
        <span className="cmdx-lbl" style={{ marginRight: 2 }}>
          CURVES
        </span>
        {setCurves
          .filter((c) => groupFilter === "ALL" || c.group === groupFilter)
          .map((c) => {
            const item = activeSet?.items.find((i) => i.curveCode === c.code);
            return (
              <div
                key={c.code}
                className={`cmdx-chip${c.code === focusCode ? " focused" : ""}`}
                onClick={() => setUi({ focusCode: c.code })}
              >
                <span className={`cmdx-grp ${c.group}`}>{c.group}</span>
                <b>{c.name}</b>
                <span className="px num">{c.latestPrompt === null ? "—" : c.latestPrompt.toLocaleString("en-US", { minimumFractionDigits: c.decimals, maximumFractionDigits: c.decimals })}</span>
                <span
                  className={`pin${item?.pinned ? " pinned" : ""}`}
                  title="pin to small multiples"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!activeSet) return;
                    mutateSetItems(activeSet.items.map((i) => ({ curveCode: i.curveCode, pinned: i.curveCode === c.code ? !i.pinned : i.pinned })));
                  }}
                >
                  ◆
                </span>
                <span
                  className="rm"
                  title="remove from set"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!activeSet) return;
                    mutateSetItems(activeSet.items.filter((i) => i.curveCode !== c.code).map((i) => ({ curveCode: i.curveCode, pinned: i.pinned })));
                    if (focusCode === c.code) setUi({ focusCode: null });
                  }}
                >
                  ✕
                </span>
              </div>
            );
          })}
        <button
          className="cmdx-btn-ghost"
          style={{ marginLeft: "auto", whiteSpace: "nowrap", fontSize: 11, border: "1px solid #2a2a2a", background: "#0d0d0d", padding: "4px 8px", cursor: "pointer", color: "var(--text-secondary)" }}
          onClick={() => setDirectoryOpen(true)}
        >
          DIRECTORY ▤
        </button>
        <div className="cmdx-searchwrap" style={{ marginLeft: 0 }}>
          <span className="mag">⌕</span>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="SEARCH ALL CURVES — e.g. AECO, RBOB, BRENT…"
            autoComplete="off"
          />
          {searchHits.length > 0 && (
            <div className="cmdx-sdrop">
              {searchHits.map((c) => (
                <div key={c.code} className="cmdx-sopt" onClick={() => addCurveToSet(c.code)}>
                  <span className={`cmdx-grp ${c.group}`}>{c.group}</span>
                  <span className="nm">{c.name}</span>
                  <span className="meta">
                    {c.kind === "BASIS" ? `BASIS vs ${c.benchCode}` : "FLAT"} · {c.unit}
                    {setCurves.some((s) => s.code === c.code) ? " · IN SET" : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* main grid */}
      <div className="cmdx-main">
        <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
          <div className="cmdx-panel">
            <div className="cmdx-phead">
              <span className="t">{chartTitle}</span>
              <span className="sub">
                {chartModeTxt}
                {focusCurve ? ` · ${focusCurve.unit}` : ""}
                {historyMonths ? ` · ${historyMonths}MO REALIZED +` : " ·"} {model?.months.length ?? 60}MO STRIP
                {dto ? ` · LATEST SETTLE ${shortDate(dto.latestSettleDate)}` : ""}
              </span>
              <div className="right">
                <div className="cmdx-vlegend">
                  {historyMonths > 0 && (
                    <span className="cmdx-vbtn on" style={{ cursor: "default" }}>
                      <span className="sw" style={{ borderColor: "#8fa3b8" }} />
                      REALIZED<span className="dt">MONTHLY AVG</span>
                    </span>
                  )}
                  {VINTAGE_ORDER.map((id) => {
                    const on = !!ui.vintageToggles[id];
                    const date =
                      id === "LATEST" ? dto?.latestSettleDate : (dto?.resolved.find((r) => r.id === id)?.resolvedDate ?? null);
                    return (
                      <span
                        key={id}
                        className={`cmdx-vbtn ${on ? "on" : "off"}`}
                        onClick={() => setUi({ vintageToggles: { ...ui.vintageToggles, [id]: !on } })}
                      >
                        <span className="sw" style={{ borderColor: VINTAGE_RAMP[id].color }} />
                        {id}
                        <span className="dt">{date ? shortDate(date) : "—"}</span>
                      </span>
                    );
                  })}
                </div>
                <button className="cmdx-btn-primary" style={{ padding: "2px 10px", fontSize: 10 }} onClick={() => setDataModalOpen(true)} disabled={!model}>
                  DATA TABLE ▦
                </button>
              </div>
            </div>
            <PanelState state={vintagesQ.state} error={vintagesQ.error}>
              {model && dto ? (
                <div style={{ position: "relative" }}>
                  {selection && selection[1] > selection[0] && (
                    <div className="cmdx-selinfo" style={{ zIndex: 5 }}>
                      <span>
                        {model.labels[selection[0]]} → {model.labels[selection[1]]} ({selection[1] - selection[0] + 1} MO)
                      </span>
                      <button className="cmdx-btn-primary" onClick={() => void copyRange(selection[0], selection[1])}>
                        COPY RANGE ⧉
                      </button>
                      <button className="cmdx-btn-ghost" onClick={() => setSelection(null)}>
                        ✕
                      </button>
                    </div>
                  )}
                  <CurveChart
                    model={model}
                    decimals={dto.decimals}
                    latestSettleDate={dto.latestSettleDate}
                    deck={deckOverlay}
                    selection={selection}
                    onSelectionChange={setSelection}
                  />
                  <div style={{ display: "flex", gap: 14, padding: "4px 10px 7px" }} className="cmdx-footnote">
                    <span>DRAG TO SELECT MONTHS (HIST OR FUT) → COPY, OR OPEN DATA TABLE ▦ TO VERIFY + COPY ROWS</span>
                    <span style={{ marginLeft: "auto" }}>
                      DECK: <span style={{ color: "var(--bb-amber-bg)" }}>{deckOverlay ? deckOverlay.name : deckAllowed ? "NONE" : "N/A ON BASIS"}</span>
                    </span>
                  </div>
                </div>
              ) : (
                <Muted>accruing snapshots — 0/251 days</Muted>
              )}
            </PanelState>
          </div>

          <PanelState state={analyticsQ.state} error={analyticsQ.error}>
            {analyticsQ.data && focusCurve ? (
              <StripChangeTable analytics={analyticsQ.data} curveName={focusCurve.name} decimals={focusCurve.decimals} onCopied={toast} />
            ) : (
              <div />
            )}
          </PanelState>
        </div>

        {/* right rail */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <PanelState state={analyticsQ.state} error={analyticsQ.error}>
            {analyticsQ.data && focusCurve ? (
              <>
                <StripBoard analytics={analyticsQ.data} curveName={focusCurve.name} unit={focusCurve.unit} decimals={focusCurve.decimals} onCopied={toast} />
                <CurveStructurePanel analytics={analyticsQ.data} unit={focusCurve.unit} decimals={focusCurve.decimals} />
                <SeasonalityPanel analytics={analyticsQ.data} unit={focusCurve.unit} decimals={focusCurve.decimals} />
              </>
            ) : (
              <div />
            )}
          </PanelState>
          <PriceDecksPanel
            decks={decksQ.data?.decks ?? []}
            deckAllowed={deckAllowed}
            activeDeckId={ui.deckId}
            onToggleDeck={(id) => setUi({ deckId: id })}
            focusCode={focusCode}
            basisMode={ui.basisMode}
            curveName={focusCurve?.name ?? ""}
            unit={focusCurve?.unit ?? ""}
            decimals={focusCurve?.decimals ?? 2}
            onCopied={toast}
          />
          <AssetExportPanel
            setCurves={setCurves}
            resolved={dto?.resolved ?? []}
            latestSettleDate={dto?.latestSettleDate ?? null}
            basisMode={ui.basisMode}
            contractRange={contractRange}
            onCopied={toast}
          />
        </div>
      </div>

      <PinnedMultiples
        curves={setCurves.filter((c) => activeSet?.items.find((i) => i.curveCode === c.code)?.pinned)}
        basisMode={ui.basisMode}
        focusCode={focusCode}
        onFocus={(code) => {
          setUi({ focusCode: code });
          window.scrollTo({ top: 0, behavior: "smooth" });
        }}
        latestSettleDate={dto?.latestSettleDate ?? null}
        oneMonthDate={oneMonthDate}
      />

      {model && dto && (
        <CurveDataModal
          open={dataModalOpen}
          onClose={() => setDataModalOpen(false)}
          model={model}
          curveName={dto.name}
          unit={dto.unit}
          decimals={dto.decimals}
          latestSettleDate={dto.latestSettleDate}
          selection={selection}
          onSelectionChange={setSelection}
          onCopied={toast}
        />
      )}
      <ManageSetsModal
        open={manageOpen}
        onClose={() => setManageOpen(false)}
        sets={sets}
        registry={registry}
        activeSetId={activeSet?.id ?? null}
        onSelectSet={(id) => setUi({ setId: id })}
      />
      <CurveDirectoryModal
        open={directoryOpen}
        onClose={() => setDirectoryOpen(false)}
        registry={registry}
        inSetCodes={new Set(setCurves.map((c) => c.code))}
        onAdd={(code) => {
          addCurveToSet(code);
          setDirectoryOpen(false);
        }}
      />
    </div>
  );
}
