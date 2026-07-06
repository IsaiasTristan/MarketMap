"use client";
/**
 * SIGNAL BRIEF — the Overview tab's portfolio-lens section: what the analysis
 * engines think about the current book. Three modules over one composed read
 * (/api/analysis/portfolio/signal-brief): the REVISIONS × 13F FLOWS scatter,
 * the 21-day earnings timeline, and the severity-ranked WHAT CHANGED feed.
 * Leads with the honesty stamps (revision snapshot date + accruing state, 13F
 * quarter + lag caveat, styled after the Flows AsOfBanner). Renders its own
 * loading/empty states and never blocks the rest of the Overview.
 */
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ChartCard } from "@/components/analysis/ui/ChartCard";
import { Muted } from "@/components/analysis/ui/PanelState";
import { quarterLabel } from "@/components/analysis/flows/flowsUi";
import type { SignalBriefPayload } from "@/server/services/signal-brief.service";
import { RevisionsFlowScatter } from "./RevisionsFlowScatter";
import { EarningsTimeline } from "./EarningsTimeline";
import { WhatChangedFeed } from "./WhatChangedFeed";
import { SignalMetricTip } from "./SignalMetricTip";

/** "Q1 2026" → "Q1'26" for compact axis stamps. */
function shortQuarter(period: string | null): string | null {
  if (!period) return null;
  const q = quarterLabel(period);
  return q.replace(/ 20(\d\d)$/, "'$1");
}

export function SignalBriefSection({ portfolioId }: { portfolioId: string }) {
  const router = useRouter();
  const { data, isLoading, error } = useQuery<SignalBriefPayload | null>({
    queryKey: ["signal-brief", portfolioId],
    queryFn: async () => {
      const r = await fetch(`/api/analysis/portfolio/signal-brief?portfolioId=${portfolioId}`);
      if (!r.ok) {
        if (r.status === 404) return null; // NO_DATA → quiet empty, not an error
        const body = await r.json().catch(() => ({}));
        throw new Error(typeof body.error === "string" ? body.error : `HTTP ${r.status}`);
      }
      return r.json();
    },
    enabled: !!portfolioId,
    staleTime: 5 * 60_000,
  });

  if (isLoading) return <Muted>Loading signal brief…</Muted>;
  if (error)
    return <Muted tone="negative">{error instanceof Error ? error.message : "Failed to load signal brief."}</Muted>;
  if (!data) return null; // empty book — the section simply doesn't render

  const ew = data.asOf.effectiveWindow;
  const gapSuffix =
    ew && ew.legAWeeks < ew.composite4wWindow
      ? ` (uses ${Math.min(ew.legAWeeks, ew.composite4wWindow)}w of ${ew.composite4wWindow}w)`
      : "";
  const flowQ = shortQuarter(data.asOf.flowPeriod);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* As-of / honesty stamps — mirrors the Flows AsOfBanner styling. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          flexWrap: "wrap",
          background: "var(--bb-chrome)",
          color: "#fff",
          padding: "3px 10px",
          fontSize: 10,
          letterSpacing: "0.04em",
        }}
      >
        <span style={{ fontWeight: 700 }}>SIGNALS ON THE BOOK</span>
        <span style={{ opacity: 0.85 }}>
          REVISIONS snapshot {data.asOf.revisionSnapshotDate ?? "— accruing"}
          {gapSuffix}
        </span>
        <span style={{ opacity: 0.85 }}>
          · 13F FLOWS {data.asOf.flowPeriod ? `${quarterLabel(data.asOf.flowPeriod)} (period-end ${data.asOf.flowPeriod})` : "— no coverage yet"}
        </span>
        <span style={{ opacity: 0.7 }}>
          · <SignalMetricTip id="flowLag">lags ~45d — not live flow</SignalMetricTip>
        </span>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "3fr 2fr", gap: 12, alignItems: "stretch" }}>
        <ChartCard title="Holdings — Revisions × 13F Flows" compact fillHeight>
          <RevisionsFlowScatter
            points={data.scatter.points}
            noCoverage={data.scatter.noCoverage}
            flowQuarterLabel={flowQ}
            gapSuffix={gapSuffix}
          />
        </ChartCard>
        <ChartCard
          title="What Changed"
          compact
          fillHeight
          action={
            <button
              type="button"
              onClick={() => router.push("/research?tab=summary")}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--color-accent)",
                fontSize: 9,
                fontWeight: 700,
                letterSpacing: 0.5,
                cursor: "pointer",
                padding: 0,
              }}
            >
              ALL →
            </button>
          }
        >
          <WhatChangedFeed rows={data.feed.rows} sinceDate={data.feed.sinceDate} />
        </ChartCard>
      </div>

      <ChartCard
        title="Earnings — Next 3 Weeks"
        compact
        action={
          <button
            type="button"
            onClick={() => router.push("/research?tab=calendar")}
            style={{
              background: "transparent",
              border: "none",
              color: "var(--color-accent)",
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: 0.5,
              cursor: "pointer",
              padding: 0,
            }}
          >
            CALENDAR →
          </button>
        }
      >
        <EarningsTimeline
          items={data.earnings.items}
          windowDays={data.earnings.windowDays}
          noDate={data.earnings.noDate}
        />
      </ChartCard>
    </div>
  );
}
