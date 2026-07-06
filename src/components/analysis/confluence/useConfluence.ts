"use client";
/**
 * CONFLUENCE data hook — same shape as useFlows/useRevision: react-query with
 * the 404 NO_DATA → null convention so a cold start renders the accruing
 * placeholder instead of red text, plus a derived `state` string for
 * PanelState.
 */
import { useQuery } from "@tanstack/react-query";
import type { ConfluencePayload } from "@/server/services/confluence.service";

export function useConfluence(portfolioId: string | null) {
  const url = portfolioId
    ? `/api/analysis/confluence?portfolioId=${portfolioId}`
    : "/api/analysis/confluence";
  const q = useQuery<ConfluencePayload | null>({
    queryKey: ["confluence", portfolioId],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        if (r.status === 404) return null; // NO_DATA → empty, not error
        throw new Error(body.reason ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
      }
      return r.json();
    },
  });
  const state = q.isLoading ? "loading" : q.error ? "error" : q.data == null ? "empty" : "ready";
  return { ...q, state };
}
