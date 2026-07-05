"use client";
/**
 * FUNDS — single-fund signal-provenance page (FUNDS Part 4b). Reached by
 * clicking any fund name anywhere in the tool (FundLink) or via the deep-link
 * `/flows?tab=funds&fund=<cik>`. Mirrors the mockup's `.fp` section.
 */
import type { FundPagePayload, FundInitiationOutcome } from "@/server/services/institutional/institutional-fund-page.service";
import { useFlows } from "../useFlows";
import { PanelState, fmtUsdCompact, quarterLabel } from "../flowsUi";

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
        <StatChip label="turnover" value={turnover != null ? `${turnover.toFixed(0)}%/q` : "—"} />
        <StatChip label="top-10 = " value={data.stats.top10ConcentrationPct != null ? `${data.stats.top10ConcentrationPct.toFixed(0)}% of book` : "—"} />
        <StatChip label="clone alpha" value="pending returns engine" highlight />
      </div>

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

function StatChip({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <span
      style={{
        border: `1px solid ${highlight ? "var(--color-info)" : "var(--bg-border)"}`,
        padding: "3px 9px",
        fontSize: 11,
        color: highlight ? "var(--color-info)" : "var(--text-muted)",
      }}
    >
      {label} <b style={{ color: highlight ? "var(--color-info)" : "var(--text-primary)" }}>{value}</b>
    </span>
  );
}

function ColLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 8 }}>{children}</div>;
}

function ProfileLine({ children }: { children: React.ReactNode }) {
  return <p style={{ margin: "0 0 4px", color: "var(--text-secondary)", fontSize: 11 }}>{children}</p>;
}
