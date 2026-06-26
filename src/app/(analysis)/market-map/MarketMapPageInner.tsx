"use client";

import type { CSSProperties } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MarketMapClient,
  type MarketMapLoadedInfo,
  type StaleTickerInfo,
} from "@/components/MarketMapClient";
import { ManageTickersModal } from "@/components/ManageTickersModal";
import { TickerSearchCombobox } from "@/components/analysis/shared/TickerSearchCombobox";
import { useAnalysisStore } from "@/store/analysis";
import { useIsAdmin } from "@/lib/api/useMe";
import {
  getUsMarketSession,
  type MarketSession,
} from "@/lib/market-map/market-session";

const AUTO_REFRESH_MS = 30_000;
/** Off-hours the daily grid is static, so the visible-tab DB poll relaxes from
 *  AUTO_REFRESH_MS to this slower cadence to cut needless re-fetches. */
const AUTO_REFRESH_OFFHOURS_MS = 60_000;
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
  const openFactorDetailPanel = useAnalysisStore((s) => s.openFactorDetailPanel);
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
  const [staleTickers, setStaleTickers] = useState<StaleTickerInfo[]>([]);
  const [staleHover, setStaleHover] = useState(false);
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

  // Auto-refresh the chart while the tab is visible so backgrounded windows do
  // not hammer Postgres / Next RSC. Tight 30s cadence during the REGULAR US
  // session; relax to 60s outside market hours (daily data is static then).
  // Self-scheduling setTimeout so the cadence re-evaluates the session on each
  // tick rather than being frozen at mount.
  useEffect(() => {
    if (!resolvedUniverseId) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    const bump = () => {
      if (typeof document !== "undefined" && document.visibilityState !== "visible") {
        return;
      }
      setReloadToken((n) => n + 1);
    };
    const schedule = () => {
      if (cancelled) return;
      const delay =
        getUsMarketSession(new Date()) === "REGULAR"
          ? AUTO_REFRESH_MS
          : AUTO_REFRESH_OFFHOURS_MS;
      timer = setTimeout(() => {
        bump();
        schedule();
      }, delay);
    };
    schedule();
    const onVis = () => {
      if (document.visibilityState === "visible") {
        bump();
      }
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
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
      const session = getUsMarketSession(new Date());
      if (session !== "REGULAR") return;
      if (ingestingRef.current) return;
      void triggerIngestRef.current(resolvedUniverseId, ["tail"]);
    };
    const t = setInterval(tick, LIVE_REFRESH_MS);
    return () => clearInterval(t);
  }, [resolvedUniverseId, isAdmin]);

  const session = useMemo<MarketSession>(
    () => getUsMarketSession(new Date(now)),
    [now]
  );
  const marketStatus = useMemo(() => describeSession(session), [session]);
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
    setStaleTickers(info.staleTickers);
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
        <h1 style={pageTitle}>Stock Price Performance</h1>
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
          <span style={{ ...statusText, color: marketStatus.color, fontWeight: marketStatus.bold ? 600 : undefined }}>
            {marketStatus.label}
          </span>
          {session === "REGULAR" && (
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
                style={statusText}
                title="Most recent trading-date represented in the grid."
              >
                Bars through {dataAsOf}
              </span>
              {staleTickerCount > 0 && (
                <span
                  style={stalePopoverAnchor}
                  onMouseEnter={() => setStaleHover(true)}
                  onMouseLeave={() => setStaleHover(false)}
                >
                  <span
                    role="img"
                    aria-label={`${staleTickerCount} of ${activeTickerCount} tickers have stale price data`}
                    tabIndex={0}
                    onFocus={() => setStaleHover(true)}
                    onBlur={() => setStaleHover(false)}
                    style={staleTriangle}
                  >
                    ▲
                  </span>
                  {staleHover && (
                    <div role="tooltip" style={stalePopover}>
                      <div style={stalePopoverTitle}>
                        Stale price data — {staleTickerCount} of{" "}
                        {activeTickerCount} tickers
                      </div>
                      <div style={stalePopoverBody}>
                        These tickers have not refreshed to the latest bar (
                        {dataAsOf}); likely delisted / acquired or a failed
                        fetch. Next ingest auto-removes any still &gt; 21d behind.
                      </div>
                      <ul style={staleList}>
                        {staleTickers.slice(0, 12).map((t) => (
                          <li key={t.ticker} style={staleListItem}>
                            <span style={staleListTicker}>{t.ticker}</span>
                            <span style={staleListMeta}>
                              last {t.lastDate} · {t.daysBehind}d behind
                            </span>
                          </li>
                        ))}
                      </ul>
                      {staleTickers.length > 12 && (
                        <div style={staleMore}>
                          +{staleTickers.length - 12} more
                        </div>
                      )}
                    </div>
                  )}
                </span>
              )}
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
          <TickerSearchCombobox
            variant="bbg"
            width={200}
            onSelect={(ticker) => openFactorDetailPanel(ticker)}
          />
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
            session={session}
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

type MarketStatusPresentation = { label: string; color: string; bold: boolean };

/**
 * Presentation map for the four-state {@link MarketSession}. The session
 * machine itself is a pure clock heuristic in
 * `@/lib/market-map/market-session`; this function picks the user-facing
 * label and colour for the top-bar chip.
 *
 * Colours:
 *   - REGULAR (Live)        light green via `--color-positive` (#00c800)
 *   - PRE    (Pre-market)   orange via `--color-accent` (#fa8000)
 *   - POST   (After-hours)  dark red literal (#8b1f1f)
 *   - CLOSED                muted secondary text
 */
function describeSession(session: MarketSession): MarketStatusPresentation {
  switch (session) {
    case "REGULAR":
      return { label: "Live", color: "var(--color-positive)", bold: true };
    case "PRE":
      return { label: "Pre-market", color: "var(--color-accent)", bold: true };
    case "POST":
      return { label: "After-hours", color: "#8b1f1f", bold: true };
    case "CLOSED":
    default:
      return { label: "Closed", color: "var(--text-secondary)", bold: false };
  }
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

const stalePopoverAnchor: CSSProperties = {
  position: "relative",
  display: "inline-flex",
  alignItems: "center",
};

const staleTriangle: CSSProperties = {
  color: "var(--color-negative)",
  fontSize: "11px",
  lineHeight: 1,
  cursor: "help",
  outline: "none",
};

const stalePopover: CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 50,
  width: "280px",
  padding: "8px 10px",
  background: "var(--bg-surface)",
  border: "1px solid var(--color-negative)",
  borderRadius: 0,
  boxShadow: "0 4px 16px rgba(0, 0, 0, 0.45)",
  textAlign: "left",
  cursor: "default",
};

const stalePopoverTitle: CSSProperties = {
  color: "var(--color-negative)",
  fontSize: "11px",
  fontWeight: 700,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  marginBottom: "4px",
};

const stalePopoverBody: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "11px",
  lineHeight: 1.4,
  marginBottom: "6px",
};

const staleList: CSSProperties = {
  listStyle: "none",
  margin: 0,
  padding: 0,
  maxHeight: "200px",
  overflowY: "auto",
  display: "flex",
  flexDirection: "column",
  gap: "2px",
};

const staleListItem: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: "8px",
  fontSize: "11px",
  lineHeight: 1.3,
};

const staleListTicker: CSSProperties = {
  color: "var(--text-primary)",
  fontWeight: 600,
  fontFamily:
    'var(--font-mono), "Andale Mono", "Consolas", "Liberation Mono", "Courier New", monospace',
};

const staleListMeta: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "10px",
  whiteSpace: "nowrap",
};

const staleMore: CSSProperties = {
  color: "var(--text-secondary)",
  fontSize: "10px",
  marginTop: "4px",
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
