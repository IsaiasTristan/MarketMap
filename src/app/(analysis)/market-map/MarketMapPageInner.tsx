"use client";

import type { CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarketMapClient } from "@/components/MarketMapClient";
import { ManageTickersModal } from "@/components/ManageTickersModal";

const AUTO_REFRESH_MS = 30_000;

export function MarketMapPageInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const universeIdParam = sp.get("universeId");

  const [resolvedUniverseId, setResolvedUniverseId] = useState<string | null>(
    universeIdParam
  );
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [ingesting, setIngesting] = useState(false);
  const [ingestErr, setIngestErr] = useState<string | null>(null);
  const ingestStartedFor = useRef<string | null>(null);

  useEffect(() => {
    if (universeIdParam) {
      setResolvedUniverseId(universeIdParam);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/universe/default", { cache: "no-store" });
        const j = (await res.json()) as { id?: string; error?: string };
        if (cancelled) return;
        if (!res.ok || !j.id) {
          setResolveErr(j.error ?? "Failed to load universe.");
          return;
        }
        setResolvedUniverseId(j.id);
      } catch (e) {
        if (cancelled) return;
        setResolveErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [universeIdParam]);

  // Tick the clock so the "Xs ago" label stays current without re-renders elsewhere.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(t);
  }, []);

  const triggerIngest = useCallback(
    async (universeId: string, mode: "missing" | "all") => {
      if (ingesting) return;
      setIngesting(true);
      setIngestErr(null);
      try {
        const qs = mode === "missing" ? "?onlyMissing=true" : "";
        const [universeRes, benchRes] = await Promise.allSettled([
          fetch(`/api/universes/${universeId}/ingest${qs}`, {
            method: "POST",
            keepalive: true,
          }),
          fetch(`/api/benchmarks/ingest${qs}`, {
            method: "POST",
            keepalive: true,
          }),
        ]);

        const notes: string[] = [];
        if (universeRes.status === "fulfilled") {
          const j = (await universeRes.value
            .json()
            .catch(() => null)) as
            | { ok?: boolean; tickers?: number; failed?: { ticker: string }[] }
            | null;
          if (j?.failed?.length) {
            const sample = j.failed
              .slice(0, 3)
              .map((f) => f.ticker)
              .join(", ");
            notes.push(
              `${j.failed.length} ticker(s) couldn't be priced (${sample}${
                j.failed.length > 3 ? ", …" : ""
              }).`
            );
          }
        } else {
          notes.push("Universe price refresh request failed.");
        }
        if (benchRes.status === "rejected") {
          notes.push("Benchmark price refresh request failed.");
        }
        setIngestErr(notes.length ? notes.join(" ") : null);
        // Nudge the chart to re-fetch immediately after ingest completes so
        // newly-loaded tickers appear without waiting for the next poll.
        setReloadToken((n) => n + 1);
      } catch (e) {
        setIngestErr(e instanceof Error ? e.message : String(e));
      } finally {
        setIngesting(false);
      }
    },
    [ingesting]
  );

  // Kick off a one-shot "missing prices" ingest the first time we resolve a
  // universe. The dashboard auto-polls below so values appear as bars land.
  useEffect(() => {
    if (!resolvedUniverseId) return;
    if (ingestStartedFor.current === resolvedUniverseId) return;
    ingestStartedFor.current = resolvedUniverseId;
    void triggerIngest(resolvedUniverseId, "missing");
  }, [resolvedUniverseId, triggerIngest]);

  // Auto-refresh the chart on a fixed cadence regardless of ingest state so
  // the user never has to press a button to see the latest data.
  useEffect(() => {
    if (!resolvedUniverseId) return;
    const t = setInterval(() => {
      setReloadToken((n) => n + 1);
    }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [resolvedUniverseId]);

  const marketStatus = useMemo(() => getUsMarketStatus(new Date(now)), [now]);
  const refreshLabel = useMemo(
    () => formatAgo(lastRefreshedAt, now),
    [lastRefreshedAt, now]
  );

  const onForceRefresh = useCallback(() => {
    if (!resolvedUniverseId || ingesting) return;
    void triggerIngest(resolvedUniverseId, "all");
  }, [resolvedUniverseId, ingesting, triggerIngest]);

  const onDataLoaded = useCallback(() => {
    setLastRefreshedAt(Date.now());
  }, []);

  const onApplied = useCallback(() => {
    if (resolvedUniverseId) {
      // After Apply, the modal already kicked off ingest; just nudge chart.
      ingestStartedFor.current = resolvedUniverseId;
    }
    setReloadToken((n) => n + 1);
  }, [resolvedUniverseId]);

  return (
    <div style={page}>
      <div style={topBar}>
        <h1 style={pageTitle}>Performance</h1>
        <div style={topRight}>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={btnPrimary}
          >
            Manage Tickers
          </button>
          <span style={dot(marketStatus.color)} aria-hidden="true" />
          <span style={statusText}>{marketStatus.label}</span>
          <span style={separator} aria-hidden="true">
            ·
          </span>
          <span style={statusText}>
            {ingesting ? "Updating prices…" : `Auto · ${refreshLabel}`}
          </span>
          <button
            type="button"
            onClick={onForceRefresh}
            style={btnGhost}
            disabled={!resolvedUniverseId || ingesting}
            title="Force a full price refresh now"
          >
            ↻
          </button>
        </div>
      </div>

      {resolveErr && (
        <p style={{ padding: "0 1.5rem", color: "#ff8d8d" }} role="alert">
          {resolveErr}
        </p>
      )}
      {ingestErr && (
        <p style={{ padding: "0 1.5rem", color: "#d5a64a", fontSize: "0.88rem" }}>
          {ingestErr}
        </p>
      )}

      <div style={content}>
        {resolvedUniverseId ? (
          <MarketMapClient
            key={resolvedUniverseId}
            universeId={resolvedUniverseId}
            reloadToken={reloadToken}
            onLoaded={onDataLoaded}
          />
        ) : !resolveErr ? (
          <p style={{ color: "#8c99a8" }}>Loading universe…</p>
        ) : null}
      </div>

      <ManageTickersModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onApplied={() => {
          onApplied();
          router.refresh();
        }}
      />
    </div>
  );
}

type MarketStatus = { label: string; color: string };

/**
 * Very simple US equity session heuristic (9:30–16:00 ET, Mon–Fri). Does not
 * account for holidays; intended as a lightweight top-bar indicator only.
 */
function getUsMarketStatus(now: Date): MarketStatus {
  const etFormatter = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  });
  const parts = etFormatter.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  const minutesInDay = hour * 60 + minute;
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (isWeekday && minutesInDay >= open && minutesInDay < close) {
    return { label: "Open", color: "#3acf6b" };
  }
  return { label: "Closed", color: "#6a7582" };
}

function formatAgo(at: number | null, now: number): string {
  if (at == null) return "—";
  const diff = Math.max(0, now - at);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ago`;
}

const page: CSSProperties = {
  background: "#0b1018",
  color: "#e6ebf2",
  margin: -24,        // cancel the analysis layout's 24px padding so the map fills edge-to-edge
};

const topBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "0.9rem 1.5rem",
  borderBottom: "1px solid #1e2636",
  background: "#0f141d",
  flexWrap: "wrap",
  gap: "0.75rem",
};

const pageTitle: CSSProperties = {
  margin: 0,
  fontSize: "1.05rem",
  fontWeight: 600,
  color: "#f2f5f9",
  letterSpacing: "0.01em",
};

const topRight: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
};

const dot = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: 999,
  background: color,
  display: "inline-block",
});

const statusText: CSSProperties = {
  color: "#8c99a8",
  fontSize: "0.85rem",
};

const separator: CSSProperties = {
  color: "#3a4558",
  fontSize: "0.85rem",
};

const content: CSSProperties = {
  padding: "1rem 1.5rem 2rem",
};

const btnBase: CSSProperties = {
  padding: "0.4rem 0.85rem",
  borderRadius: 6,
  border: "1px solid transparent",
  fontSize: "0.88rem",
  fontWeight: 500,
  cursor: "pointer",
};

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: "#3a6ae4",
  color: "#fff",
  borderColor: "#3a6ae4",
};

const btnGhost: CSSProperties = {
  ...btnBase,
  background: "transparent",
  color: "#c7d0dc",
  borderColor: "#384454",
  padding: "0.35rem 0.55rem",
};
