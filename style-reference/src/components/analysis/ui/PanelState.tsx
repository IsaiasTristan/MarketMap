"use client";
/**
 * Shared loading/error/empty renderer for data panels, keyed by the derived
 * `state` string from useFlows/useRevision. Moved out of flowsUi so research
 * panels can use it without importing the flows grab-bag; flowsUi re-exports
 * for back-compat.
 */
import type { CSSProperties, ReactNode } from "react";

export function PanelState({ state, error, children }: { state: string; error?: unknown; children: ReactNode }) {
  if (state === "loading") return <Muted>Loading…</Muted>;
  if (state === "error") return <Muted tone="negative">{error instanceof Error ? error.message : "Failed to load."}</Muted>;
  if (state === "empty") return <Muted>No data for this period.</Muted>;
  return <>{children}</>;
}

export function Muted({ children, tone, style }: { children: ReactNode; tone?: "negative"; style?: CSSProperties }) {
  return (
    <div style={{ padding: 20, fontSize: 12, color: tone === "negative" ? "var(--color-negative)" : "var(--text-muted)", ...style }}>
      {children}
    </div>
  );
}
