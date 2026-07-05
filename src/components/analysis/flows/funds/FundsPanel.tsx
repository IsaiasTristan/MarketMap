"use client";
/**
 * FUNDS — signal provenance (FUNDS Part 4b). The sub-tab root: who generates
 * signal (Originator Scoreboard), what they're doing right now with zero
 * followers yet (Fresh Calls), and a click-through Fund Page. Structure/density
 * mirrors C:\Users\isaia\Downloads\funds_tab_mockup.html. Replaces the retired
 * "First-Mover / Exits" sub-tab.
 */
import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import type { ScoreboardRow } from "@/server/services/institutional/institutional-follow.service";
import type { FreshCallRow, FreshCallsPayload } from "@/server/services/institutional/institutional-fresh-calls.service";
import { FUNDS_ATTRIBUTION_CONFIG } from "@/domain/calculations/funds-attribution-config";
import { useFlows } from "../useFlows";
import { PanelState, CapTag, quarterLabel } from "../flowsUi";
import { FundLink } from "./FundLink";
import { FundPage } from "./FundPage";

type ScoreboardPayload = { filingPeriod: string; cohortMedianRate: number | null; rows: ScoreboardRow[] };
type SortMode = "rate" | "fwd2q" | "exitLead" | "n";

const CFG = FUNDS_ATTRIBUTION_CONFIG;

export function FundsPanel({ period, onSelectTicker }: { period: string | null; onSelectTicker: (t: string) => void }) {
  const sb = useFlows<ScoreboardPayload>(["flows-funds-scoreboard", period], "/api/analysis/flows/funds-scoreboard");
  const fc = useFlows<FreshCallsPayload>(["flows-fresh-calls", period], "/api/analysis/flows/fresh-calls");
  const router = useRouter();
  const searchParams = useSearchParams();
  const openCik = searchParams.get("fund");
  const [sortMode, setSortMode] = useState<SortMode>("rate");

  const closeFundPage = () => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.delete("fund");
    router.replace(`/flows?${sp.toString()}`);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {openCik && <FundPage cik={openCik} onClose={closeFundPage} onSelectTicker={onSelectTicker} />}

      <div>
        <div style={{ fontSize: 12, color: "var(--text-secondary)" }}>
          Who generates signal — whose entries lead, and what are the best callers doing before anyone follows.
        </div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
          {sb.data ? `${quarterLabel(sb.data.filingPeriod)} · filing-date basis · ` : ""}signal tier only — funds with a qualified-initiation history
          {sb.data ? ` (${sb.data.rows.length} funds)` : ""}.
        </div>
      </div>

      <VerdictChips sb={sb.data} fc={fc.data} />

      <PanelState state={sb.state} error={sb.error}>
        {sb.data && <ScoreboardSection data={sb.data} sortMode={sortMode} setSortMode={setSortMode} onSelectTicker={onSelectTicker} />}
      </PanelState>

      <PanelState state={fc.state} error={fc.error}>
        {fc.data && <FreshCallsSection data={fc.data} onSelectTicker={onSelectTicker} />}
      </PanelState>

      <MethodFooter />
    </div>
  );
}

// ── verdict chips ────────────────────────────────────────────────────────────
function topDecileFundIds(rows: ScoreboardRow[]): Set<string> {
  const rated = rows.filter((r) => r.rateSufficient && r.followRate != null).slice().sort((a, b) => b.followRate! - a.followRate!);
  if (rated.length === 0) return new Set();
  const cut = Math.max(1, Math.ceil(rated.length * 0.1));
  return new Set(rated.slice(0, cut).map((r) => r.fundId));
}

function VerdictChips({ sb, fc }: { sb: ScoreboardPayload | null | undefined; fc: FreshCallsPayload | null | undefined }) {
  if (!sb) return null;
  const topIds = topDecileFundIds(sb.rows);
  const freshByTopDecile = topIds.size > 0 && fc ? fc.rows.filter((r) => topIds.has(r.fundId)).length : null;

  const sufficient = sb.rows.filter((r) => r.rateSufficient);
  const bestFwd = sufficient.filter((r) => r.fwd2q != null).sort((a, b) => b.fwd2q! - a.fwd2q!)[0] ?? null;

  const decays = sufficient
    .filter((r) => r.trendRecent != null && r.trendPrior != null)
    .map((r) => ({ r, drop: r.trendPrior! - r.trendRecent! }))
    .filter((x) => x.drop > 0)
    .sort((a, b) => b.drop - a.drop);
  const worstDecay = decays[0] ?? null;

  const chips: React.ReactNode[] = [];
  if (freshByTopDecile != null) {
    chips.push(
      <Chip key="fresh">
        <b>{freshByTopDecile} fresh call{freshByTopDecile === 1 ? "" : "s"}</b> by top-decile originators
      </Chip>,
    );
  }
  if (bestFwd) {
    chips.push(
      <Chip key="fwd">
        <b>{bestFwd.name}</b> best fwd return after entry <span style={{ color: "var(--color-positive)" }}>+{(bestFwd.fwd2q! * 100).toFixed(1)}%</span>
      </Chip>,
    );
  }
  if (worstDecay) {
    chips.push(
      <Chip key="decay">
        <b>{worstDecay.r.name}</b> follow rate fading <span style={{ color: "var(--color-negative)" }}>{Math.round(worstDecay.r.trendPrior! * 100)}% → {Math.round(worstDecay.r.trendRecent! * 100)}%</span>
      </Chip>,
    );
  }
  if (chips.length === 0) return null;
  return <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>{chips}</div>;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ border: "1px solid var(--bg-border)", background: "var(--bg-surface)", padding: "5px 10px", fontSize: 11, color: "var(--text-secondary)" }}>
      {children}
    </span>
  );
}

// ── originator scoreboard ────────────────────────────────────────────────────
function sortRows(rows: ScoreboardRow[], mode: SortMode): ScoreboardRow[] {
  const copy = rows.slice();
  if (mode === "fwd2q") {
    return copy.sort((a, b) => (a.rateSufficient !== b.rateSufficient ? (a.rateSufficient ? -1 : 1) : (b.fwd2q ?? -Infinity) - (a.fwd2q ?? -Infinity)));
  }
  if (mode === "exitLead") {
    return copy.sort((a, b) => (a.rateSufficient !== b.rateSufficient ? (a.rateSufficient ? -1 : 1) : (b.exitLeadRate ?? -Infinity) - (a.exitLeadRate ?? -Infinity)));
  }
  if (mode === "n") {
    return copy.sort((a, b) => b.n - a.n);
  }
  return copy.sort((a, b) => (a.rateSufficient !== b.rateSufficient ? (a.rateSufficient ? -1 : 1) : (b.followRate ?? -1) - (a.followRate ?? -1)));
}

function ScoreboardSection({
  data,
  sortMode,
  setSortMode,
  onSelectTicker,
}: {
  data: ScoreboardPayload;
  sortMode: SortMode;
  setSortMode: (m: SortMode) => void;
  onSelectTicker: (t: string) => void;
}) {
  const rows = useMemo(() => sortRows(data.rows, sortMode), [data.rows, sortMode]);
  return (
    <Section
      title="ORIGINATOR SCOREBOARD — QUALIFIED INITIATIONS, TRAILING 12 QTRS"
      note={
        <span>
          follow = ≥{CFG.follow_min_funds} funds within {CFG.follow_window}q · sort:{" "}
          {(["rate", "fwd2q", "exitLead", "n"] as SortMode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setSortMode(m)}
              style={{
                background: "transparent",
                border: "none",
                cursor: "pointer",
                color: sortMode === m ? "var(--color-accent)" : "var(--text-muted)",
                fontWeight: sortMode === m ? 700 : 400,
                fontSize: 10,
                padding: "0 3px",
                textDecoration: sortMode === m ? "underline" : "none",
              }}
            >
              {m === "rate" ? "follow rate" : m === "fwd2q" ? "fwd return" : m === "exitLead" ? "exit-lead" : "n"}
            </button>
          ))}
        </span>
      }
    >
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 900 }}>
          <ScoreHead />
          {rows.length === 0 ? (
            <div style={{ padding: 14, fontSize: 11, color: "var(--text-muted)" }}>No qualified originators this quarter.</div>
          ) : (
            rows.map((r, i) => <ScoreRow key={r.fundId} r={r} rank={i + 1} onSelectTicker={onSelectTicker} />)
          )}
        </div>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", padding: "8px 10px" }}>
        Funds with n &lt; {CFG.min_n_for_rate} qualified initiations render dimmed — insufficient history for a rate. TREND = trailing-4-qtr follow
        rate vs prior 4. EXIT-LEAD = % of the fund&apos;s qualified trims followed by an exit cluster within {CFG.follow_window}q.
      </div>
    </Section>
  );
}

const SCORE_COLS = "26px minmax(180px,1fr) 160px 70px 60px 60px 60px minmax(80px,1fr) 40px";

function ScoreHead() {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: SCORE_COLS,
        gap: 8,
        padding: "6px 10px",
        fontSize: 9,
        color: "var(--text-muted)",
        textTransform: "uppercase",
        letterSpacing: "0.06em",
        background: "var(--bg-surface)",
        borderBottom: "1px solid var(--bg-border)",
      }}
    >
      <span>#</span>
      <span>Fund</span>
      <span>Follow record</span>
      <span style={{ textAlign: "right" }}>Rate</span>
      <span style={{ textAlign: "right" }}>Med lead</span>
      <span style={{ textAlign: "right" }}>Fwd 2Q</span>
      <span style={{ textAlign: "right" }}>Exit-lead</span>
      <span>Fresh now</span>
      <span style={{ textAlign: "center" }}>Trend</span>
    </div>
  );
}

function ScoreRow({ r, rank, onSelectTicker }: { r: ScoreboardRow; rank: number; onSelectTicker: (t: string) => void }) {
  return (
    <div
      className="flows-row"
      style={{
        display: "grid",
        gridTemplateColumns: SCORE_COLS,
        gap: 8,
        alignItems: "center",
        padding: "7px 10px",
        borderBottom: "1px solid var(--bg-border)",
        fontSize: 11,
        opacity: r.rateSufficient ? 1 : 0.4,
      }}
    >
      <span style={{ color: "var(--text-muted)" }}>{r.rateSufficient ? rank : "·"}</span>
      <div style={{ minWidth: 0 }}>
        <FundLink cik={r.cik} name={r.name} isElite={r.isElite} style={{ fontWeight: 700, color: "var(--text-primary)" }} />
        <span style={{ color: "var(--text-muted)", fontSize: 10, marginLeft: 6 }}>{r.category}</span>
      </div>
      <Meter meter={r.meter} />
      <span style={{ textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>
        {r.rateSufficient && r.followRate != null ? `${Math.round(r.followRate * 100)}%` : "n/a"}
        <span style={{ color: "var(--text-muted)", fontWeight: 400, marginLeft: 4 }}>(n={r.n})</span>
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
        {r.medianLead != null ? `${r.medianLead.toFixed(1)}q` : "—"}
      </span>
      <span
        style={{
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          color: r.fwd2q == null ? "var(--text-muted)" : r.fwd2q >= 0 ? "var(--color-positive)" : "var(--color-negative)",
        }}
      >
        {r.fwd2q != null ? `${r.fwd2q >= 0 ? "+" : ""}${(r.fwd2q * 100).toFixed(1)}%` : "—"}
      </span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
        {r.exitLeadRate != null ? `${Math.round(r.exitLeadRate * 100)}%` : "—"}
      </span>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", overflow: "hidden" }}>
        {r.freshTickers.length === 0 ? (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        ) : (
          r.freshTickers.map((t) => (
            <span
              key={`${r.fundId}-${t}`}
              onClick={(e) => {
                e.stopPropagation();
                onSelectTicker(t);
              }}
              style={{ color: "var(--color-info)", fontWeight: 700, cursor: "pointer" }}
            >
              {t}
            </span>
          ))
        )}
      </div>
      <TrendArrow recent={r.trendRecent} prior={r.trendPrior} />
    </div>
  );
}

/** Receipt meter: one 4px block per resolved/pending initiation, filled = followed,
 *  a distinct dim style for pending. Caps at meter_max_blocks with a "+N" suffix. */
function Meter({ meter }: { meter: { n: number; f: number; pending: number } }) {
  const notFollowed = meter.n - meter.f;
  const total = meter.f + notFollowed + meter.pending;
  if (total === 0) return <span style={{ fontSize: 10, color: "var(--text-muted)" }}>—</span>;
  const cap = CFG.meter_max_blocks;
  const scale = total > cap ? cap / total : 1;
  const f = Math.round(meter.f * scale);
  const nf = Math.round(notFollowed * scale);
  const shown = Math.min(cap, total);
  const pd = Math.max(0, shown - f - nf);
  const extra = total - (f + nf + pd);
  return (
    <div
      title={`${meter.f} followed / ${meter.n} resolved · ${meter.pending} pending`}
      style={{ display: "flex", gap: 2, alignItems: "center" }}
    >
      {Array.from({ length: f }).map((_, i) => (
        <span key={`f${i}`} style={{ width: 4, height: 12, background: "var(--color-info)" }} />
      ))}
      {Array.from({ length: nf }).map((_, i) => (
        <span key={`u${i}`} style={{ width: 4, height: 12, background: "var(--bg-border)" }} />
      ))}
      {Array.from({ length: pd }).map((_, i) => (
        <span key={`p${i}`} style={{ width: 4, height: 12, background: "var(--text-muted)", opacity: 0.45 }} />
      ))}
      {extra > 0 && <span style={{ fontSize: 9, color: "var(--text-muted)", marginLeft: 2 }}>+{extra}</span>}
    </div>
  );
}

/** ▲ up / → flat / ▼ down — shape AND color both carry the direction. */
function TrendArrow({ recent, prior }: { recent: number | null; prior: number | null }) {
  if (recent == null || prior == null) return <span style={{ textAlign: "center", color: "var(--text-muted)" }}>—</span>;
  const delta = recent - prior;
  const EPS = 0.02; // within 2pp reads flat
  const dir = delta > EPS ? "up" : delta < -EPS ? "down" : "flat";
  const glyph = dir === "up" ? "▲" : dir === "down" ? "▼" : "→";
  const color = dir === "up" ? "var(--color-positive)" : dir === "down" ? "var(--color-negative)" : "var(--text-muted)";
  return (
    <span title={`${Math.round(prior * 100)}% → ${Math.round(recent * 100)}%`} style={{ textAlign: "center", color, fontWeight: 700 }}>
      {glyph}
    </span>
  );
}

// ── fresh calls ──────────────────────────────────────────────────────────────
function FreshCallsSection({ data, onSelectTicker }: { data: FreshCallsPayload; onSelectTicker: (t: string) => void }) {
  const br = data.baseRate;
  const baseRateLine = !br.sufficient
    ? `insufficient history (n=${br.n})`
    : `${br.excessReturn! >= 0 ? "+" : ""}${(br.excessReturn! * 100).toFixed(1)}% next 2Q · n=${br.n}${br.hitRate != null ? ` · ${Math.round(br.hitRate * 100)}% hit` : ""}`;

  return (
    <Section
      title="FRESH CALLS — QUALIFIED ENTRIES, ZERO FOLLOWERS YET"
      note={<span>base rate (top-decile originator): <b style={{ color: "var(--text-primary)" }}>{baseRateLine}</b></span>}
    >
      <div style={{ overflowX: "auto" }}>
        <div style={{ minWidth: 900 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "160px 200px minmax(220px,1fr) 70px 90px 70px 60px",
              gap: 8,
              padding: "6px 10px",
              fontSize: 9,
              color: "var(--text-muted)",
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              background: "var(--bg-surface)",
              borderBottom: "1px solid var(--bg-border)",
            }}
          >
            <span>Ticker</span>
            <span>Originator</span>
            <span>Why it qualifies</span>
            <span>Entered</span>
            <span style={{ textAlign: "right" }}>Size</span>
            <span style={{ textAlign: "right" }}>Px since</span>
            <span />
          </div>
          {data.rows.length === 0 ? (
            <div style={{ padding: 14, fontSize: 11, color: "var(--text-muted)" }}>No fresh calls this quarter.</div>
          ) : (
            data.rows.map((r) => <FreshRow key={`${r.fundId}|${r.ticker}|${r.enteredPeriod}`} r={r} onSelectTicker={onSelectTicker} />)
          )}
        </div>
      </div>
    </Section>
  );
}

function FreshRow({ r, onSelectTicker }: { r: FreshCallRow; onSelectTicker: (t: string) => void }) {
  const pxColor = r.priceSinceFiling == null ? "var(--text-muted)" : r.priceSinceFiling >= 0 ? "var(--color-positive)" : "var(--color-negative)";
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "160px 200px minmax(220px,1fr) 70px 90px 70px 60px",
        gap: 8,
        alignItems: "center",
        padding: "8px 10px",
        borderBottom: "1px solid var(--bg-border)",
        fontSize: 11,
      }}
    >
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span onClick={() => onSelectTicker(r.ticker)} style={{ color: "var(--color-info)", fontWeight: 700, cursor: "pointer" }}>
            {r.ticker}
          </span>
          <CapTag tier={r.marketCapTier} />
        </div>
        <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
          {r.companyName ?? "—"} {r.sector ? `· ${r.sector}` : ""}
        </div>
      </div>
      <div>
        <span style={{ border: "1px solid var(--color-info)", background: "rgba(0,191,255,0.08)", padding: "2px 8px", display: "inline-block", fontSize: 11 }}>
          <FundLink cik={r.cik} name={r.fundName} style={{ color: "var(--color-info)" }} /> · {r.sizingMult.toFixed(1)}×
        </span>
      </div>
      <div style={{ color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis" }}>{r.qualifiers.join(" · ") || "—"}</div>
      <span style={{ color: "var(--text-secondary)" }}>{quarterLabel(r.enteredPeriod)}</span>
      <span style={{ textAlign: "right", color: "var(--text-secondary)", fontVariantNumeric: "tabular-nums" }}>
        {r.pctOfBook != null ? `${r.pctOfBook.toFixed(1)}%` : "—"}
      </span>
      <span style={{ textAlign: "right", color: pxColor, fontVariantNumeric: "tabular-nums" }}>
        {r.priceSinceFiling != null ? `${r.priceSinceFiling >= 0 ? "+" : ""}${(r.priceSinceFiling * 100).toFixed(0)}%` : "—"}
      </span>
      <span
        onClick={() => onSelectTicker(r.ticker)}
        title="No per-user ticker watchlist yet — opens the fund ledger for this name"
        style={{ color: "var(--color-info)", cursor: "pointer", textAlign: "right" }}
      >
        watch
      </span>
    </div>
  );
}

// ── shared section shell ─────────────────────────────────────────────────────
function Section({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ border: "1px solid var(--bg-border)", background: "var(--bg-surface)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 6,
          padding: "8px 10px",
          borderBottom: "1px solid var(--bg-border)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>{title}</span>
        {note && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{note}</span>}
      </div>
      {children}
    </div>
  );
}

function MethodFooter() {
  return (
    <div style={{ fontSize: 10, color: "var(--text-muted)", lineHeight: 1.6, padding: "2px 2px" }}>
      Qualified initiation (originator) = entry ≥25bps of book AND ≥0.5× the fund&apos;s typical position size. A follow = ANY signal-tier fund
      opening a NEW position ≥25bps within {CFG.follow_window} quarters — the materiality bar, not the full initiation bar. This is a deliberate
      asymmetry: the strict caller/originator bar (size + sizing multiple) vs. a looser materiality bar for followers, so a late fund confirming a
      call with even a modest starter position still counts as following. Follow = ≥{CFG.follow_min_funds} such funds. All rates computed from
      filing dates (no lookahead). Historical pattern statistics, not recommendations.
    </div>
  );
}
