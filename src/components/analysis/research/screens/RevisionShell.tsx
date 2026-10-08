"use client";
/**
 * Engine 1 rebuild — the chrome the three screens share: what the rank is,
 * how well it has measured, and where you are in the universe → queue → name
 * zoom. The status strip replaces the old red staleness banner; it states the
 * measurement honestly (ACCRUING below the minimum effective-week count)
 * instead of hiding the screens behind a warning.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { StatusChips } from "../primitives";
import { REVISION_BASE, useFunnelValidation } from "./useScreens";

const NAV = [
  { href: REVISION_BASE, label: "Universe" },
  { href: `${REVISION_BASE}/queue`, label: "Research queue" },
  { href: `${REVISION_BASE}/validation`, label: "Validation" },
];

/** Headline horizon — the one the funnel treats as primary. */
const HEADLINE_HORIZON = 4;

export function RevisionShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  const pathname = usePathname();
  const { data: funnel } = useFunnelValidation();
  const ic = funnel?.icByHorizon.find((r) => r.horizonWeeks === HEADLINE_HORIZON) ?? null;
  const overlap = funnel?.funnel.find((f) => f.horizonWeeks === HEADLINE_HORIZON)?.overlap.meanJaccard ?? null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: "8px 10px 24px" }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 14, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", margin: 0 }}>
          {title}
        </h1>
        {subtitle && <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{subtitle}</span>}
        <div style={{ flex: 1 }} />
        <nav style={{ display: "flex", gap: 1 }}>
          {NAV.map((n) => {
            const active = n.href === REVISION_BASE ? pathname === n.href : pathname.startsWith(n.href);
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

      <StatusChips
        rankSignal={funnel?.rankSignal ?? "ptRevOrthZ"}
        horizonWeeks={HEADLINE_HORIZON}
        meanIC={ic?.meanIC ?? null}
        hacT={ic?.hacT ?? null}
        naiveT={ic?.naiveT ?? null}
        effectiveWeeks={ic?.effectiveWeeks ?? null}
        headlineMinWeeks={funnel?.headlineMinWeeks ?? 26}
        headlineReady={funnel?.headlineReady ?? false}
        overlap={overlap}
        gridWeeks={funnel?.grid.weeks ?? 0}
      />

      {children}
    </div>
  );
}
