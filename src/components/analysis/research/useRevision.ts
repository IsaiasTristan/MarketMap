"use client";
import { useQuery } from "@tanstack/react-query";

/**
 * Thin react-query wrapper for the /api/analysis/research/* endpoints
 * (mirrors flows/useFlows). Data changes weekly (scores) / daily (events), so
 * a 5-minute staleTime is plenty. 404 NO_DATA → "empty", not error, so panels
 * render their accruing/empty states instead of red text.
 */
export function useRevision<T>(key: ReadonlyArray<unknown>, url: string, enabled = true) {
  const q = useQuery<T>({
    queryKey: key,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
        if (r.status === 404) return null as unknown as T; // NO_DATA → empty, not error
        throw new Error(body.reason ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
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
