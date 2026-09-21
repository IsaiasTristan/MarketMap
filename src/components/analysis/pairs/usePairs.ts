"use client";
/**
 * Pairs tab — react-query hooks + the URL contract, mirroring the research
 * `useRevision` wrapper. 404 NO_DATA → empty (not error) so panels render their
 * own empty state. Data changes weekly, so a 5-minute staleTime is plenty.
 */
import { useQuery } from "@tanstack/react-query";
import type {
  PairDispersionPayload,
  PairLinkPayload,
  PairMatrixPayload,
  PairRankPayload,
  PairReadThroughPayload,
  PairTier2Payload,
  PairUniversePayload,
} from "@/server/services/pairs/pairs-read.service";
import type { HedgeFinderResult } from "@/server/services/pairs/hedge-finder.service";

export type PairWeighting = "EQUAL" | "CAP";
export type PairScope = "within" | "cross" | "all";

function usePairsQuery<T>(key: ReadonlyArray<unknown>, url: string, enabled = true) {
  const q = useQuery<T>({
    queryKey: key,
    enabled,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { reason?: string; error?: string };
        if (r.status === 404) return null as unknown as T;
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
  return { ...q, state } as typeof q & { state: string };
}

export function usePairUniverse(weighting: PairWeighting) {
  return usePairsQuery<PairUniversePayload>(["pairs-universe"], `/api/analysis/pairs/universe`);
}

export function usePairMatrix(weighting: PairWeighting, sector?: string, groupType: "SUBSECTOR" | "SECTOR" = "SUBSECTOR") {
  const qs = new URLSearchParams({ weighting, groupType });
  if (sector) qs.set("sector", sector);
  return usePairsQuery<PairMatrixPayload>(
    ["pairs-matrix", weighting, sector ?? "", groupType],
    `/api/analysis/pairs/matrix?${qs}`,
  );
}

export function usePairRank(opts: {
  weighting: PairWeighting;
  scope: PairScope;
  minHedgeEff?: number;
  driver?: "E1" | "E2" | "BOTH";
  sector?: string;
  limit?: number;
}) {
  const qs = new URLSearchParams({ weighting: opts.weighting, scope: opts.scope });
  if (opts.minHedgeEff !== undefined) qs.set("minHedgeEff", String(opts.minHedgeEff));
  if (opts.driver) qs.set("driver", opts.driver);
  if (opts.sector) qs.set("sector", opts.sector);
  if (opts.limit) qs.set("limit", String(opts.limit));
  return usePairsQuery<PairRankPayload>(["pairs-rank", qs.toString()], `/api/analysis/pairs/rank?${qs}`);
}

export function usePairDispersion(weighting: PairWeighting) {
  return usePairsQuery<PairDispersionPayload>(
    ["pairs-dispersion", weighting],
    `/api/analysis/pairs/dispersion?weighting=${weighting}`,
  );
}

export function usePairTier2(subsector: string | null, weighting: PairWeighting) {
  const qs = new URLSearchParams({ weighting });
  if (subsector) qs.set("subsector", subsector);
  return usePairsQuery<PairTier2Payload>(
    ["pairs-tier2", subsector ?? "", weighting],
    `/api/analysis/pairs/tier2?${qs}`,
    Boolean(subsector),
  );
}

export function usePairReadThroughs() {
  return usePairsQuery<{ snapshotDate: string | null; rows: PairReadThroughPayload[] }>(
    ["pairs-readthrough"],
    `/api/analysis/pairs/readthrough`,
  );
}

export function usePairLinks() {
  return usePairsQuery<{ links: PairLinkPayload[] }>(["pairs-links"], `/api/analysis/pairs/links?all=1`);
}

export function useHedge(target: string | null, mode: "neutralize" | "express", maxNames?: number) {
  const qs = new URLSearchParams();
  if (target) qs.set("target", target);
  qs.set("mode", mode);
  if (maxNames) qs.set("maxNames", String(maxNames));
  return usePairsQuery<HedgeFinderResult>(
    ["pairs-hedge", target ?? "", mode, maxNames ?? 0],
    `/api/analysis/pairs/hedge?${qs}`,
    Boolean(target),
  );
}
