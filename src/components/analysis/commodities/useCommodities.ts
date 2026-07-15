"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  CurveAnalyticsDto,
  CurveInfoDto,
  CurveSetDto,
  CurveVintagesDto,
  PriceDeckDto,
} from "@/types/commodities";

/**
 * React-query wrappers for /api/commodities/* (mirrors useRevision/useFlows).
 * Curves settle once daily, so 5-minute staleTime is generous. 404 NO_DATA →
 * "empty" so panels render the accruing state instead of red error text.
 */
function useCommoditiesQuery<T>(key: ReadonlyArray<unknown>, url: string, enabled = true) {
  const q = useQuery<T>({
    queryKey: key,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
        if (r.status === 404) return null as unknown as T; // NO_DATA → empty
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

export function useCurveRegistry() {
  return useCommoditiesQuery<{ curves: CurveInfoDto[] }>(["cmdx-curves"], "/api/commodities/curves");
}

export function useCurveVintages(
  code: string | null,
  ids: string[],
  basisMode: "DIFF" | "OUT",
  historyMonths: 0 | 12 | 24,
) {
  const idsParam = ids.join(",");
  return useCommoditiesQuery<CurveVintagesDto>(
    ["cmdx-vintages", code, idsParam, basisMode, historyMonths],
    `/api/commodities/curves/${code}/vintages?ids=${idsParam}&basisMode=${basisMode}&history=${historyMonths}`,
    code !== null,
  );
}

export function useCurveAnalytics(code: string | null, basisMode: "DIFF" | "OUT") {
  return useCommoditiesQuery<CurveAnalyticsDto>(
    ["cmdx-analytics", code, basisMode],
    `/api/commodities/curves/${code}/analytics?basisMode=${basisMode}`,
    code !== null,
  );
}

export function useCurveSets() {
  return useCommoditiesQuery<{ sets: CurveSetDto[] }>(["cmdx-sets"], "/api/commodities/sets");
}

export function usePriceDecks() {
  return useCommoditiesQuery<{ decks: PriceDeckDto[] }>(["cmdx-decks"], "/api/commodities/decks");
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!r.ok) {
    const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
    throw new Error(body.reason ?? (typeof body.error === "string" ? body.error : `HTTP ${r.status}`));
  }
  return r.json();
}

/** CRUD mutations for curve sets — every success invalidates the sets list. */
export function useCurveSetMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cmdx-sets"] });

  const create = useMutation({
    mutationFn: (input: { name: string; curveCodes?: string[] }) =>
      jsonFetch<CurveSetDto>("/api/commodities/sets", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });
  const rename = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      jsonFetch<CurveSetDto>(`/api/commodities/sets/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => jsonFetch(`/api/commodities/sets/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  const replaceItems = useMutation({
    mutationFn: ({ id, items }: { id: string; items: { curveCode: string; pinned: boolean }[] }) =>
      jsonFetch<CurveSetDto>(`/api/commodities/sets/${id}/items`, {
        method: "PUT",
        body: JSON.stringify({ items }),
      }),
    onSuccess: invalidate,
  });
  return { create, rename, remove, replaceItems };
}

export function usePriceDeckMutations() {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["cmdx-decks"] });

  const create = useMutation({
    mutationFn: (input: Record<string, unknown>) =>
      jsonFetch<PriceDeckDto>("/api/commodities/decks", { method: "POST", body: JSON.stringify(input) }),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => jsonFetch(`/api/commodities/decks/${id}`, { method: "DELETE" }),
    onSuccess: invalidate,
  });
  return { create, remove };
}

/** Fetch a deck's 360-month expansion (imperatively, for the ⧉ copy button). */
export async function fetchDeckExpansion(
  deckId: string,
  curveCode: string,
): Promise<{ months: { month: string; price: number }[] }> {
  return jsonFetch(`/api/commodities/decks/${deckId}/expanded?curve=${curveCode}`);
}

/** Fetch the futures-only export table. */
export async function fetchExportTable(body: {
  curveCodes: string[];
  vintageId: string;
  basisMode: "DIFF" | "OUT";
}): Promise<{ headers: string[]; rows: (string | number | null)[][] }> {
  return jsonFetch("/api/commodities/export", { method: "POST", body: JSON.stringify(body) });
}
