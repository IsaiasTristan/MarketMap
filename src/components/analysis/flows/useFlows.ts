"use client";
import { useQuery } from "@tanstack/react-query";

/**
 * Thin react-query wrapper for the /api/analysis/flows/* endpoints. 13F changes
 * only quarterly, so cache aggressively. Returns a derived `state` for the
 * shared PanelState renderer.
 */
export function useFlows<T>(key: ReadonlyArray<unknown>, url: string, enabled = true) {
  const q = useQuery<T>({
    queryKey: key,
    enabled,
    staleTime: 15 * 60_000,
    queryFn: async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
        if (r.status === 404) return null as unknown as T; // NO_DATA → empty, not error
        throw new Error(body.reason ?? body.error ?? `HTTP ${r.status}`);
      }
      return r.json();
    },
  });
  const state = !enabled
    ? "idle"
    : q.isLoading
      ? "loading"
      : q.error
        ? "error"
        : q.data == null
          ? "empty"
          : "ready";
  return { ...q, state };
}
