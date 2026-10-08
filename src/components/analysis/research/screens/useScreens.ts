"use client";
/**
 * Engine 1 rebuild — data hooks + the URL contract for the three screens.
 *
 * Every filter lives in the query string so Screen 1 can deep-link into a
 * filtered Screen 2 and the browser back button restores the exact view.
 */
import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRevision } from "../useRevision";
import type { FunnelValidationPayload } from "@/server/services/revision/revision-funnel.service";
import type { QueueScreenPayload, UniversePayload } from "@/server/services/revision/revision-screen.service";
import type { NamePayload } from "@/server/services/revision/revision-name.service";

export const REVISION_BASE = "/research/revision";

export type Side = "long" | "short" | "both";

export interface QueueQuery {
  date?: string;
  side: Side;
  minZ: number;
  cap?: string;
  cov?: string;
  minWeeks?: number;
  er?: number;
  new?: boolean;
  tri?: boolean;
  subsector?: string;
  q?: string;
  page: number;
}

export const QUEUE_DEFAULTS = { side: "both" as Side, minZ: 1, page: 1, pageSize: 50 };

/** Parse the queue's URL state; defaults match the server's zod defaults. */
export function parseQueueQuery(sp: URLSearchParams): QueueQuery {
  const num = (k: string) => {
    const v = sp.get(k);
    if (v === null || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const side = sp.get("side");
  return {
    date: sp.get("date") ?? undefined,
    side: side === "long" || side === "short" ? side : QUEUE_DEFAULTS.side,
    minZ: num("minZ") ?? QUEUE_DEFAULTS.minZ,
    cap: sp.get("cap") ?? undefined,
    cov: sp.get("cov") ?? undefined,
    minWeeks: num("minWeeks"),
    er: num("er"),
    new: sp.get("new") === "1" || sp.get("new") === "true" ? true : undefined,
    tri: sp.get("tri") === "1" || sp.get("tri") === "true" ? true : undefined,
    subsector: sp.get("subsector") ?? undefined,
    q: sp.get("q") ?? undefined,
    page: num("page") ?? QUEUE_DEFAULTS.page,
  };
}

/** Serialize back to a query string, omitting anything at its default. */
export function queueQueryString(q: Partial<QueueQuery>, pageSize = QUEUE_DEFAULTS.pageSize): string {
  const sp = new URLSearchParams();
  if (q.date) sp.set("date", q.date);
  if (q.side && q.side !== QUEUE_DEFAULTS.side) sp.set("side", q.side);
  if (q.minZ !== undefined && q.minZ !== QUEUE_DEFAULTS.minZ) sp.set("minZ", String(q.minZ));
  if (q.cap) sp.set("cap", q.cap);
  if (q.cov) sp.set("cov", q.cov);
  if (q.minWeeks) sp.set("minWeeks", String(q.minWeeks));
  if (q.er !== undefined) sp.set("er", String(q.er));
  if (q.new) sp.set("new", "1");
  if (q.tri) sp.set("tri", "1");
  if (q.subsector) sp.set("subsector", q.subsector);
  if (q.q) sp.set("q", q.q);
  if (q.page && q.page > 1) sp.set("page", String(q.page));
  if (pageSize !== QUEUE_DEFAULTS.pageSize) sp.set("pageSize", String(pageSize));
  return sp.toString();
}

/** Queue filter state bound to the URL: every change is a shallow replace. */
export function useQueueQuery() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = useMemo(() => parseQueueQuery(new URLSearchParams(searchParams.toString())), [searchParams]);

  const set = useCallback(
    (patch: Partial<QueueQuery>) => {
      // Any filter change invalidates the page cursor unless the page IS the change.
      const next = { ...query, ...patch, page: patch.page ?? 1 };
      const qs = queueQueryString(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [pathname, query, router],
  );

  return { query, set };
}

export function useFunnelValidation() {
  return useRevision<FunnelValidationPayload>(["revision-funnel"], "/api/analysis/research/funnel");
}

export function useUniverseScreen(date?: string) {
  return useRevision<UniversePayload>(
    ["revision-universe", date ?? "latest"],
    `/api/analysis/research/universe${date ? `?date=${date}` : ""}`,
  );
}

export function useQueueScreen(query: QueueQuery) {
  const qs = queueQueryString(query);
  return useRevision<QueueScreenPayload>(
    ["revision-queue", qs],
    `/api/analysis/research/screen${qs ? `?${qs}` : ""}`,
  );
}

export function useNameScreen(ticker: string | null) {
  return useRevision<NamePayload>(
    ["revision-name", ticker ?? ""],
    `/api/analysis/research/name/${encodeURIComponent(ticker ?? "")}`,
    Boolean(ticker),
  );
}
