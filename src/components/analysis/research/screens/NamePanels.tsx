"use client";
/**
 * Screen 3 — the supporting panels: where this name sits among its peers, how
 * much of its score is the industry tide versus the company itself, what the
 * other three engines independently say, the four small multiples, and the
 * event log the score is built from.
 */
import { Sparkline, Tag, engineTagTone, signColor } from "../primitives";
import { MetricTip } from "../MetricTip";
import { fmtPctOrNm } from "@/lib/revision/screen-format";
import type { NameEvent, NamePayload } from "@/server/services/revision/revision-name.service";

// ── Peer strip ───────────────────────────────────────────────────────────────

const STRIP_W = 300;
const STRIP_SPAN = 3;

export function PeerStrip({
  peers,
  ticker,
  own,
  subsector,
}: {
  peers: Array<{ ticker: string; ptRevOrthZ: number }>;
  ticker: string;
  own: number | null;
  subsector: string;
}) {
  const x = (z: number) => ((Math.max(-STRIP_SPAN, Math.min(STRIP_SPAN, z)) + STRIP_SPAN) / (2 * STRIP_SPAN)) * STRIP_W;
  return (
    <div>
      <svg viewBox={`0 0 ${STRIP_W} 34`} width="100%" height={34} style={{ display: "block" }}>
        <line x1={0} y1={20} x2={STRIP_W} y2={20} stroke="#2a2a2e" />
        <line x1={x(0)} y1={8} x2={x(0)} y2={26} stroke="#3a3a40" />
        {peers
          .filter((p) => p.ticker !== ticker)
          .map((p) => (
            <circle key={p.ticker} cx={x(p.ptRevOrthZ)} cy={20} r={2} fill="#6b6b70" opacity={0.75} />
          ))}
        {own !== null && (
          <>
            <circle cx={x(own)} cy={20} r={3.4} fill="var(--color-positive)" />
            <text
              x={Math.max(16, Math.min(STRIP_W - 16, x(own)))}
              y={12}
              textAnchor="middle"
              fontSize={9}
              fill="var(--color-positive)"
              fontWeight={700}
            >
              {own >= 0 ? "+" : ""}
              {own.toFixed(2)}
            </text>
          </>
        )}
        <text x={0} y={33} fontSize={8} fill="#6b6b70">
          −3
        </text>
        <text x={STRIP_W} y={33} textAnchor="end" fontSize={8} fill="#6b6b70">
          +3
        </text>
      </svg>
      <div style={{ fontSize: 9, color: "var(--text-muted)" }}>
        {peers.length} names in {subsector}. Each gray dot is one peer&apos;s score this week.
      </div>
    </div>
  );
}

// ── Group vs idiosyncratic ───────────────────────────────────────────────────

export function GroupIdioBars({ grpZ, idioZ, subsector }: { grpZ: number | null; idioZ: number | null; subsector: string }) {
  const span = 2.5;
  const width = 100;
  const half = width / 2;
  const bar = (v: number | null, color: string) => {
    const len = v === null || !Number.isFinite(v) ? 0 : Math.min(half, (Math.abs(v) / span) * half);
    const neg = (v ?? 0) < 0;
    return (
      <span style={{ position: "relative", display: "inline-block", width, height: 8, background: "var(--bg-base)" }}>
        <span style={{ position: "absolute", left: half, top: 0, bottom: 0, width: 1, background: "var(--chrome-border)" }} />
        <span
          style={{
            position: "absolute",
            top: 2,
            height: 4,
            width: len,
            background: color,
            [neg ? "right" : "left"]: half,
          }}
        />
      </span>
    );
  };

  const sentence = (() => {
    if (grpZ === null && idioZ === null) return "No decomposition this week.";
    const g = grpZ ?? 0;
    const i = idioZ ?? 0;
    if (Math.abs(i) > Math.abs(g) * 1.5) {
      return `Mostly this company: the move is specific to it, not to ${subsector}.`;
    }
    if (Math.abs(g) > Math.abs(i) * 1.5) {
      return `Mostly the industry: ${subsector} is being revised as a group — hedge or look for the laggard.`;
    }
    return `Industry and company push together — about half the score is the ${subsector} tide.`;
  })();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 88, color: "var(--text-muted)", fontSize: 9, textTransform: "uppercase" }}>
          <MetricTip id="groupZ">Industry tide</MetricTip>
        </span>
        {bar(grpZ, "#8a8a8a")}
        <span className="bb-num" style={{ color: signColor(grpZ) }}>
          {grpZ === null ? "—" : `${grpZ >= 0 ? "+" : ""}${grpZ.toFixed(2)}`}
        </span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 88, color: "var(--text-muted)", fontSize: 9, textTransform: "uppercase" }}>
          <MetricTip id="idioZ">Company-specific</MetricTip>
        </span>
        {bar(idioZ, "var(--color-accent)")}
        <span className="bb-num" style={{ color: signColor(idioZ) }}>
          {idioZ === null ? "—" : `${idioZ >= 0 ? "+" : ""}${idioZ.toFixed(2)}`}
        </span>
      </div>
      <div style={{ fontSize: 9, color: "var(--text-secondary)" }}>{sentence}</div>
    </div>
  );
}

// ── Engine tiles ─────────────────────────────────────────────────────────────

/** What each engine's tag asserts, in one line. Never blended into the rank. */
const TAG_MEANING: Record<string, string> = {
  INFLECT: "Top of its peer group on the fundamental inflection screen.",
  QUAL: "Flagged a compounder — durable returns on capital.",
  TRAP: "Accrual / cash-conversion trap flag: earnings are not converting to cash.",
  ACCUM: "Institutions were net buyers in the latest 13F period.",
  DISTRIB: "Institutions were net sellers in the latest 13F period.",
  CROWDED: "Crowded holding — a flow unwind would hurt.",
  "MOM+": "Most of its risk is momentum factor exposure, not stock-specific.",
  VAL: "Most of its risk is the value factor.",
  QUAL_F: "Most of its risk is the quality factor.",
};

const ENGINES = [
  { key: "e2", label: "E2 · Business inflecting?", field: "e2Tag" as const },
  { key: "e3", label: "E3 · Funds buying?", field: "e3Tag" as const },
  { key: "e4", label: "E4 · Factor driven?", field: "e4Tag" as const },
];

export function EngineTiles({ row }: { row: NamePayload["row"] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 1, background: "var(--chrome-border)" }}>
      {ENGINES.map((e) => {
        const tag = row?.[e.field] ?? null;
        return (
          <div key={e.key} style={{ background: "var(--bg-surface)", padding: "5px 7px", minHeight: 62 }}>
            <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
              <MetricTip id="engineTags">{e.label}</MetricTip>
            </div>
            <div style={{ marginTop: 3 }}>
              {tag ? <Tag label={tag} tone={engineTagTone(tag)} /> : <span style={{ fontSize: 9, color: "var(--text-muted)" }}>no read</span>}
            </div>
            <div style={{ fontSize: 9, color: "var(--text-secondary)", marginTop: 3, lineHeight: 1.3 }}>
              {tag ? (TAG_MEANING[tag] ?? "") : "This engine has nothing on the name this period."}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Small multiples ──────────────────────────────────────────────────────────

const SM_W = 320;
const SM_H = 90;

function MiniChart({
  title,
  weeks,
  series,
  bars,
  format,
}: {
  title: string;
  weeks: string[];
  series?: Array<{ values: Array<number | null>; color: string; dashed?: boolean; label: string }>;
  bars?: Array<{ up: number[]; down: number[] }>;
  format?: (v: number) => string;
}) {
  const all = [
    ...(series?.flatMap((s) => s.values.filter((v): v is number => v !== null && Number.isFinite(v))) ?? []),
    ...(bars?.flatMap((b) => [...b.up, ...b.down.map((d) => -d)]) ?? []),
  ];
  const lo = all.length ? Math.min(...all, bars ? 0 : Math.min(...all)) : 0;
  const hi = all.length ? Math.max(...all, 0) : 1;
  const pad = (hi - lo) * 0.12 || 1;
  const y = (v: number) => 16 + (1 - (v - (lo - pad)) / (hi + pad - (lo - pad))) * (SM_H - 26);
  const x = (i: number) => 4 + (weeks.length <= 1 ? 0 : (i / (weeks.length - 1)) * (SM_W - 40));

  return (
    <div style={{ background: "var(--bg-surface)", border: "1px solid var(--chrome-border)" }}>
      <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase", padding: "3px 6px" }}>
        {title}
      </div>
      <svg viewBox={`0 0 ${SM_W} ${SM_H}`} width="100%" height={SM_H} style={{ display: "block" }}>
        {lo < 0 && hi > 0 && <line x1={4} y1={y(0)} x2={SM_W - 36} y2={y(0)} stroke="#2a2a2e" />}
        {series?.map((s) => {
          const pts = s.values
            .map((v, i) => (v === null || !Number.isFinite(v) ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`))
            .filter((p): p is string => p !== null);
          if (pts.length < 2) return null;
          const last = [...s.values].reverse().find((v) => v !== null) ?? null;
          return (
            <g key={s.label}>
              <polyline
                fill="none"
                stroke={s.color}
                strokeWidth={1.3}
                strokeDasharray={s.dashed ? "3 3" : undefined}
                points={pts.join(" ")}
              />
              {last !== null && (
                <text x={SM_W - 33} y={y(last) + 3} fontSize={8} fill={s.color}>
                  {format ? format(last) : last.toFixed(2)}
                </text>
              )}
            </g>
          );
        })}
        {bars?.map((b, bi) => (
          <g key={bi}>
            {b.up.map((v, i) =>
              v === 0 ? null : (
                <rect key={`u${i}`} x={x(i) - 3} y={y(v)} width={6} height={Math.max(1, y(0) - y(v))} fill="var(--color-positive)" />
              ),
            )}
            {b.down.map((v, i) =>
              v === 0 ? null : (
                <rect key={`d${i}`} x={x(i) - 3} y={y(0)} width={6} height={Math.max(1, y(-v) - y(0))} fill="var(--color-negative)" />
              ),
            )}
          </g>
        ))}
      </svg>
      {series && (
        <div style={{ display: "flex", gap: 10, padding: "0 6px 3px", fontSize: 8, color: "var(--text-muted)" }}>
          {series.map((s) => (
            <span key={s.label} style={{ color: s.color }}>
              {s.dashed ? "– – " : "—— "}
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function SmallMultiples({ sm }: { sm: NamePayload["smallMultiples"] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 6 }}>
      <MiniChart
        title="Consensus EPS — this year vs next"
        weeks={sm.weeks}
        series={[
          { values: sm.epsFy1, color: "#e8a33d", label: "this yr" },
          { values: sm.epsFy2, color: "#e8a33d", dashed: true, label: "next yr" },
        ]}
      />
      <MiniChart
        title="Consensus revenue — this year vs next"
        weeks={sm.weeks}
        series={[
          { values: sm.revFy1, color: "#5aa0ff", label: "this yr" },
          { values: sm.revFy2, color: "#5aa0ff", dashed: true, label: "next yr" },
        ]}
        format={(v) => `${(v / 1e9).toFixed(1)}B`}
      />
      <MiniChart title="Target raises (up) and cuts (down), per week" weeks={sm.weeks} bars={[{ up: sm.ptUp, down: sm.ptDown }]} />
      <MiniChart
        title="Stock return minus its industry, 13 weeks"
        weeks={sm.weeks}
        series={[{ values: sm.relReturn, color: "#e8e8ea", label: "vs industry" }]}
        format={(v) => `${(v * 100).toFixed(1)}%`}
      />
    </div>
  );
}

// ── Event log ────────────────────────────────────────────────────────────────

const th: React.CSSProperties = {
  textAlign: "left",
  padding: "3px 6px",
  fontSize: 8.5,
  fontWeight: 700,
  letterSpacing: 0.4,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  whiteSpace: "nowrap",
};
const td: React.CSSProperties = {
  padding: "3px 6px",
  fontSize: 10,
  borderTop: "1px solid var(--chrome-border)",
  whiteSpace: "nowrap",
};

const ACTION_LABEL: Record<NameEvent["action"], string> = {
  raise: "raised target",
  cut: "cut target",
  init: "initiated",
  maintain: "maintained",
};

export function EventLog({
  events,
  contribution,
  weekStart,
  snapshotDate,
}: {
  events: NameEvent[];
  contribution: number | null;
  /** First date of the scored week; earlier events fed an earlier score, not this one. */
  weekStart: string;
  snapshotDate: string;
}) {
  const movers = events.filter((e) => e.action === "raise" || e.action === "cut").length;
  const inWeek = (d: string) => d > weekStart && d <= snapshotDate;
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 860 }}>
        <thead>
          <tr style={{ background: "var(--bg-surface)" }}>
            <th style={th}>Date</th>
            <th style={th}>Firm / analyst</th>
            <th style={th}>What they did</th>
            <th style={th}>Rating</th>
            <th style={{ ...th, textAlign: "right" }}>New target</th>
            <th style={{ ...th, textAlign: "right" }}>Change</th>
            <th style={{ ...th, textAlign: "right" }}>Implied vs close</th>
            <th style={{ ...th, textAlign: "right" }}>Adds to this week&apos;s score</th>
            <th style={th}>Source</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e, i) => (
            <tr key={`${e.date}-${e.firm}-${e.analyst}-${i}`}>
              <td className="bb-num" style={td}>
                {e.date}
              </td>
              <td style={td}>
                {e.firm ?? "—"}
                {e.analyst && <span style={{ color: "var(--text-muted)" }}> · {e.analyst}</span>}
              </td>
              <td style={{ ...td, color: e.action === "raise" ? "var(--color-positive)" : e.action === "cut" ? "var(--color-negative)" : "var(--text-muted)" }}>
                {ACTION_LABEL[e.action]}
              </td>
              <td style={{ ...td, color: "var(--text-muted)" }}>{e.rating ?? "—"}</td>
              <td className="bb-num" style={{ ...td, textAlign: "right" }}>
                {e.target.toFixed(2)}
              </td>
              <td className="bb-num" style={{ ...td, textAlign: "right", color: signColor(e.changePct) }}>
                {e.changePct === null ? "n/a" : fmtPctOrNm(e.changePct)}
              </td>
              <td className="bb-num" style={{ ...td, textAlign: "right", color: signColor(e.impliedUpside) }}>
                {e.impliedUpside === null ? "—" : fmtPctOrNm(e.impliedUpside)}
              </td>
              <td className="bb-num" style={{ ...td, textAlign: "right", color: "var(--text-muted)" }}>
                {!inWeek(e.date) ? "—" : e.action === "init" ? "n/a" : e.action === "maintain" ? "0.00" : fmtPctOrNm(e.changePct)}
              </td>
              <td style={{ ...td, fontSize: 8.5, color: "var(--text-muted)" }}>{e.source}</td>
            </tr>
          ))}
          {events.length === 0 && (
            <tr>
              <td colSpan={9} style={{ ...td, textAlign: "center", padding: 16, color: "var(--text-muted)" }}>
                No price-target events in the panel window.
              </td>
            </tr>
          )}
        </tbody>
      </table>
      <div style={{ padding: "5px 6px", fontSize: 9, color: "var(--text-muted)" }}>
        {movers} of {events.length} events moved a target over the panel window. The week scored on {snapshotDate} is{" "}
        {weekStart} onward, and its raw matched-panel change is{" "}
        <span className="bb-num" style={{ color: signColor(contribution) }}>
          {contribution === null ? "—" : fmtPctOrNm(contribution, 2)}
        </span>
        : each raise or cut inside that window contributes its own percentage to the average, initiations are excluded
        (no prior target to compare against), maintained targets are real zeros, and earlier events fed earlier weeks.
      </div>
    </div>
  );
}

// ── Header tiles ─────────────────────────────────────────────────────────────

export function NameStatTiles({ payload }: { payload: NamePayload }) {
  const r = payload.row;
  const tiles: Array<{ id: Parameters<typeof MetricTip>[0]["id"]; label: string; body: React.ReactNode; sub?: string }> = [
    {
      id: "ptRevOrthZ",
      label: "Target-raise score",
      body: (
        <span style={{ color: signColor(r?.ptRevOrthZ ?? null) }}>
          {r?.ptRevOrthZ == null ? "—" : `${r.ptRevOrthZ >= 0 ? "+" : ""}${r.ptRevOrthZ.toFixed(2)}`}
        </span>
      ),
      sub: r?.ptRevOrthRaw == null ? undefined : `raw ${fmtPctOrNm(r.ptRevOrthRaw, 2)}`,
    },
    {
      id: "ptUpDown",
      label: "Analysts raised / cut",
      body: (
        <>
          <span style={{ color: (r?.ptUp ?? 0) > 0 ? "var(--color-positive)" : undefined }}>{r?.ptUp ?? 0}</span>
          {" / "}
          <span style={{ color: (r?.ptDown ?? 0) > 0 ? "var(--color-negative)" : undefined }}>{r?.ptDown ?? 0}</span>
        </>
      ),
      sub: `of ${r?.analystCount ?? 0} in the panel`,
    },
    {
      id: "gapScore",
      label: "Stock vs peers · unpriced gap",
      body: (
        <>
          <span style={{ color: signColor(r?.pxZ ?? null) }}>{r?.pxZ == null ? "—" : r.pxZ.toFixed(2)}</span>
          <span style={{ color: "var(--text-muted)" }}> · </span>
          <span style={{ color: signColor(r?.gap ?? null) }}>{r?.gap == null ? "—" : r.gap.toFixed(2)}</span>
        </>
      ),
    },
    {
      id: "weeksInTopDecile",
      label: "Weeks in top 10%",
      body: <>{r?.weeksInTopDecile ?? 0}</>,
      sub: r ? `score trail ${r.ptRevOrthZHist.length}w` : undefined,
    },
    {
      id: "nextEr",
      label: "Next earnings",
      body: <span style={{ fontSize: 12 }}>{payload.panel.nextEarnings ?? "—"}</span>,
      sub: r?.daysToEarnings == null ? undefined : `in ${r.daysToEarnings} days`,
    },
  ];

  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 1, background: "var(--chrome-border)", border: "1px solid var(--chrome-border)" }}>
      {tiles.map((t) => (
        <div key={t.label} style={{ flex: "1 1 150px", background: "var(--bg-surface)", padding: "5px 9px", minWidth: 140 }}>
          <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
            <MetricTip id={t.id}>{t.label}</MetricTip>
          </div>
          <div className="bb-num" style={{ fontSize: 15, fontWeight: 700 }}>
            {t.body}
          </div>
          {t.sub && <div style={{ fontSize: 8.5, color: "var(--text-muted)" }}>{t.sub}</div>}
        </div>
      ))}
      {payload.row && (
        <div style={{ flex: "1 1 120px", background: "var(--bg-surface)", padding: "5px 9px", minWidth: 120 }}>
          <div style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, color: "var(--text-muted)", textTransform: "uppercase" }}>
            <MetricTip id="ptRevOrthZ">Score, last 13 weeks</MetricTip>
          </div>
          <Sparkline values={payload.row.ptRevOrthZHist} w={120} h={24} />
        </div>
      )}
    </div>
  );
}
