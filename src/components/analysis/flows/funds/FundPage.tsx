"use client";
/**
 * FUNDS — single-fund signal-provenance page (FUNDS Part 4b). Reached by
 * clicking any fund name anywhere in the tool (FundLink) or via the deep-link
 * `/flows?tab=funds&fund=<cik>`. Mirrors the mockup's `.fp` section.
 */
import type { FundPagePayload, FundInitiationOutcome, FundReturnsBlock, FundVsPeersBlock } from "@/server/services/institutional/institutional-fund-page.service";
import { useFlows } from "../useFlows";
import { PanelState, fmtUsdCompact, quarterLabel } from "../flowsUi";
import { MetricTooltip } from "../MetricTooltip";
import { FundLink } from "./FundLink";

function turnoverPct(t: number | null): number | null {
  if (t == null) return null;
  return t <= 1 ? t * 100 : t;
}

export function FundPage({ cik, onClose, onSelectTicker }: { cik: string; onClose: () => void; onSelectTicker: (t: string) => void }) {
  const { data, state, error } = useFlows<FundPagePayload>(["flows-fund-page", cik], `/api/analysis/flows/fund-page/${encodeURIComponent(cik)}`);

  return (
    <div style={{ border: "1px solid var(--color-accent)", background: "var(--bg-base)", marginBottom: 4 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          padding: "8px 10px",
          borderBottom: "1px solid var(--bg-border)",
          background: "var(--bg-surface)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          Fund page — reached by clicking any fund name anywhere in the tool
        </span>
        <button type="button" onClick={onClose} style={{ background: "transparent", border: "1px solid var(--bg-border)", color: "var(--text-secondary)", fontSize: 11, padding: "1px 8px", cursor: "pointer" }}>
          ✕ close
        </button>
      </div>
      <div style={{ padding: 10 }}>
        <PanelState state={state} error={error}>
          {data && <FundPageBody data={data} onSelectTicker={onSelectTicker} />}
        </PanelState>
      </div>
    </div>
  );
}

function FundPageBody({ data, onSelectTicker }: { data: FundPagePayload; onSelectTicker: (t: string) => void }) {
  const filingTell =
    data.filingDayTell != null
      ? `filed ${quarterLabel(data.filingPeriod)} on day ${data.filingDayTell} of 45${data.filingDayTell >= 35 ? " — late filer, treat entries as deliberate" : ""}`
      : `${quarterLabel(data.filingPeriod)} · filing date unknown`;
  const turnover = turnoverPct(data.stats.turnover);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
        <div>
          <span style={{ fontSize: 15, fontWeight: 700, color: "var(--text-primary)" }}>{data.name}</span>
          {data.isElite && <span title="most-respected subset" style={{ color: "var(--color-accent)", marginLeft: 6, fontSize: 12 }}>★ elite</span>}
          <span style={{ color: "var(--text-muted)", fontSize: 11, marginLeft: 6 }}>
            · {data.category} · CIK {data.cik}
          </span>
        </div>
        <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{filingTell}</span>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        <StatChip label="13F AUM" value={data.stats.aum13fUsd != null ? fmtUsdCompact(data.stats.aum13fUsd) : "—"} />
        <StatChip label="positions" value={data.stats.positions != null ? String(data.stats.positions) : "—"} />
        <StatChip
          label="median tenure"
          value={data.stats.medianTenure != null ? `${data.stats.medianTenureCensored ? "≥" : ""}${data.stats.medianTenure.toFixed(1)}q` : "—"}
        />
        <StatChip label="turnover" metricId="turnover" value={turnover != null ? `${turnover.toFixed(0)}%/q` : "—"} />
        <StatChip label="top-10 = " metricId="concentration" value={data.stats.top10ConcentrationPct != null ? `${data.stats.top10ConcentrationPct.toFixed(0)}% of book` : "—"} />
        <StatChip label="eff. positions" metricId="effPositions" value={data.stats.effPositions != null ? data.stats.effPositions.toFixed(1) : "—"} />
        <StatChip
          label="clone alpha"
          metricId="cloneAlpha"
          value={
            data.stats.cloneAlpha != null
              ? `${data.stats.cloneAlpha >= 0 ? "+" : ""}${(data.stats.cloneAlpha * 100).toFixed(1)}%/yr`
              : "insufficient history"
          }
          highlight
        />
      </div>

      {data.returns && <ReturnsStrip r={data.returns} onSelectTicker={onSelectTicker} />}

      <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", gap: 0, border: "1px solid var(--bg-border)" }}>
        <div style={{ padding: 10 }}>
          <ColLabel>Qualified initiations — last 6, with outcomes</ColLabel>
          {data.recentInitiations.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No qualified initiations in the stat window.</div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
              <tbody>
                {data.recentInitiations.map((o) => (
                  <InitiationRow key={`${o.ticker}|${o.period}`} o={o} onSelectTicker={onSelectTicker} />
                ))}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding: 10, borderLeft: "1px solid var(--bg-border)" }}>
          <ColLabel>Signal profile</ColLabel>
          <ProfileLine>
            follow rate <b>{data.signalProfile.rateSufficient && data.signalProfile.followRate != null ? `${Math.round(data.signalProfile.followRate * 100)}%` : "n/a"}</b>{" "}
            (n={data.signalProfile.followN}) · median lead <b>{data.signalProfile.medianLead != null ? `${data.signalProfile.medianLead.toFixed(1)}q` : "—"}</b>
          </ProfileLine>
          <ProfileLine>
            fwd 2Q after entries{" "}
            <b style={{ color: data.signalProfile.fwd2q == null ? undefined : data.signalProfile.fwd2q >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>
              {data.signalProfile.fwd2q != null ? `${data.signalProfile.fwd2q >= 0 ? "+" : ""}${(data.signalProfile.fwd2q * 100).toFixed(1)}%` : "—"}
            </b>{" "}
            · hit <b>{data.signalProfile.hitRate2q != null ? `${Math.round(data.signalProfile.hitRate2q * 100)}%` : "—"}</b>
          </ProfileLine>
          <ProfileLine>
            exit-leads confirmed <b>{data.signalProfile.exitLeadRate != null ? `${Math.round(data.signalProfile.exitLeadRate * 100)}%` : "n/a"}</b>{" "}
            (n={data.signalProfile.exitLeadN})
          </ProfileLine>
          <ProfileLine>
            best sector <b>{data.signalProfile.bestSector ?? "—"}</b>
            {data.signalProfile.bestSectorRate != null ? ` — ${Math.round(data.signalProfile.bestSectorRate * 100)}% follow` : ""}
          </ProfileLine>

          <div style={{ marginTop: 12 }}>
            <ColLabel>Led exits — trims that preceded clusters</ColLabel>
            {data.ledExits.length === 0 ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>No led exits recorded.</div>
            ) : (
              data.ledExits.map((e, i) => (
                <ProfileLine key={i}>
                  <span
                    onClick={() => onSelectTicker(e.ticker)}
                    style={{ color: "var(--color-info)", fontWeight: 700, cursor: "pointer" }}
                  >
                    {e.ticker}
                  </span>{" "}
                  trim {quarterLabel(e.quarter)} → cluster {quarterLabel(e.clusterQuarter)} <span style={{ color: "var(--color-positive)" }}>✓</span>
                  {e.isStasisBreak && (
                    <span style={{ marginLeft: 6, border: "1px solid var(--color-accent)", color: "var(--color-accent)", fontSize: 9, padding: "0 4px" }}>
                      stasis break
                    </span>
                  )}
                </ProfileLine>
              ))
            )}
          </div>
        </div>
      </div>

      {data.vsPeers && <VsPeers v={data.vsPeers} />}

      <div style={{ borderTop: "1px solid var(--bg-border)", paddingTop: 8, fontSize: 10, color: "var(--text-muted)" }}>
        current fresh calls: <b style={{ color: "var(--text-primary)" }}>{data.reverseIndex.freshCalls}</b> · led exits:{" "}
        <b style={{ color: "var(--text-primary)" }}>{data.reverseIndex.ledExits}</b> · qualified initiations:{" "}
        <b style={{ color: "var(--text-primary)" }}>{data.reverseIndex.qualifiedInitiations}</b>
      </div>
    </div>
  );
}

function outcomeText(o: FundInitiationOutcome): { text: string; color: string } {
  if (o.status === "pending" && o.followerFunds === 0) return { text: "fresh — 0 followers", color: "var(--color-accent)" };
  if (o.status === "pending") return { text: `pending — ${o.followerFunds} follower${o.followerFunds === 1 ? "" : "s"} so far`, color: "var(--text-secondary)" };
  if (o.status === "followed") return { text: `followed by ${o.followerFunds} in ${o.lead != null ? `${o.lead}q` : "?q"}`, color: "var(--color-positive)" };
  if (o.status === "not_followed") return { text: "not followed", color: "var(--text-muted)" };
  return { text: o.status, color: "var(--text-muted)" };
}

function InitiationRow({ o, onSelectTicker }: { o: FundInitiationOutcome; onSelectTicker: (t: string) => void }) {
  const outcome = outcomeText(o);
  return (
    <tr style={{ borderBottom: "1px solid var(--bg-border)" }}>
      <td style={{ padding: "4px 4px", cursor: "pointer", color: "var(--color-info)", fontWeight: 700 }} onClick={() => onSelectTicker(o.ticker)}>
        {o.ticker}
      </td>
      <td style={{ padding: "4px 4px", color: "var(--text-muted)", textAlign: "right" }}>{quarterLabel(o.period)}</td>
      <td style={{ padding: "4px 4px", color: "var(--text-secondary)", textAlign: "right" }}>{o.sizingMult.toFixed(1)}×</td>
      <td style={{ padding: "4px 8px", color: outcome.color }}>{outcome.text}</td>
      <td style={{ padding: "4px 4px", textAlign: "right", color: o.fwd2q == null ? "var(--text-muted)" : o.fwd2q >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>
        {o.fwd2q != null ? `${o.fwd2q >= 0 ? "+" : ""}${(o.fwd2q * 100).toFixed(0)}%` : "—"}
      </td>
    </tr>
  );
}

function StatChip({
  label,
  value,
  highlight,
  metricId,
}: {
  label: string;
  value: string;
  highlight?: boolean;
  metricId?: import("@/lib/institutional/metric-registry").MetricId;
}) {
  return (
    <span
      style={{
        border: `1px solid ${highlight ? "var(--color-info)" : "var(--bg-border)"}`,
        padding: "3px 9px",
        fontSize: 11,
        color: highlight ? "var(--color-info)" : "var(--text-muted)",
      }}
    >
      {metricId ? <MetricTooltip id={metricId}>{label}</MetricTooltip> : label}{" "}
      <b style={{ color: highlight ? "var(--color-info)" : "var(--text-primary)" }}>{value}</b>
    </span>
  );
}

// ── RETURNS strip (Fund Overview Part 1) ─────────────────────────────────────
function ReturnsStrip({ r, onSelectTicker }: { r: FundReturnsBlock; onSelectTicker: (t: string) => void }) {
  const pts = (n: number) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(1)}`;
  return (
    <div style={{ border: "1px solid var(--bg-border)" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          flexWrap: "wrap",
          gap: 6,
          padding: "8px 10px",
          borderBottom: "1px solid var(--bg-border)",
          background: "var(--bg-surface)",
        }}
      >
        <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
          <MetricTooltip id="estLongBookReturn">Estimated long-book return — not fund NAV</MetricTooltip>
          {r.lowCoverage && (
            <span title={`Only ${r.coveragePct?.toFixed(0)}% of book value has usable price data — renormalized over covered names`} style={{ marginLeft: 8, border: "1px solid var(--color-warning, #ffb224)", color: "var(--color-warning, #ffb224)", fontSize: 9, padding: "0 4px" }}>
              LOW COVERAGE {r.coveragePct?.toFixed(0)}%
            </span>
          )}
        </span>
        {r.confidence && (
          <span style={{ fontSize: 10 }}>
            <MetricTooltip id="confidence">
              <span style={{ color: r.confidence === "HIGH" ? "var(--color-positive)" : r.confidence === "LOW" ? "var(--color-negative)" : "var(--text-muted)" }}>
                CONFIDENCE: {r.confidence}
              </span>
            </MetricTooltip>
          </span>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)" }}>
        {r.windows.map((w) => (
          <div key={w.key} style={{ padding: "10px 12px", borderLeft: "1px solid var(--bg-border)" }}>
            <div style={{ fontSize: 10, color: "var(--text-muted)" }}>{w.key}{w.annualized ? " (ann.)" : ""}</div>
            {w.insufficient ? (
              <div style={{ fontSize: 12, color: "var(--text-muted)" }}>insufficient history</div>
            ) : (
              <>
                <div style={{ fontSize: 15, fontWeight: 700, color: w.ret! >= 0 ? "var(--color-positive)" : "var(--color-negative)" }}>{pts(w.ret!)}%</div>
                {w.excess != null && (
                  <div style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{pts(w.excess)} vs {r.benchmark}</div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
      <div style={{ borderTop: "1px solid var(--bg-border)", padding: "8px 12px", fontSize: 11, color: "var(--text-secondary)", display: "flex", flexWrap: "wrap", gap: 14 }}>
        {r.topContributors.length > 0 && (
          <span>
            <MetricTooltip id="contributors">top contributors</MetricTooltip>:{" "}
            {r.topContributors.map((c, i) => (
              <span key={c.ticker}>
                {i > 0 ? " · " : " "}
                <b onClick={() => onSelectTicker(c.ticker)} style={{ color: "var(--color-positive)", cursor: "pointer" }}>{c.ticker} {(c.contribBps / 100).toFixed(1)}</b>
              </span>
            ))}
          </span>
        )}
        {r.detractors.length > 0 && (
          <span>
            detractors:{" "}
            {r.detractors.map((c, i) => (
              <span key={c.ticker}>
                {i > 0 ? " · " : " "}
                <b onClick={() => onSelectTicker(c.ticker)} style={{ color: "var(--color-negative)", cursor: "pointer" }}>{c.ticker} {(c.contribBps / 100).toFixed(1)}</b>
              </span>
            ))}
          </span>
        )}
        {r.cloneReturn1Y != null && (
          <span>
            <MetricTooltip id="lagCost">clone @ filing, 1Y</MetricTooltip>: <b style={{ color: "var(--text-primary)" }}>{pts(r.cloneReturn1Y)}%</b>
            {r.lagCost1Y != null && <> — lag cost <b style={{ color: r.lagCost1Y >= 0 ? "var(--color-negative)" : "var(--color-positive)" }}>{r.lagCost1Y >= 0 ? "−" : "+"}{Math.abs(r.lagCost1Y * 100).toFixed(1)} pts</b></>}
          </span>
        )}
      </div>
    </div>
  );
}

// ── VS PEERS (Fund Overview Part 2) ──────────────────────────────────────────
function VsPeers({ v }: { v: FundVsPeersBlock }) {
  return (
    <div style={{ border: "1px solid var(--bg-border)" }}>
      <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--bg-border)", background: "var(--bg-surface)", fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
        Vs peers · {v.peerSetName} ({v.peerSetSize})
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
        <div style={{ padding: 10 }}>
          {v.percentiles.map((p) => (
            <div key={p.key} style={{ display: "grid", gridTemplateColumns: "120px 1fr 70px", gap: 8, alignItems: "center", padding: "3px 0", fontSize: 11 }}>
              <span style={{ color: "var(--text-secondary)" }}>{p.key}</span>
              <div style={{ position: "relative", height: 8, background: "var(--bg-border)" }}>
                {!p.tooSmall && p.percentile != null && (
                  <>
                    <span style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "var(--text-muted)" }} />
                    <span style={{ position: "absolute", left: `calc(${p.percentile}% - 3px)`, top: 0, bottom: 0, width: 6, background: "var(--color-accent)" }} />
                  </>
                )}
              </div>
              <span style={{ textAlign: "right", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                {p.tooSmall ? "set too small" : p.percentile != null ? `${ordinal(p.percentile)}` : "—"}
              </span>
            </div>
          ))}
          <div style={{ marginTop: 4, fontSize: 10, color: "var(--text-muted)" }}>
            <MetricTooltip id="peerMedian">│ = peer median</MetricTooltip>
          </div>
        </div>
        <div style={{ padding: 10, borderLeft: "1px solid var(--bg-border)" }}>
          <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
            <MetricTooltip id="overlap">Book overlap</MetricTooltip>
          </div>
          {v.overlaps.length === 0 ? (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>—</div>
          ) : (
            v.overlaps.map((o) => (
              <div key={o.name} style={{ display: "grid", gridTemplateColumns: "110px 1fr 40px", gap: 8, alignItems: "center", padding: "2px 0", fontSize: 11 }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}><FundLink cik={o.cik} name={o.name} /></span>
                <div style={{ height: 8, background: "var(--bg-border)", position: "relative" }}>
                  <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.min(100, o.overlapPct * 2)}%`, background: "#3d5a80" }} />
                </div>
                <span style={{ textAlign: "right", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{o.overlapPct.toFixed(0)}%</span>
              </div>
            ))
          )}
          <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", margin: "12px 0 6px" }}>
            <MetricTooltip id="differentiatedIdeas">Differentiated ideas</MetricTooltip>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {v.differentiatedIdeas.length === 0 ? (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>none in set</span>
            ) : (
              v.differentiatedIdeas.map((d) => (
                <span key={d.ticker} style={{ border: "1px solid #2b4a75", background: "rgba(0,191,255,0.08)", color: "var(--color-info)", fontSize: 11, padding: "2px 8px" }}>
                  {d.ticker} {d.pctOfBook.toFixed(1)}%
                </span>
              ))
            )}
          </div>
          {v.twins.length > 0 && (
            <>
              <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", margin: "12px 0 6px" }}>
                <MetricTooltip id="styleTwins">Style twins</MetricTooltip>
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {v.twins.slice(0, 6).map((t) => (
                  <span key={t.name} style={{ border: "1px solid var(--bg-border)", fontSize: 11, padding: "2px 8px", color: "var(--text-secondary)" }}>
                    <FundLink cik={t.cik} name={t.name} /> {Math.round(t.similarity * 100)}%
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]!);
}

function ColLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>{children}</div>;
}

function ProfileLine({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "0 0 4px", color: "var(--text-secondary)", fontSize: 11 }}>{children}</p>;
}
