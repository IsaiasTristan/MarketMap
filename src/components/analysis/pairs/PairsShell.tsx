"use client";
/**
 * Pairs tab chrome: title, the Pair Map ⇄ Hedge Finder nav, and a vintage strip
 * stating each engine's as-of date so the honest point-in-time / restated-basis
 * caveats are always visible (brief §8.1). Reads the universe payload for the
 * vintage; the child screens own their panels.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { usePairUniverse } from "./usePairs";

const PAIRS_BASE = "/pairs";
const NAV = [
  { href: PAIRS_BASE, label: "Pair Map" },
  { href: `${PAIRS_BASE}/hedge`, label: "Hedge Finder" },
  { href: `${PAIRS_BASE}/validation`, label: "Validation" },
];

function VintagePill({ label, value }: { label: string; value: string | null }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "baseline", gap: 4, whiteSpace: "nowrap" }}>
      <span style={{ fontSize: 9, letterSpacing: 0.5, color: "var(--text-muted)", textTransform: "uppercase" }}>
        {label}
      </span>
      <span className="bb-num" style={{ fontSize: 10, fontWeight: 700, color: value ? "var(--text-primary)" : "var(--text-muted)" }}>
        {value ?? "—"}
      </span>
    </span>
  );
}

export function PairsShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const { data: uni } = usePairUniverse("EQUAL");
  const v = uni?.vintage;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 10px 12px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", margin: 0 }}>{title}</h1>
        {subtitle && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{subtitle}</span>}
        <div style={{ flex: 1 }} />
        <nav style={{ display: "flex", gap: 1 }}>
          {NAV.map((n) => {
            const active = n.href === PAIRS_BASE ? pathname === n.href : pathname.startsWith(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                style={{
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                  padding: "3px 10px",
                  textDecoration: "none",
                  color: active ? "#000" : "var(--text-muted)",
                  background: active ? "var(--color-accent)" : "var(--bg-surface)",
                  border: "1px solid var(--chrome-border)",
                }}
              >
                {n.label}
              </Link>
            );
          })}
        </nav>
      </div>

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: 16,
          padding: "4px 10px",
          border: "1px solid var(--chrome-border)",
          background: "var(--bg-surface)",
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: 0.6, color: "var(--text-muted)", textTransform: "uppercase" }}>
          As of {uni?.snapshotDate ?? "—"} · vintage
        </span>
        <VintagePill label="E1 revisions" value={v?.e1 ?? null} />
        <VintagePill label="E2 fundamentals (qtr, restated)" value={v?.e2 ?? null} />
        <VintagePill label="E3 13F (qtr)" value={v?.e3 ?? null} />
        <VintagePill label="E4 factors" value={v?.e4 ?? null} />
        <span style={{ width: 1, alignSelf: "stretch", background: "var(--chrome-border)" }} />
        <VintagePill label="basket pairs" value={uni ? uni.pairCount.toLocaleString() : null} />
        <VintagePill label={`pass hedge-eff`} value={uni ? uni.passHedgeEff.toLocaleString() : null} />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 9, color: "var(--text-muted)" }}>
          Backfilled weeks use current-taxonomy membership (labelled, not silent).
        </span>
      </div>

      {children}
    </div>
  );
}
