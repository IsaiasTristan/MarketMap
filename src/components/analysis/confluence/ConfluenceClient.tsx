"use client";
/**
 * CONFLUENCE — cross-system agreement board. Which names do FUNDAMENTALS,
 * REVISIONS, and 13F FLOWS independently agree on, and where along the
 * adoption sequence (fundamentals inflect → analysts react → funds confirm)?
 * Agreement is a COUNT (stack depth) and a LABEL (stage) — never a blended
 * score. One composed read; stage/side/sector/held filtering is client-side
 * so the funnel always shows the full census. Filters mirror to the URL
 * (?stage=&side=&group=) so funnel clicks produce shareable deep links.
 */
import { useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { PanelState } from "@/components/analysis/ui/PanelState";
import { quarterLabel } from "@/components/analysis/flows/flowsUi";
import { useAnalysisStore } from "@/store/analysis";
import { STAGE_ORDER, type Direction, type Stage } from "@/lib/analysis/confluence/rules";
import { useConfluence } from "./useConfluence";
import { StageFunnel } from "./StageFunnel";
import { ConfluenceTable } from "./ConfluenceTable";
import { ConfluenceMetricTip } from "./ConfluenceMetricTip";

const isStage = (v: string | null): v is Stage => STAGE_ORDER.includes(v as Stage);

export function ConfluenceClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activePortfolioId = useAnalysisStore((s) => s.activePortfolioId);

  const [stage, setStage] = useState<Stage | null>(null);
  const [side, setSide] = useState<Direction | null>(null);
  const [group, setGroup] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [heldOnly, setHeldOnly] = useState(false);

  // URL → state (reactive, the FlowsClient pattern).
  useEffect(() => {
    const s = searchParams.get("stage");
    setStage(isStage(s) ? s : null);
    const sd = searchParams.get("side");
    setSide(sd === "LONG" || sd === "SHORT" ? sd : null);
    setGroup(searchParams.get("group"));
  }, [searchParams]);

  // State → URL (shareable funnel/side/sector deep links).
  const syncUrl = (next: { stage?: Stage | null; side?: Direction | null; group?: string | null }) => {
    const params = new URLSearchParams();
    const st = next.stage !== undefined ? next.stage : stage;
    const si = next.side !== undefined ? next.side : side;
    const gr = next.group !== undefined ? next.group : group;
    if (st) params.set("stage", st);
    if (si) params.set("side", si);
    if (gr) params.set("group", gr);
    const qs = params.toString();
    router.replace(qs ? `/confluence?${qs}` : "/confluence", { scroll: false });
  };

  const { data, state, error } = useConfluence(heldOnly ? activePortfolioId : null);

  const sectors = useMemo(() => {
    const set = new Set<string>();
    for (const r of data?.rows ?? []) if (r.sector) set.add(r.sector);
    return [...set].sort();
  }, [data]);

  const filtered = useMemo(() => {
    let rows = data?.rows ?? [];
    if (stage) rows = rows.filter((r) => r.stage === stage);
    if (side) rows = rows.filter((r) => r.direction === side);
    if (group) rows = rows.filter((r) => r.sector === group || r.subsector === group);
    if (heldOnly) rows = rows.filter((r) => r.held !== null);
    const q = search.trim().toUpperCase();
    if (q) rows = rows.filter((r) => r.ticker.includes(q) || (r.companyName ?? "").toUpperCase().includes(q));
    return rows;
  }, [data, stage, side, group, heldOnly, search]);

  const ew = data?.asOf.effectiveWindow;
  const accruing =
    ew && ew.legAWeeks < ew.composite4wWindow ? ` (accruing wk ${ew.legAWeeks} of ${ew.composite4wWindow})` : "";

  const btn = (active: boolean): React.CSSProperties => ({
    background: active ? "var(--bb-chrome)" : "transparent",
    border: "1px solid var(--chrome-border)",
    color: active ? "#fff" : "var(--text-secondary)",
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: 0.4,
    padding: "2px 8px",
    cursor: "pointer",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Tagline + as-of stamps for all three sources (+ the factor grid). */}
      <div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          which names FUNDAMENTALS, REVISIONS and 13F FLOWS independently agree on — and where along the
          adoption sequence. Agreement is a count and a label, never a blended score.
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            flexWrap: "wrap",
            background: "var(--bb-chrome)",
            color: "#fff",
            padding: "3px 10px",
            fontSize: 10,
            letterSpacing: "0.04em",
            marginTop: 6,
          }}
        >
          <span style={{ fontWeight: 700 }}>AS OF</span>
          <span style={{ opacity: 0.85 }}>FUNDAMENTALS {data?.asOf.fundamentalsSnapshotDate ?? "—"}</span>
          <span style={{ opacity: 0.85 }}>
            · REVISIONS {data?.asOf.revisionSnapshotDate ?? "—"}
            {accruing}
          </span>
          <span style={{ opacity: 0.85 }}>
            · 13F {data?.asOf.flowPeriod ? quarterLabel(data.asOf.flowPeriod) : "—"}{" "}
            <ConfluenceMetricTip id="flowLag" style={{ color: "inherit" }}>
              lags ~45d
            </ConfluenceMetricTip>
          </span>
          <span style={{ opacity: 0.7 }}>· IDIO {data?.asOf.idioAsOf ?? "—"}</span>
        </div>
      </div>

      <PanelState state={state} error={error}>
        {data && (
          <>
            <StageFunnel
              counts={data.counts}
              active={stage}
              onToggle={(s) => {
                const next = stage === s ? null : s;
                setStage(next);
                syncUrl({ stage: next });
              }}
            />

            {/* Filters: side, sector, search, held-only. */}
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                style={btn(side === "LONG")}
                onClick={() => {
                  const next = side === "LONG" ? null : ("LONG" as const);
                  setSide(next);
                  syncUrl({ side: next });
                }}
              >
                LONG
              </button>
              <button
                type="button"
                style={btn(side === "SHORT")}
                onClick={() => {
                  const next = side === "SHORT" ? null : ("SHORT" as const);
                  setSide(next);
                  syncUrl({ side: next });
                }}
              >
                SHORT
              </button>
              <select
                value={group ?? ""}
                onChange={(e) => {
                  const next = e.target.value || null;
                  setGroup(next);
                  syncUrl({ group: next });
                }}
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--chrome-border)",
                  color: "var(--text-secondary)",
                  fontSize: 10,
                  padding: "2px 6px",
                }}
              >
                <option value="">ALL SECTORS</option>
                {sectors.map((s) => (
                  <option key={s} value={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </select>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="ticker / name…"
                style={{
                  background: "var(--bg-surface)",
                  border: "1px solid var(--chrome-border)",
                  color: "var(--text-primary)",
                  fontSize: 10,
                  padding: "2px 6px",
                  width: 130,
                }}
              />
              {activePortfolioId && (
                <button type="button" style={btn(heldOnly)} onClick={() => setHeldOnly((h) => !h)}>
                  HELD ONLY
                </button>
              )}
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {filtered.length} of {data.rows.length} rows · coverage F {data.coverage.fundamentals} · R{" "}
                {data.coverage.revisions} · 13F {data.coverage.flows}
              </span>
            </div>

            <ConfluenceTable rows={filtered} asOf={data.asOf} showWeight={heldOnly} />

            {data.singleTruncated > 0 && (
              <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "0 8px" }}>
                {data.singleTruncated} additional single-source rows not shown (rank-truncated) — the full
                single-signal lists live on the FUNDAMENTALS / RESEARCH / FLOWS tabs.
              </div>
            )}
          </>
        )}
      </PanelState>
    </div>
  );
}
