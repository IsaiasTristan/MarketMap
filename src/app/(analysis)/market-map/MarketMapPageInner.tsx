"use client";

import type { CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { MarketMapClient, type MarketMapLoadedInfo } from "@/components/MarketMapClient";
import { ManageTickersModal } from "@/components/ManageTickersModal";
import { useIsAdmin } from "@/lib/api/useMe";

const AUTO_REFRESH_MS = 30_000;
/** While the US equity session is open we tail-refresh Yahoo prices on this
 *  cadence so the grid reflects today's intraday move. Outside market hours we
 *  fall back to the regular AUTO_REFRESH_MS DB poll only — no Yahoo traffic. */
const LIVE_REFRESH_MS = 60_000;
/** Abort hanging Prisma/DB connects so the UI does not sit on "Loading universe…" forever. */
const UNIVERSE_DEFAULT_FETCH_MS = 20_000;

export function MarketMapPageInner() {
  const sp = useSearchParams();
  const router = useRouter();
  const isAdmin = useIsAdmin();
  const universeIdParam = sp.get("universeId");

  const [resolvedUniverseId, setResolvedUniverseId] = useState<string | null>(
    universeIdParam
  );
  const [resolveErr, setResolveErr] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [dataAsOf, setDataAsOf] = useState<string | null>(null);
  const [staleTickerCount, setStaleTickerCount] = useState(0);
  const [activeTickerCount, setActiveTickerCount] = useState(0);
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
        const res = await fetch("/api/universe/default", {
          cache: "no-store",
          signal: AbortSignal.timeout(UNIVERSE_DEFAULT_FETCH_MS),
        });
        const j = (await res.json()) as { id?: string; error?: string };
        if (cancelled) return;
        if (!res.ok || !j.id) {
          setResolveErr(
            j.error ??
              "Failed to load universe. Is PostgreSQL running and DATABASE_URL set in .env?"
          );
          return;
        }
        setResolvedUniverseId(j.id);
      } catch (e) {
        if (cancelled) return;
        if (e instanceof Error && e.name === "TimeoutError") {
          setResolveErr(
            `Timed out after ${UNIVERSE_DEFAULT_FETCH_MS / 1000}s loading the default universe. Start PostgreSQL, set DATABASE_URL in .env, then run: npx prisma db push`
          );
          return;
        }
        if (e instanceof Error && e.name === "AbortError") {
          setResolveErr(
            "Request was cancelled or timed out. Check PostgreSQL and DATABASE_URL, then refresh."
          );
          return;
        }
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
    async (
      universeId: string,
      modes: ("missing" | "tail" | "all")[]
    ) => {
      if (ingesting) return;
      setIngesting(true);
      setIngestErr(null);
      const notes: string[] = [];
      try {
        for (const mode of modes) {
          const qs = `?mode=${mode}`;
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

          if (universeRes.status === "fulfilled") {
            const j = (await universeRes.value
              .json()
              .catch(() => null)) as
              | {
                  ok?: boolean;
                  tickers?: number;
                  failed?: { ticker: string }[];
                  autoDeactivated?: string[];
                }
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
            if (j?.autoDeactivated?.length) {
              const sample = j.autoDeactivated.slice(0, 5).join(", ");
              notes.push(
                `Auto-removed ${j.autoDeactivated.length} delisted/acquired ticker(s): ${sample}${
                  j.autoDeactivated.length > 5 ? ", …" : ""
                }. Review in Data tab → Securities Health.`
              );
            }
          } else {
            notes.push(`Universe ${mode} refresh request failed.`);
          }
          if (benchRes.status === "rejected") {
            notes.push(`Benchmark ${mode} refresh request failed.`);
          }
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

  // First time we resolve a universe: seed any missing tickers (no-op once
  // seeded) and then tail-refresh the last ~10 sessions for everything so the
  // grid is current. Without the tail step, an already-seeded universe would
  // show stale "1D" returns from whatever day it was last manually refreshed.
  useEffect(() => {
    // Price ingestion is an admin-only, single-instance job. Non-admins read
    // the shared, already-refreshed data; they never trigger Yahoo traffic.
    if (!isAdmin) return;
    if (!resolvedUniverseId) return;
    if (ingestStartedFor.current === resolvedUniverseId) return;
    ingestStartedFor.current = resolvedUniverseId;
    void triggerIngest(resolvedUniverseId, ["missing", "tail"]);
  }, [resolvedUniverseId, isAdmin, triggerIngest]);

  // Auto-refresh the chart on a fixed cadence while the tab is visible so
  // backgrounded windows do not hammer Postgres / Next RSC.
  useEffect(() => {
    if (!resolvedUniverseId) return;
    const bump = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      setReloadToken((n) => n + 1);
    };
    const t = setInterval(bump, AUTO_REFRESH_MS);
    const onVis = () => {
      if (document.visibilityState === "visible") {
        bump();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [resolvedUniverseId]);

  // Live tail-refresh during US market hours: every LIVE_REFRESH_MS pull
  // today's partial-day bar from Yahoo so the 1D return reflects the
  // intraday move. The chart auto-poll above will then surface the new
  // values. Outside market hours this is a no-op — daily data doesn't move.
  const triggerIngestRef = useRef(triggerIngest);
  useEffect(() => {
    triggerIngestRef.current = triggerIngest;
  }, [triggerIngest]);
  const ingestingRef = useRef(ingesting);
  useEffect(() => {
    ingestingRef.current = ingesting;
  }, [ingesting]);

  useEffect(() => {
    // Live intraday tail-refresh is admin-only (see note above).
    if (!isAdmin) return;
    if (!resolvedUniverseId) return;
    const tick = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      const status = getUsMarketStatus(new Date());
      if (status.label !== "Open") return;
      if (ingestingRef.current) return;
      void triggerIngestRef.current(resolvedUniverseId, ["tail"]);
    };
    const t = setInterval(tick, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [resolvedUniverseId, isAdmin]);

  const marketStatus = useMemo(() => getUsMarketStatus(new Date(now)), [now]);
  const refreshLabel = useMemo(
    () => formatAgo(lastRefreshedAt, now),
    [lastRefreshedAt, now]
  );

  const onForceRefresh = useCallback(() => {
    if (!resolvedUniverseId || ingesting) return;
    void triggerIngest(resolvedUniverseId, ["all"]);
  }, [resolvedUniverseId, ingesting, triggerIngest]);

  const onDataLoaded = useCallback((info: MarketMapLoadedInfo) => {
    setLastRefreshedAt(Date.now());
    setDataAsOf(info.asOf);
    setStaleTickerCount(info.staleTickerCount);
    setActiveTickerCount(info.activeTickerCount);
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
          {isAdmin && (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              style={btnPrimary}
            >
              Manage Tickers
            </button>
          )}
          <span style={dot(marketStatus.color)} aria-hidden="true" />
          <span style={statusText}>{marketStatus.label}</span>
          {marketStatus.label === "Open" && (
            <span
              style={liveBadge}
              title={`Live tail-refresh every ${LIVE_REFRESH_MS / 1000}s during market hours`}
            >
              LIVE
            </span>
          )}
          <span style={separator} aria-hidden="true">
            ·
          </span>
          <span style={statusText}>
            {ingesting ? "Updating prices…" : `Auto · ${refreshLabel}`}
          </span>
          {dataAsOf && (
            <>
              <span style={separator} aria-hidden="true">
                ·
              </span>
              <span
                style={{
                  ...statusText,
                  color:
                    staleTickerCount > 0
                      ? "var(--color-negative)"
                      : statusText.color,
                }}
                title={
                  staleTickerCount > 0
                    ? `${staleTickerCount} of ${activeTickerCount} tickers have not refreshed (likely delisted / acquired). Click ↻ to force a full refresh; the next ingest will auto-deactivate any ticker still > 21d behind.`
                    : "Most recent trading-date represented in the grid."
                }
              >
                Bars through {dataAsOf}
                {staleTickerCount > 0
                  ? ` (${staleTickerCount} of ${activeTickerCount} tickers stale)`
                  : ""}
              </span>
            </>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={onForceRefresh}
              style={btnGhost}
              disabled={!resolvedUniverseId || ingesting}
              title="Force a full price refresh now"
            >
              ↻ Refresh
            </button>
          )}
        </div>
      </div>

      {resolveErr && (
        <p style={{ padding: "0 8px", color: "var(--color-negative)" }} role="alert">
          {resolveErr}
        </p>
      )}
      {ingestErr && (
        <p style={{ padding: "0 8px", color: "var(--color-warning)", fontSize: "11px" }}>
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
          <p style={{ color: "var(--text-secondary)" }}>Loading universe…</p>
        ) : null}
      </div>

      {isAdmin && (
        <ManageTickersModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onApplied={() => {
            onApplied();
            router.refresh();
          }}
        />
      )}
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
    return { label: "Open", color: "var(--color-positive)" };
  }
  return { label: "Closed", color: "var(--text-secondary)" };
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
  background: "var(--bg-base)",
  color: "var(--text-primary)",
};

const topBar: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "4px 8px",
  borderBottom: "1px solid var(--bg-border)",
  background: "var(--bg-surface)",
  flexWrap: "wrap",
  gap: "6px",
  lineHeight: 1.25,
};

const pageTitle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  fontWeight: 700,
  color: "var(--text-primary)",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  lineHeight: 1.25,
};

const topRight: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const dot = (color: string): CSSProperties => ({
  width: 8,
  height: 8,
  borderRadius: 999,
  background: color,
  display: "inline-block",
});

const statusText: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "11px",
  lineHeight: 1.25,
};

const separator: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "11px",
};

const liveBadge: CSSProperties = {
  display: "inline-block",
  padding: "0 4px",
  marginLeft: "2px",
  border: "1px solid var(--color-positive)",
  color: "var(--color-positive)",
  fontSize: "9px",
  fontWeight: 700,
  letterSpacing: "0.08em",
  lineHeight: "12px",
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const content: CSSProperties = {
  padding: "6px 8px",
};

const btnBase: CSSProperties = {
  padding: "1px 8px",
  borderRadius: 0,
  border: "1px solid transparent",
  fontSize: "11px",
  fontWeight: 600,
  cursor: "pointer",
  lineHeight: 1.25,
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const btnPrimary: CSSProperties = {
  ...btnBase,
  background: "var(--bg-base)",
  color: "var(--color-accent)",
  borderColor: "var(--chrome-border)",
};

const btnGhost: CSSProperties = {
  ...btnBase,
  background: "var(--bg-base)",
  color: "var(--text-secondary)",
  borderColor: "var(--chrome-border)",
  padding: "1px 6px",
};
