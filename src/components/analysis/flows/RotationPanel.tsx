"use client";
/**
 * 5.4 Rotation flow — price-adjusted, equal-weighted active rotation.
 *
 * Display contract (all three levels):
 *   - Bar length = shrunk net-diffusion; bar COLOR = sign of diffusion only.
 *   - Primary label = "+64% of 14" (shrunk diffusion %, participating funds).
 *   - Secondary chip = net $ moved, colored by ITS OWN sign (text +/−).
 *   - Divergence marker ⇄ when sign(diffusion) ≠ sign(net $) and both clear the
 *     noise floors (|diffusion| ≥ 10%, |$| ≥ $100M).
 *   - Ghost tick = last quarter's diffusion (acceleration read); right-aligned
 *     percentile = how unusual this quarter's move is vs its trailing 12q.
 *   - Sector/subsector rows expand on click into the top-5 accumulated + top-5
 *     distributed names within them (each opens the fund ledger); stock rows
 *     open the ledger directly. The decision path is rotation → names.
 *
 * Diffusion = share of tracked funds that deliberately TRADED into the bucket
 * minus those that traded out (price drift removed, equal-weighted, 1 vote/fund).
 */
import { useMemo, useState } from "react";
import type { RotationGroupBy, RotationPayload, RotationSizeFilter } from "@/server/services/institutional/institutional-query.service";
import { Segmented, type SegmentedOption } from "@/components/analysis/factors/shared/Segmented";
import { useFlows } from "./useFlows";
import { PanelState, fmtBps, fmtFlowDollars } from "./flowsUi";

const GROUP_OPTIONS: SegmentedOption<RotationGroupBy>[] = [
  { value: "sector", label: "SECTOR" },
  { value: "subsector", label: "SUBSECTOR" },
  { value: "stock", label: "STOCK" },
];
const SIZE_OPTIONS: SegmentedOption<RotationSizeFilter>[] = [
  { value: "all", label: "ALL CAPS" },
  { value: "ex-mega", label: "EX-MEGA" },
  { value: "mega-only", label: "MEGA ONLY" },
];

const SUBTITLE =
  "bar = share of funds deliberately trading in minus out (drift-adjusted, equal-weighted, 1 vote/fund); chip = net $ moved; ⏐ = last quarter; ⇄ = breadth and dollars disagree. Click a sector to see its names.";
const LEGACY_CAPTION =
  "Earliest quarter — price-adjusted rotation needs a prior quarter, so this shows raw fund add/trim counts (funds adding minus trimming).";

const DIVERGE_DIFF_PCT = 10;
const DIVERGE_DOLLARS = 100_000_000;
const POS = "var(--color-positive)";
const NEG = "var(--color-negative)";

type Group = RotationPayload["groups"][number];

const sign = (n: number) => (n > 0 ? 1 : n < 0 ? -1 : 0);
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const diffOf = (g: Group): number => g.shrunkDiffusionPct ?? g.netDiffusionPct ?? 0;
function ordinal(n: number): string {
  const v = n % 100;
  return `${n}${["th", "st", "nd", "rd"][(v - 20) % 10] ?? ["th", "st", "nd", "rd"][v] ?? "th"}`;
}
function isDivergent(g: Group): boolean {
  const d = diffOf(g);
  const dollar = g.dollarNetFlow ?? 0;
  return sign(d) !== 0 && sign(dollar) !== 0 && sign(d) !== sign(dollar) && Math.abs(d) >= DIVERGE_DIFF_PCT && Math.abs(dollar) >= DIVERGE_DOLLARS;
}

/** One diverging bar row: label · bar (center-zero, ghost tick) · primary % ·
 *  net-$ chip · ⇄ · percentile. Clickable (expand sector / open ledger). */
function RotationRow({
  g,
  scale,
  labelW,
  active,
  onClick,
  expanded,
}: {
  g: Group;
  scale: number;
  labelW: number;
  active: boolean;
  onClick?: () => void;
  expanded?: boolean;
}) {
  const d = diffOf(g);
  const dollar = g.dollarNetFlow ?? 0;
  const barPct = active ? Math.min(50, (Math.abs(d) / scale) * 50) : Math.min(50, (Math.abs(g.netFundsAdding) / scale) * 50);
  const barSign = active ? sign(d) : sign(g.netFundsAdding);
  const color = barSign >= 0 ? POS : NEG;
  const n = g.fundsParticipating ?? 0;
  const primary = active ? `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(0)}% of ${n}` : `${g.netFundsAdding >= 0 ? "+" : "−"}${Math.abs(g.netFundsAdding)} funds`;
  const diverge = active && isDivergent(g);
  const ghostLeft = active && g.priorDiffusionPct != null ? clamp(50 + (g.priorDiffusionPct / scale) * 50, 0, 100) : null;
  const hist = g.diffusionHistory && g.diffusionHistory.length > 1 ? `\n4q: ${g.diffusionHistory.map((v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(0)}%`).join(" → ")}` : "";
  const rowTitle = active
    ? `${g.groupKey}${g.companyName ? ` · ${g.companyName}` : ""}\n${g.fundsIn ?? 0} of ${n} rotated in · ${g.fundsOut ?? 0} out\navg move ${fmtBps(g.activeBpsAvg)} · net flow ${fmtFlowDollars(dollar)}${hist}`
    : `${g.groupKey}: net ${g.netFundsAdding} funds`;

  return (
    <div
      title={rowTitle}
      onClick={onClick}
      style={{ display: "flex", alignItems: "center", gap: 8, height: 26, cursor: onClick ? "pointer" : "default", background: expanded ? "var(--bg-elevated)" : undefined }}
    >
      <div style={{ width: labelW, textAlign: "right", fontSize: 11, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flexShrink: 0 }}>
        {onClick && !g.companyName ? (expanded ? "▾ " : "▸ ") : ""}{g.groupKey}
      </div>
      <div style={{ position: "relative", flex: 1, height: 16, background: "var(--bg-base)", minWidth: 80 }}>
        <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--text-muted)" }} />
        <div style={{ position: "absolute", top: 2, bottom: 2, left: barSign >= 0 ? "50%" : undefined, right: barSign >= 0 ? undefined : "50%", width: `${barPct}%`, background: color, opacity: 0.85 }} />
        {ghostLeft != null && (
          <div title="last quarter's diffusion" style={{ position: "absolute", left: `${ghostLeft}%`, top: -1, bottom: -1, width: 2, background: "var(--text-secondary)", opacity: 0.75 }} />
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, width: 168, flexShrink: 0, fontSize: 10 }}>
        <span style={{ color: "var(--text-primary)", width: 74, textAlign: "right" }}>{primary}</span>
        {active && (
          <span style={{ color: dollar >= 0 ? POS : NEG, border: `1px solid ${dollar >= 0 ? POS : NEG}`, borderRadius: 0, padding: "0 3px", fontWeight: 700, whiteSpace: "nowrap" }}>
            {fmtFlowDollars(dollar)}
          </span>
        )}
        {diverge && (
          <span title={`breadth and dollars disagree: ${g.fundsIn ?? 0} funds rotated in vs net ${fmtFlowDollars(dollar)} (dollar-weighted — a few large trades dominate)`} style={{ color: "var(--color-accent)", fontWeight: 700, cursor: "help" }}>
            ⇄
          </span>
        )}
      </div>
      <div style={{ width: 56, textAlign: "right", fontSize: 9, color: "var(--text-muted)", flexShrink: 0 }}>
        {active && g.percentile != null ? `${ordinal(g.percentile)} %ile` : ""}
      </div>
    </div>
  );
}

/** Inline drill-down: top-5 accumulated + top-5 distributed names in a bucket. */
function Drilldown({ period, level, groupKey, onSelectTicker }: { period: string | null; level: RotationGroupBy; groupKey: string; onSelectTicker?: (t: string) => void }) {
  const qs = new URLSearchParams();
  if (period) qs.set("period", period);
  qs.set("groupBy", level);
  qs.set("within", groupKey);
  const { data, state } = useFlows<RotationPayload>(["flows-rotation-drill", period, level, groupKey], `/api/analysis/flows/rotation?${qs}`);
  const rows = data?.groups ?? [];
  return (
    <div style={{ padding: "4px 10px 8px 24px", background: "var(--bg-elevated)", borderLeft: "2px solid var(--bg-border)" }}>
      {state === "loading" && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>Loading names…</div>}
      {state === "ready" && rows.length === 0 && <div style={{ fontSize: 10, color: "var(--text-muted)" }}>No qualifying names.</div>}
      {rows.map((g) => {
        const d = diffOf(g);
        const dollar = g.dollarNetFlow ?? 0;
        return (
          <div key={g.groupKey} onClick={() => onSelectTicker?.(g.groupKey)} title="open fund ledger" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, padding: "1px 0", cursor: onSelectTicker ? "pointer" : "default" }}>
            <span style={{ fontWeight: 700, width: 64, color: "var(--text-primary)" }}>{g.groupKey}</span>
            <span style={{ color: d >= 0 ? POS : NEG, width: 84 }}>{d >= 0 ? "+" : "−"}{Math.abs(d).toFixed(0)}% of {g.fundsParticipating ?? 0}</span>
            <span style={{ color: dollar >= 0 ? POS : NEG, width: 76 }}>{fmtFlowDollars(dollar)}</span>
            <span style={{ color: "var(--text-muted)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{g.companyName}</span>
          </div>
        );
      })}
    </div>
  );
}

function RotationBars({ groups, active, groupBy, period, onSelectTicker }: { groups: Group[]; active: boolean; groupBy: RotationGroupBy; period: string | null; onSelectTicker?: (t: string) => void }) {
  const isStock = groupBy === "stock";
  const [expanded, setExpanded] = useState<string | null>(null);
  const scale = useMemo(() => Math.max(1, ...groups.map((g) => (active ? Math.abs(diffOf(g)) : Math.abs(g.netFundsAdding)))), [groups, active]);
  const labelW = isStock ? 64 : 132;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "8px 10px", background: "var(--bg-surface)", border: "1px solid var(--bg-border)" }}>
      {groups.map((g) => {
        const onClick = isStock ? () => onSelectTicker?.(g.groupKey) : () => setExpanded((k) => (k === g.groupKey ? null : g.groupKey));
        const isExpanded = !isStock && expanded === g.groupKey;
        return (
          <div key={g.groupKey}>
            <RotationRow g={g} scale={scale} labelW={labelW} active={active} onClick={active ? onClick : undefined} expanded={isExpanded} />
            {isExpanded && <Drilldown period={period} level={groupBy} groupKey={g.groupKey} onSelectTicker={onSelectTicker} />}
          </div>
        );
      })}
    </div>
  );
}

/** Search results for stock names outside the top/bottom boards. */
function StockSearch({ searchable, onSelectTicker }: { searchable: Group[]; onSelectTicker?: (t: string) => void }) {
  const [q, setQ] = useState("");
  const matches = useMemo(() => {
    const t = q.trim().toUpperCase();
    if (t.length < 1) return [];
    return searchable.filter((g) => g.groupKey.toUpperCase().includes(t) || (g.companyName ?? "").toUpperCase().includes(t)).slice(0, 12);
  }, [q, searchable]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search any name (ticker or company)…"
        style={{ background: "var(--bg-base)", border: "1px solid var(--bg-border)", color: "var(--text-primary)", padding: "4px 8px", fontSize: 12, borderRadius: 0, outline: "none", maxWidth: 360 }}
      />
      {matches.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", border: "1px solid var(--bg-border)", maxWidth: 520 }}>
          {matches.map((g) => {
            const d = diffOf(g);
            const dollar = g.dollarNetFlow ?? 0;
            return (
              <div key={g.groupKey} onClick={() => onSelectTicker?.(g.groupKey)} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 8px", fontSize: 11, borderTop: "1px solid var(--bg-border)", cursor: onSelectTicker ? "pointer" : "default" }}>
                <span style={{ fontWeight: 700, width: 60 }}>{g.groupKey}</span>
                <span style={{ color: d >= 0 ? POS : NEG, width: 84 }}>{d >= 0 ? "+" : "−"}{Math.abs(d).toFixed(0)}% of {g.fundsParticipating ?? 0}</span>
                <span style={{ color: dollar >= 0 ? POS : NEG, width: 76 }}>{fmtFlowDollars(dollar)}</span>
                {g.belowThreshold ? <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>below threshold</span> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function RotationPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker?: (t: string) => void }) {
  const [groupBy, setGroupBy] = useState<RotationGroupBy>("sector");
  const [size, setSize] = useState<RotationSizeFilter>("all");

  const qs = new URLSearchParams();
  if (period) qs.set("period", period);
  if (groupBy !== "sector") qs.set("groupBy", groupBy);
  if (groupBy === "stock" && size !== "all") qs.set("size", size);
  const { data, state, error } = useFlows<RotationPayload>(
    ["flows-rotation", period, groupBy, groupBy === "stock" ? size : "all"],
    `/api/analysis/flows/rotation${qs.size ? `?${qs}` : ""}`,
  );

  const active = data?.hasActiveFlow ?? false;
  const groups = data?.groups ?? [];
  const isStock = groupBy === "stock";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <Segmented value={groupBy} onChange={setGroupBy} options={GROUP_OPTIONS} />
        {isStock && <Segmented value={size} onChange={setSize} options={SIZE_OPTIONS} />}
      </div>
      <PanelState state={state} error={error}>
        {data && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{active ? SUBTITLE : LEGACY_CAPTION}</div>
            {groups.length > 0 ? (
              <RotationBars groups={groups} active={active} groupBy={groupBy} period={period} onSelectTicker={onSelectTicker} />
            ) : (
              <div style={{ fontSize: 12, color: "var(--text-muted)", padding: 12 }}>No rotation for this period.</div>
            )}
            {isStock && data.searchable && data.searchable.length > 0 && <StockSearch searchable={data.searchable} onSelectTicker={onSelectTicker} />}
            {isStock && data.qualifyingCount !== undefined && (
              <div style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {data.qualifyingCount} names meet the ≥5-fund floor · showing top 15 accumulation &amp; bottom 15 distribution
              </div>
            )}
          </div>
        )}
      </PanelState>
    </div>
  );
}
