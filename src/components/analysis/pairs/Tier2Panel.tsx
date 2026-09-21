"use client";
/**
 * Tier 2 panel (brief §8.6) — the single-stock top-k/bottom-k spread within one
 * subsector, per ranking engine. Killed names are struck through with their
 * reason (§6.4). When the selected week predates the Engine-2 quality-flag
 * cutoff the panel says the spread is UNSCREENED rather than showing an empty
 * kill column. The short side is basket-scoped (single-name short gates are
 * unavailable per the Phase-0 probe), stated in the subtitle.
 */
import type { PairTier2Payload, PairTier2Row } from "@/server/services/pairs/pairs-read.service";
import { Sparkline, signColor } from "@/components/analysis/research/primitives";
import { PairMetricTip } from "./PairMetricTip";
import type { PairMetricId } from "@/lib/pairs/metric-registry";

function pct(v: number | null, dp = 1): string {
  return v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(dp)}%`;
}
function num(v: number | null, dp = 1): string {
  return v === null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

function Metric({ id, label, value, tone }: { id: PairMetricId; label: string; value: string; tone?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4, whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 8.5, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
        <PairMetricTip id={id}>{label}</PairMetricTip>
      </span>
      <span className="bb-num" style={{ fontSize: 11, fontWeight: 700, color: tone ?? "var(--text-primary)" }}>{value}</span>
    </span>
  );
}

function Leg({ title, members, color }: { title: string; members: string[]; color: string }) {
  return (
    <div style={{ flex: 1, minWidth: 150 }}>
      <div style={{ fontSize: 8.5, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 2 }}>
        {title} ({members.length})
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
        {members.length === 0 ? (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>—</span>
        ) : (
          members.map((t) => (
            <span key={t} style={{ fontSize: 9.5, fontWeight: 700, color, border: `1px solid ${color}`, padding: "0 4px" }}>
              {t}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function EngineCard({ row, killCutoff }: { row: PairTier2Row; killCutoff: string | null }) {
  const longKilled = row.killedNames.filter((k) => k.side === "LONG");
  const shortKilled = row.killedNames.filter((k) => k.side === "SHORT");
  return (
    <div style={{ border: "1px solid var(--chrome-border)", background: "var(--bg-surface)", padding: 8 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, color: "#000", background: "var(--color-accent)", padding: "1px 6px" }}>
          {row.tier2Engine === "E1" ? "ENGINE 1 · REVISIONS" : "ENGINE 2 · INFLECTION"}
        </span>
        {row.killScreensApplied ? (
          <span style={{ fontSize: 8.5, color: "var(--color-positive)", letterSpacing: 0.3 }}>quality-screened</span>
        ) : (
          <span style={{ fontSize: 8.5, color: "var(--color-accent)", letterSpacing: 0.3 }}>UNSCREENED</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <Leg title="Long (top-k)" members={row.longMembers} color="var(--color-positive)" />
        <Leg title="Short (bottom-k)" members={row.shortMembers} color="var(--color-negative)" />
      </div>

      {row.killScreensApplied ? (
        (longKilled.length > 0 || shortKilled.length > 0) ? (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 8.5, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 2 }}>
              Killed ({row.killedNames.length})
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {row.killedNames.map((k) => (
                <span key={`${k.ticker}-${k.side}`} style={{ fontSize: 9, color: "var(--text-muted)", border: "1px dashed var(--chrome-border)", padding: "0 4px" }}>
                  <span style={{ textDecoration: "line-through" }}>{k.ticker}</span>{" "}
                  <span style={{ color: k.side === "LONG" ? "var(--color-negative)" : "var(--color-positive)" }}>{k.side}</span>
                  <span style={{ marginLeft: 3 }}>{k.reason}</span>
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ marginTop: 6, fontSize: 8.5, color: "var(--text-muted)" }}>No names killed this week.</div>
        )
      ) : (
        <div style={{ marginTop: 6, fontSize: 9, color: "var(--color-accent)", lineHeight: 1.4 }}>
          Quality flags unavailable before {killCutoff ?? "the fundamental job start"}; this spread is unscreened.
        </div>
      )}

      {/* Surviving-spread summary strip */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8, paddingTop: 6, borderTop: "1px solid var(--chrome-border)", alignItems: "center" }}>
        <Metric id="hedgeEff" label="hedge-eff" value={num(row.hedgeEff, 2)} tone={row.hedgeEff !== null && row.hedgeEff >= 0.3 ? "var(--color-positive)" : "var(--text-primary)"} />
        <Metric id="residualShare" label="residual" value={row.residualSharePct === null ? "—" : `${row.residualSharePct.toFixed(0)}%`} />
        <Metric id="relReturn1m" label="rel 1m" value={pct(row.relReturn1m)} tone={signColor(row.relReturn1m)} />
        <Metric
          id="unpricedGap"
          label="unpriced gap"
          value={row.unpricedGap === null ? "—" : `${row.unpricedGap.toFixed(2)}${row.unpricedGapCalibrated ? "" : "*"}`}
          tone={signColor(row.unpricedGap)}
        />
        <span style={{ marginLeft: "auto" }}>
          <Sparkline values={row.priceRatioSeries} w={90} h={18} />
        </span>
      </div>
      {!row.unpricedGapCalibrated ? (
        <div style={{ fontSize: 8, color: "var(--text-muted)", marginTop: 2 }}>* uncalibrated — under 52 weeks of the pair&apos;s own history.</div>
      ) : null}
    </div>
  );
}

export function Tier2Panel({ subsector, data, state }: { subsector: string | null; data: PairTier2Payload | null; state: string }) {
  if (!subsector) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12 }}>
        Select a subsector on the dispersion map to see its top-k long vs bottom-k short spread.
      </div>
    );
  }
  if (state === "loading") {
    return <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12 }}>Loading…</div>;
  }
  if (!data || data.rows.length === 0) {
    return (
      <div style={{ fontSize: 11, color: "var(--text-muted)", padding: 12, lineHeight: 1.5 }}>
        No Tier 2 pair for {subsector} this week — the subsector needs ≥ 12 names and dispersion in the top half of its own history to form a top-5/bottom-5 spread.
      </div>
    );
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))", gap: 6 }}>
      {data.rows.map((row) => (
        <EngineCard key={row.tier2Engine} row={row} killCutoff={data.killCutoff} />
      ))}
    </div>
  );
}
