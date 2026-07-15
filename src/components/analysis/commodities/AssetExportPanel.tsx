"use client";
/**
 * ASSET EXPORT: futures-only wide export (one row per contract month, one
 * column per checked curve, headers `NAME [BASIS] (UNIT) M/D/YY`). COPY TSV
 * or DOWNLOAD CSV against a selectable as-of vintage. History never leaves
 * through this panel — the footnote points at the curve-data copy for that.
 */
import { useEffect, useState } from "react";
import { shortDate } from "@/lib/commodities/format";
import type { CurveInfoDto, ResolvedVintage } from "@/types/commodities";
import { copyTsv, downloadCsv } from "./clipboard";
import { fetchExportTable } from "./useCommodities";

export function AssetExportPanel({
  setCurves,
  resolved,
  latestSettleDate,
  basisMode,
  contractRange,
  onCopied,
}: {
  setCurves: CurveInfoDto[];
  resolved: ResolvedVintage[];
  latestSettleDate: string | null;
  basisMode: "DIFF" | "OUT";
  contractRange: string | null;
  onCopied: (msg: string) => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(new Set(setCurves.map((c) => c.code)));
  const [vintageId, setVintageId] = useState("LATEST");

  // When the working set's membership changes, reset to everything checked —
  // matches the mockup, where set switches re-seed the export list.
  const membershipKey = setCurves.map((c) => c.code).join(",");
  useEffect(() => {
    setChecked(new Set(setCurves.map((c) => c.code)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [membershipKey]);

  const toggle = (code: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const build = async () => {
    const codes = setCurves.map((c) => c.code).filter((c) => checked.has(c));
    if (codes.length === 0) {
      onCopied("NO CURVES SELECTED");
      return null;
    }
    try {
      const table = await fetchExportTable({ curveCodes: codes, vintageId, basisMode });
      return [table.headers, ...table.rows];
    } catch (e) {
      onCopied(e instanceof Error ? e.message : "EXPORT FAILED");
      return null;
    }
  };

  return (
    <div className="cmdx-panel">
      <div className="cmdx-phead">
        <span className="t">ASSET EXPORT</span>
        <span className="sub">FUTURES ONLY{contractRange ? ` · ${contractRange}` : ""}</span>
      </div>
      <div className="cmdx-pbody">
        <div style={{ maxHeight: 170, overflow: "auto", marginBottom: 7 }}>
          {setCurves.map((c) => (
            <label key={c.code} className="cmdx-exprow">
              <input type="checkbox" checked={checked.has(c.code)} onChange={() => toggle(c.code)} />
              <span className={`cmdx-grp ${c.group}`}>{c.group}</span>
              <span>{c.name}</span>
              <span className="u">
                {c.kind === "BASIS" && basisMode === "DIFF" ? "BASIS · " : ""}
                {c.unit}
              </span>
            </label>
          ))}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 7 }}>
          <span className="cmdx-lbl">AS OF</span>
          <select value={vintageId} onChange={(e) => setVintageId(e.target.value)} style={{ flex: 1 }}>
            <option value="LATEST">LATEST{latestSettleDate ? ` — ${shortDate(latestSettleDate)}` : ""}</option>
            {resolved
              .filter((r) => r.resolvedDate !== null)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {r.id} — {shortDate(r.resolvedDate!)}
                </option>
              ))}
          </select>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            className="cmdx-btn-primary"
            style={{ flex: 1 }}
            onClick={async () => {
              const rows = await build();
              if (!rows) return;
              const ok = await copyTsv(rows);
              onCopied(ok ? `COPIED ${rows.length - 1} MO × ${rows[0]!.length - 1} CURVES` : "COPY BLOCKED");
            }}
          >
            COPY TSV ⧉
          </button>
          <button
            style={{ flex: 1 }}
            onClick={async () => {
              const rows = await build();
              if (!rows) return;
              downloadCsv(`curves_${vintageId.toLowerCase()}.csv`, rows);
              onCopied("CSV DOWNLOADED");
            }}
          >
            DOWNLOAD CSV ↓
          </button>
        </div>
        <div className="cmdx-footnote" style={{ marginTop: 6 }}>
          FUTURES STRIP ONLY — NO HISTORY. ONE ROW PER CONTRACT MONTH, ONE COLUMN PER CURVE; BASIS PER BASIS MODE. FOR HIST+FUT USE THE CURVE DATA COPY ⧉ ABOVE.
        </div>
      </div>
    </div>
  );
}
