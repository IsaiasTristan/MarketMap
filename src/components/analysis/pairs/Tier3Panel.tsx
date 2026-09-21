"use client";
/**
 * Tier 3 panel (brief §8.6) — the curated-link read-through table plus a compact
 * admin link editor gated on useIsAdmin. Ships with zero links by design (§15.3),
 * so with an empty list the panel states that Tier 3 is curated and currently
 * empty rather than rendering a blank table.
 */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { usePairReadThroughs, usePairLinks } from "./usePairs";
import { useIsAdmin } from "@/lib/api/useMe";
import { PAIR_THRESHOLDS } from "@/lib/pairs/config";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import type { PairReadThroughPayload } from "@/server/services/pairs/pairs-read.service";

const RELATIONS = ["SUPPLIER_CUSTOMER", "SUBSTITUTE", "INPUT_COST"] as const;

function relationLabel(r: string): string {
  return r === "SUPPLIER_CUSTOMER" ? "Supplier ▸ Customer" : r === "INPUT_COST" ? "Input cost (inverse)" : "Substitutes";
}

function statusChip(status: string) {
  const color = status === "CONFIRMED" ? "var(--color-positive)" : status === "WATCH" ? "var(--color-accent)" : "var(--text-muted)";
  return (
    <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color, border: `1px solid ${color}`, padding: "0 4px" }}>
      {status}
    </span>
  );
}

function num(v: number | null, dp = 2): string {
  return v === null || !Number.isFinite(v) ? "—" : v.toFixed(dp);
}

function ReadThroughRow({ r }: { r: PairReadThroughPayload }) {
  const firedTicker = r.firedSide === "A" ? r.tickerA : r.firedSide === "B" ? r.tickerB : null;
  const otherTicker = r.firedSide === "A" ? r.tickerB : r.firedSide === "B" ? r.tickerA : null;
  return (
    <tr style={{ borderTop: "1px solid var(--chrome-border)" }}>
      <td style={{ padding: "3px 6px", fontWeight: 700 }}>
        {r.tickerA} <span style={{ color: "var(--text-muted)" }}>·</span> {r.tickerB}
      </td>
      <td style={{ padding: "3px 6px", color: "var(--text-secondary)" }}>{relationLabel(r.relationType)}</td>
      <td style={{ padding: "3px 6px", textAlign: "right" }}>
        {firedTicker ? (
          <span>
            <span style={{ color: "var(--color-accent)", fontWeight: 700 }}>{firedTicker}</span>{" "}
            <span className="bb-num">{num(r.firedScore)}</span>
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>—</span>
        )}
      </td>
      <td style={{ padding: "3px 6px", textAlign: "right" }} className="bb-num">
        {otherTicker ? `${otherTicker} ${num(r.otherScore)}` : "—"}
      </td>
      <td style={{ padding: "3px 6px", textAlign: "right" }} className="bb-num">{r.weeksElapsed ?? "—"}</td>
      <td style={{ padding: "3px 6px", textAlign: "center" }}>{statusChip(r.status)}</td>
    </tr>
  );
}

function AdminEditor() {
  const qc = useQueryClient();
  const links = usePairLinks();
  const [tickerA, setTickerA] = useState("");
  const [tickerB, setTickerB] = useState("");
  const [relationType, setRelationType] = useState<(typeof RELATIONS)[number]>("SUBSTITUTE");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    await qc.invalidateQueries({ queryKey: ["pairs-links"] });
    await qc.invalidateQueries({ queryKey: ["pairs-readthrough"] });
  }

  async function create() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch("/api/analysis/pairs/links", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tickerA, tickerB, relationType, note: note || undefined }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setTickerA("");
      setTickerB("");
      setNote("");
      await refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(id: string, active: boolean) {
    await fetch("/api/analysis/pairs/links", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, active }),
    });
    await refresh();
  }

  async function remove(id: string) {
    await fetch("/api/analysis/pairs/links", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    });
    await refresh();
  }

  const inputStyle: React.CSSProperties = {
    fontSize: 10,
    padding: "2px 5px",
    background: "var(--bg-base)",
    border: "1px solid var(--chrome-border)",
    color: "var(--text-primary)",
  };

  return (
    <div style={{ marginTop: 8, paddingTop: 6, borderTop: "1px dashed var(--chrome-border)" }}>
      <div style={{ fontSize: 8.5, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
        Admin — curate links (tickerA is the mover-first side)
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
        <input placeholder="Ticker A" value={tickerA} onChange={(e) => setTickerA(e.target.value)} style={{ ...inputStyle, width: 68 }} />
        <input placeholder="Ticker B" value={tickerB} onChange={(e) => setTickerB(e.target.value)} style={{ ...inputStyle, width: 68 }} />
        <select value={relationType} onChange={(e) => setRelationType(e.target.value as (typeof RELATIONS)[number])} style={inputStyle}>
          {RELATIONS.map((r) => (
            <option key={r} value={r}>{relationLabel(r)}</option>
          ))}
        </select>
        <input placeholder="Note (why this link exists)" value={note} onChange={(e) => setNote(e.target.value)} style={{ ...inputStyle, flex: 1, minWidth: 160 }} />
        <button
          onClick={create}
          disabled={busy || !tickerA || !tickerB}
          style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.4, textTransform: "uppercase", padding: "3px 10px", border: "none", cursor: "pointer", color: "#000", background: "var(--color-accent)", opacity: busy || !tickerA || !tickerB ? 0.5 : 1 }}
        >
          Add
        </button>
      </div>
      {err ? <div style={{ fontSize: 9, color: "var(--color-negative)", marginTop: 3 }}>{err}</div> : null}
      {links.data && links.data.links.length > 0 ? (
        <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 2 }}>
          {links.data.links.map((l) => (
            <div key={l.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 9.5, color: l.active ? "var(--text-secondary)" : "var(--text-muted)" }}>
              <span style={{ fontWeight: 700 }}>{l.tickerA} · {l.tickerB}</span>
              <span>{relationLabel(l.relationType)}</span>
              {l.note ? <span style={{ color: "var(--text-muted)", fontStyle: "italic" }}>{l.note}</span> : null}
              {!l.active ? <span style={{ color: "var(--text-muted)" }}>(inactive)</span> : null}
              <span style={{ marginLeft: "auto", display: "inline-flex", gap: 8 }}>
                <button onClick={() => toggle(l.id, !l.active)} style={{ fontSize: 8.5, background: "none", border: "none", color: "var(--color-accent)", cursor: "pointer" }}>
                  {l.active ? "disable" : "enable"}
                </button>
                <button onClick={() => remove(l.id)} style={{ fontSize: 8.5, background: "none", border: "none", color: "var(--color-negative)", cursor: "pointer" }}>
                  delete
                </button>
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function Tier3Panel() {
  const rt = usePairReadThroughs();
  const isAdmin = useIsAdmin();
  const rows = rt.data?.rows ?? [];

  return (
    <ChartCard
      title="Tier 3 — curated-link read-through"
      subtitle={
        rt.data?.snapshotDate
          ? `As of ${rt.data.snapshotDate}. A read-through fires when one side's Engine-1 z clears ${PAIR_THRESHOLDS.tier3FiredZ} while the other stays below ${PAIR_THRESHOLDS.tier3QuietZ}.`
          : "Hand-curated links between economically connected companies."
      }
      fillHeight
    >
      <div style={{ height: "100%", overflow: "auto" }}>
      {rows.length === 0 ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.5 }}>
          Tier 3 is a hand-curated list of economically linked companies and is currently empty. A read-through fires when one
          side&apos;s Engine-1 z clears {PAIR_THRESHOLDS.tier3FiredZ} while the other stays below {PAIR_THRESHOLDS.tier3QuietZ}; it escalates to
          WATCH after {PAIR_THRESHOLDS.tier3WatchWeeks} weeks and CONFIRMS when the second side follows the expected way.
          {isAdmin ? " Add links below." : " An admin can curate links."}
        </div>
      ) : (
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 10 }}>
          <thead>
            <tr style={{ color: "var(--text-muted)", textAlign: "left", fontSize: 8.5, letterSpacing: 0.4, textTransform: "uppercase" }}>
              <th style={{ padding: "0 6px" }}>Link</th>
              <th style={{ padding: "0 6px" }}>Relation</th>
              <th style={{ padding: "0 6px", textAlign: "right" }}>Fired side</th>
              <th style={{ padding: "0 6px", textAlign: "right" }}>Other side</th>
              <th style={{ padding: "0 6px", textAlign: "right" }}>Weeks</th>
              <th style={{ padding: "0 6px", textAlign: "center" }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <ReadThroughRow key={r.linkId} r={r} />
            ))}
          </tbody>
        </table>
      )}
      {isAdmin ? <AdminEditor /> : null}
      </div>
    </ChartCard>
  );
}
