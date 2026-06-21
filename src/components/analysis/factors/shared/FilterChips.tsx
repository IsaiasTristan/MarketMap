"use client";
/**
 * FilterChips — removable, editable filter row for the per-stock screener.
 *
 * Each chip represents an active row predicate (R² ≥ X, Obs ≥ N, |α| ≥ X%,
 * |β_f| ≥ Y, α CI excludes 0). Clicking a chip opens a small inline editor;
 * clicking the × removes the filter. "+ Add filter" surfaces remaining
 * predicate types.
 *
 * The significance gate is NOT shown here — it's a cell-level mask handled
 * by the SigGateChip on the toolbar.
 */
import { useEffect, useRef, useState } from "react";
import { useAnalysisStore, type FactorScreenerFilters } from "@/store/analysis";
import { getFactorDef } from "@/lib/factors/definitions/factor-codes";
import type { FactorCode } from "@/types/factors";

interface FilterChipsProps {
  /** Factor codes available on the current grid (passed from PerStockResult.usableFactors). */
  availableFactors: ReadonlyArray<FactorCode>;
}

type FilterKey =
  | "minRSquared"
  | "minObservations"
  | "alphaMagnitudeFloor"
  | "betaMagnitudeFloor"
  | "alphaCiExcludesZero";

const FILTER_LABELS: Record<FilterKey, string> = {
  minRSquared: "R²",
  minObservations: "Obs",
  alphaMagnitudeFloor: "|α|",
  betaMagnitudeFloor: "|β|",
  alphaCiExcludesZero: "α CI excludes 0",
};

const labelStyle: React.CSSProperties = {
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
  fontSize: 10,
  fontWeight: 600,
};

export function FilterChips({ availableFactors }: FilterChipsProps) {
  const {
    factorScreenerFilters: f,
    setFactorScreenerFilters,
    setFactorScreenerBetaMagnitudeFloor,
    resetFactorScreenerFilters,
  } = useAnalysisStore();

  const [addOpen, setAddOpen] = useState(false);
  const addRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!addOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!addRef.current) return;
      if (!addRef.current.contains(e.target as Node)) setAddOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [addOpen]);

  const activeFilters = collectActiveFilters(f);
  const availableToAdd = computeAvailableToAdd(f, availableFactors);

  if (activeFilters.length === 0 && availableToAdd.length === 0) {
    // Nothing to show and nothing to add — render nothing.
    return null;
  }

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        padding: "6px 14px",
        background: "var(--bg-surface)",
        border: "1px solid var(--bg-border)",
        borderRadius: 2,
        minHeight: 30,
      }}
    >
      <span style={labelStyle}>Filters</span>

      {activeFilters.length === 0 && (
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          None active
        </span>
      )}

      {activeFilters.map((entry) => (
        <FilterChip
          key={entry.id}
          entry={entry}
          onRemove={() => removeFilter(entry, f, setFactorScreenerFilters, setFactorScreenerBetaMagnitudeFloor)}
          onEdit={(value) =>
            updateFilter(entry, value, f, setFactorScreenerFilters, setFactorScreenerBetaMagnitudeFloor)
          }
        />
      ))}

      <div ref={addRef} style={{ position: "relative" }}>
        <button
          type="button"
          disabled={availableToAdd.length === 0}
          onClick={() => setAddOpen((o) => !o)}
          style={{
            background: "transparent",
            border: "1px dashed var(--bg-border)",
            color:
              availableToAdd.length === 0
                ? "var(--text-muted)"
                : "var(--text-secondary)",
            borderRadius: 2,
            padding: "0 10px",
            height: 24,
            fontSize: 11,
            cursor: availableToAdd.length === 0 ? "default" : "pointer",
            fontFamily: "inherit",
            whiteSpace: "nowrap",
          }}
        >
          + Add filter
        </button>
        {addOpen && availableToAdd.length > 0 && (
          <div
            style={{
              position: "absolute",
              top: 28,
              left: 0,
              background: "var(--bg-elevated)",
              border: "1px solid var(--bg-border)",
              borderRadius: 2,
              padding: 4,
              zIndex: 50,
              minWidth: 220,
              boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
            }}
          >
            {availableToAdd.map((opt) => (
              <button
                key={opt.id}
                onClick={() => {
                  setAddOpen(false);
                  addFilter(
                    opt,
                    f,
                    setFactorScreenerFilters,
                    setFactorScreenerBetaMagnitudeFloor,
                  );
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  color: "var(--text-primary)",
                  padding: "6px 10px",
                  fontSize: 11,
                  fontFamily: "inherit",
                  cursor: "pointer",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(255,255,255,0.06)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                }}
              >
                {opt.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {activeFilters.length > 0 && (
        <button
          type="button"
          onClick={resetFactorScreenerFilters}
          style={{
            background: "transparent",
            border: "none",
            color: "var(--text-muted)",
            fontSize: 10,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            cursor: "pointer",
            fontFamily: "inherit",
            padding: "0 6px",
            marginLeft: "auto",
          }}
          title="Clear every active row filter (does NOT touch the sig gate)."
        >
          Clear all
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chip
// ---------------------------------------------------------------------------

interface ChipEntry {
  id: string;
  filterKey: FilterKey;
  factorCode?: FactorCode;
  label: string;
  /** Numeric value for editable filters; null for boolean (CI excludes 0). */
  value: number | null;
  /** "%" / "" / "." — formatted into the chip body. */
  unit: "%" | "" | "x";
}

interface FilterChipProps {
  entry: ChipEntry;
  onRemove: () => void;
  onEdit: (value: number) => void;
}

function FilterChip({ entry, onRemove, onEdit }: FilterChipProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(
    entry.value !== null ? String(formatChipValue(entry.value, entry.unit)) : "",
  );
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!editing) return;
    function onDocClick(e: MouseEvent) {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setEditing(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [editing]);

  const isBool = entry.value === null;

  return (
    <div
      ref={ref}
      style={{
        position: "relative",
        display: "inline-flex",
        alignItems: "center",
        background: "rgba(240,182,93,0.08)",
        border: "1px solid var(--color-accent)",
        borderRadius: 2,
        height: 22,
        padding: "0 4px 0 8px",
        fontSize: 11,
        color: "var(--color-accent)",
        whiteSpace: "nowrap",
      }}
    >
      <button
        type="button"
        onClick={() => !isBool && setEditing((e) => !e)}
        disabled={isBool}
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          font: "inherit",
          padding: 0,
          cursor: isBool ? "default" : "pointer",
        }}
      >
        {entry.label}
      </button>
      <button
        type="button"
        onClick={onRemove}
        title="Remove filter"
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          padding: "0 4px",
          marginLeft: 4,
          cursor: "pointer",
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        ×
      </button>
      {editing && entry.value !== null && (
        <div
          style={{
            position: "absolute",
            top: 24,
            left: 0,
            background: "var(--bg-elevated)",
            border: "1px solid var(--bg-border)",
            borderRadius: 2,
            padding: 8,
            zIndex: 50,
            minWidth: 160,
            boxShadow: "0 4px 18px rgba(0,0,0,0.45)",
          }}
        >
          <div
            style={{
              fontSize: 10,
              color: "var(--text-muted)",
              marginBottom: 4,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
            }}
          >
            Edit threshold
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input
              autoFocus
              type="number"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  const parsed = parseChipDraft(draft, entry.unit);
                  if (parsed !== null) {
                    onEdit(parsed);
                    setEditing(false);
                  }
                } else if (e.key === "Escape") {
                  setEditing(false);
                }
              }}
              step={chipStep(entry.unit, entry.filterKey)}
              style={{
                flex: 1,
                background: "var(--bg-surface)",
                color: "var(--text-primary)",
                border: "1px solid var(--bg-border)",
                borderRadius: 2,
                padding: "2px 6px",
                fontSize: 11,
                fontFamily: "inherit",
              }}
            />
            <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
              {entry.unit === "%" ? "%" : entry.unit === "x" ? "" : ""}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter editing helpers
// ---------------------------------------------------------------------------

function formatChipValue(v: number, unit: ChipEntry["unit"]): string {
  if (unit === "%") return (v * 100).toFixed(0);
  return v.toFixed(2);
}

function parseChipDraft(s: string, unit: ChipEntry["unit"]): number | null {
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0) return null;
  if (unit === "%") return n / 100;
  return n;
}

function chipStep(unit: ChipEntry["unit"], filterKey: FilterKey): number {
  if (filterKey === "minObservations") return 1;
  if (unit === "%") return 1;
  return 0.05;
}

interface AddOption {
  id: string;
  filterKey: FilterKey;
  factorCode?: FactorCode;
  label: string;
}

function collectActiveFilters(f: FactorScreenerFilters): ChipEntry[] {
  const out: ChipEntry[] = [];
  if (f.minRSquared != null && Number.isFinite(f.minRSquared)) {
    out.push({
      id: "minRSquared",
      filterKey: "minRSquared",
      label: `${FILTER_LABELS.minRSquared} ≥ ${(f.minRSquared * 100).toFixed(0)}%`,
      value: f.minRSquared,
      unit: "%",
    });
  }
  if (f.minObservations != null && Number.isFinite(f.minObservations)) {
    out.push({
      id: "minObservations",
      filterKey: "minObservations",
      label: `${FILTER_LABELS.minObservations} ≥ ${f.minObservations}`,
      value: f.minObservations,
      unit: "",
    });
  }
  if (f.alphaMagnitudeFloor != null && Number.isFinite(f.alphaMagnitudeFloor)) {
    out.push({
      id: "alphaMagnitudeFloor",
      filterKey: "alphaMagnitudeFloor",
      label: `${FILTER_LABELS.alphaMagnitudeFloor} ≥ ${(f.alphaMagnitudeFloor * 100).toFixed(0)}%`,
      value: f.alphaMagnitudeFloor,
      unit: "%",
    });
  }
  for (const [code, floor] of Object.entries(f.betaMagnitudeFloor)) {
    if (floor == null || !Number.isFinite(floor)) continue;
    const def = getFactorDef(code as FactorCode);
    out.push({
      id: `betaMagnitudeFloor:${code}`,
      filterKey: "betaMagnitudeFloor",
      factorCode: code as FactorCode,
      label: `|β ${def.shortLabel}| ≥ ${floor.toFixed(2)}`,
      value: floor,
      unit: "x",
    });
  }
  if (f.alphaCiExcludesZero) {
    out.push({
      id: "alphaCiExcludesZero",
      filterKey: "alphaCiExcludesZero",
      label: FILTER_LABELS.alphaCiExcludesZero,
      value: null,
      unit: "",
    });
  }
  return out;
}

function computeAvailableToAdd(
  f: FactorScreenerFilters,
  available: ReadonlyArray<FactorCode>,
): AddOption[] {
  const out: AddOption[] = [];
  if (f.minRSquared == null) {
    out.push({ id: "minRSquared", filterKey: "minRSquared", label: "R² minimum" });
  }
  if (f.minObservations == null) {
    out.push({
      id: "minObservations",
      filterKey: "minObservations",
      label: "Observations minimum",
    });
  }
  if (f.alphaMagnitudeFloor == null) {
    out.push({
      id: "alphaMagnitudeFloor",
      filterKey: "alphaMagnitudeFloor",
      label: "|α| magnitude floor",
    });
  }
  for (const code of available) {
    if (f.betaMagnitudeFloor[code] == null) {
      const def = getFactorDef(code);
      out.push({
        id: `betaMagnitudeFloor:${code}`,
        filterKey: "betaMagnitudeFloor",
        factorCode: code,
        label: `|β ${def.shortLabel}| floor`,
      });
    }
  }
  if (!f.alphaCiExcludesZero) {
    out.push({
      id: "alphaCiExcludesZero",
      filterKey: "alphaCiExcludesZero",
      label: FILTER_LABELS.alphaCiExcludesZero,
    });
  }
  return out;
}

function addFilter(
  opt: AddOption,
  f: FactorScreenerFilters,
  setFilters: (patch: Partial<FactorScreenerFilters>) => void,
  setBeta: (code: FactorCode, floor: number | null) => void,
) {
  switch (opt.filterKey) {
    case "minRSquared":
      setFilters({ minRSquared: 0.3 });
      return;
    case "minObservations":
      setFilters({ minObservations: 60 });
      return;
    case "alphaMagnitudeFloor":
      setFilters({ alphaMagnitudeFloor: 0.05 });
      return;
    case "betaMagnitudeFloor":
      if (opt.factorCode) setBeta(opt.factorCode, 0.3);
      return;
    case "alphaCiExcludesZero":
      setFilters({ alphaCiExcludesZero: true });
      return;
  }
  // Reference void to keep the linter happy if filters grow.
  void f;
}

function removeFilter(
  entry: ChipEntry,
  _f: FactorScreenerFilters,
  setFilters: (patch: Partial<FactorScreenerFilters>) => void,
  setBeta: (code: FactorCode, floor: number | null) => void,
) {
  switch (entry.filterKey) {
    case "minRSquared":
      setFilters({ minRSquared: null });
      return;
    case "minObservations":
      setFilters({ minObservations: null });
      return;
    case "alphaMagnitudeFloor":
      setFilters({ alphaMagnitudeFloor: null });
      return;
    case "betaMagnitudeFloor":
      if (entry.factorCode) setBeta(entry.factorCode, null);
      return;
    case "alphaCiExcludesZero":
      setFilters({ alphaCiExcludesZero: false });
      return;
  }
}

function updateFilter(
  entry: ChipEntry,
  value: number,
  _f: FactorScreenerFilters,
  setFilters: (patch: Partial<FactorScreenerFilters>) => void,
  setBeta: (code: FactorCode, floor: number | null) => void,
) {
  switch (entry.filterKey) {
    case "minRSquared":
      setFilters({ minRSquared: Math.max(0, Math.min(1, value)) });
      return;
    case "minObservations":
      setFilters({ minObservations: Math.max(1, Math.round(value)) });
      return;
    case "alphaMagnitudeFloor":
      setFilters({ alphaMagnitudeFloor: Math.max(0, value) });
      return;
    case "betaMagnitudeFloor":
      if (entry.factorCode) setBeta(entry.factorCode, Math.max(0, value));
      return;
    case "alphaCiExcludesZero":
      // Boolean — no edit path.
      return;
  }
}
