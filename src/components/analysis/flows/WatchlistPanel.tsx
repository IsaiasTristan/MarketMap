"use client";
/** Editable fund watchlist. All users can view; admins edit (toggle, add, remove). */
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { FundRow } from "@/server/services/institutional/institutional-query.service";
import { useFlows } from "./useFlows";
import { PanelState } from "./flowsUi";

const TIER_LABEL: Record<number, string> = { 1: "Growth/Quality", 2: "Value", 3: "Activist" };

export function WatchlistPanel({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const { data, state, error } = useFlows<{ funds: FundRow[] }>(["flows-funds"], "/api/analysis/flows/funds");
  const [busy, setBusy] = useState<string | null>(null);
  const [form, setForm] = useState({ cik: "", name: "", edgarName: "", tier: 1 });
  const [msg, setMsg] = useState<string | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["flows-funds"] });

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    try {
      const r = await fetch(`/api/analysis/flows/funds/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Update failed");
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string, name: string) {
    if (!confirm(`Remove ${name} from the watchlist? Its snapshots will be deleted.`)) return;
    setBusy(id);
    try {
      const r = await fetch(`/api/analysis/flows/funds/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).reason ?? "Delete failed");
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }
  async function add() {
    setMsg(null);
    try {
      const r = await fetch("/api/analysis/flows/funds", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(form) });
      if (!r.ok) {
        const b = await r.json().catch(() => ({}));
        throw new Error(b.error === "DUPLICATE_CIK" ? "That CIK is already on the watchlist." : b.reason ?? "Create failed");
      }
      setForm({ cik: "", name: "", edgarName: "", tier: 1 });
      refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
        The curated 13F watchlist — editable configuration, not hardcoded. {isAdmin ? "Toggle active/most-respected, edit tier, add or remove funds by CIK." : "Read-only (admin edits)."} Re-run the ingest job after changes.
      </div>
      {msg && <div style={{ fontSize: 11, color: "var(--color-negative)" }}>{msg}</div>}

      {isAdmin && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: 8, border: "1px solid var(--bg-border)", background: "var(--bg-surface)" }}>
          <input placeholder="CIK (10-digit)" value={form.cik} onChange={(e) => setForm({ ...form, cik: e.target.value })} style={inp(120)} />
          <input placeholder="Display name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={inp(160)} />
          <input placeholder="EDGAR filer name" value={form.edgarName} onChange={(e) => setForm({ ...form, edgarName: e.target.value })} style={inp(200)} />
          <select value={form.tier} onChange={(e) => setForm({ ...form, tier: Number(e.target.value) })} style={inp(120)}>
            <option value={1}>Growth/Quality</option><option value={2}>Value</option><option value={3}>Activist</option>
          </select>
          <button type="button" onClick={add} disabled={!form.cik || !form.name} style={btn()}>+ Add fund</button>
        </div>
      )}

      <PanelState state={state} error={error}>
        {data && (
          <div style={{ border: "1px solid var(--bg-border)", overflowX: "auto" }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 110px 90px 80px", gap: 6, padding: "6px 10px", fontSize: 10, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", background: "var(--bg-surface)", borderBottom: "1px solid var(--bg-border)" }}>
              <div>Fund · CIK</div><div>Tier</div><div style={{ textAlign: "right" }}>Holdings</div><div style={{ textAlign: "center" }}>Most-respected</div><div style={{ textAlign: "center" }}>Active</div><div />
            </div>
            {data.funds.map((f) => (
              <div key={f.id} style={{ display: "grid", gridTemplateColumns: "1fr 110px 90px 110px 90px 80px", gap: 6, padding: "6px 10px", alignItems: "center", borderBottom: "1px solid var(--bg-border)", fontSize: 11, opacity: f.isActive ? 1 : 0.5 }}>
                <div>
                  <span style={{ fontWeight: 700, color: "var(--text-primary)" }}>{f.name}</span>
                  <span style={{ color: "var(--text-muted)", marginLeft: 6, fontSize: 10 }}>{f.cik}</span>
                </div>
                <div style={{ color: "var(--text-secondary)" }}>{TIER_LABEL[f.tier] ?? f.tier}</div>
                <div style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", color: f.latestHoldings ? "#fff" : "var(--text-muted)" }}>{f.latestHoldings ?? "—"}</div>
                <div style={{ textAlign: "center" }}>
                  <button type="button" disabled={!isAdmin || busy === f.id} onClick={() => patch(f.id, { isMostRespected: !f.isMostRespected })} style={toggle(f.isMostRespected, "var(--color-accent)")}>{f.isMostRespected ? "★ yes" : "no"}</button>
                </div>
                <div style={{ textAlign: "center" }}>
                  <button type="button" disabled={!isAdmin || busy === f.id} onClick={() => patch(f.id, { isActive: !f.isActive })} style={toggle(f.isActive, "var(--color-positive)")}>{f.isActive ? "on" : "off"}</button>
                </div>
                <div style={{ textAlign: "right" }}>
                  {isAdmin && <button type="button" disabled={busy === f.id} onClick={() => remove(f.id, f.name)} style={{ ...btn(), color: "var(--color-negative)" }}>✕</button>}
                </div>
              </div>
            ))}
          </div>
        )}
      </PanelState>
    </div>
  );
}

const inp = (w: number) => ({ width: w, height: 22, padding: "0 6px", background: "var(--bg-elevated)", border: "1px solid var(--bg-border)", color: "var(--text-primary)", fontSize: 11, borderRadius: 0 }) as const;
const btn = () => ({ padding: "3px 8px", border: "1px solid var(--chrome-border)", background: "var(--bg-base)", color: "var(--text-secondary)", fontSize: 11, cursor: "pointer", borderRadius: 0 }) as const;
const toggle = (on: boolean, color: string) => ({ padding: "1px 8px", border: `1px solid ${on ? color : "var(--bg-border)"}`, background: on ? color : "transparent", color: on ? "#000" : "var(--text-muted)", fontSize: 10, fontWeight: 700, cursor: "pointer", borderRadius: 0 }) as const;
