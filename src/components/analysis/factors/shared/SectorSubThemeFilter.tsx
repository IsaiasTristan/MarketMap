"use client";
import { useMemo } from "react";

interface SectorSubThemeFilterProps {
  /** Available sectors derived from the data set being filtered. */
  sectors: string[];
  /**
   * Sub-themes per sector ({sector → string[]}). When `selectedSector` is set,
   * only that sector's sub-themes appear in the dropdown.
   */
  subThemesBySector: Record<string, string[]>;
  selectedSector: string | null;
  selectedSubTheme: string | null;
  onSectorChange: (s: string | null) => void;
  onSubThemeChange: (s: string | null) => void;
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

const selectStyle: React.CSSProperties = {
  background: "var(--bg-elevated)",
  border: "1px solid var(--bg-border)",
  borderRadius: 6,
  color: "var(--text-primary)",
  fontSize: 12,
  padding: "4px 8px",
  cursor: "pointer",
  outline: "none",
  minWidth: 140,
};

export function SectorSubThemeFilter({
  sectors,
  subThemesBySector,
  selectedSector,
  selectedSubTheme,
  onSectorChange,
  onSubThemeChange,
}: SectorSubThemeFilterProps) {
  const subThemeOptions = useMemo(() => {
    if (!selectedSector) {
      // Flatten all sub-themes when no sector selected
      const all = new Set<string>();
      for (const list of Object.values(subThemesBySector)) for (const s of list) all.add(s);
      return [...all].sort();
    }
    return [...(subThemesBySector[selectedSector] ?? [])].sort();
  }, [selectedSector, subThemesBySector]);

  return (
    <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={labelStyle}>Sector</label>
        <select
          value={selectedSector ?? ""}
          onChange={(e) => onSectorChange(e.target.value || null)}
          style={selectStyle}
        >
          <option value="">All sectors</option>
          {sectors.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <label style={labelStyle}>Sub-theme</label>
        <select
          value={selectedSubTheme ?? ""}
          onChange={(e) => onSubThemeChange(e.target.value || null)}
          style={selectStyle}
        >
          <option value="">All sub-themes</option>
          {subThemeOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      {(selectedSector || selectedSubTheme) && (
        <button
          onClick={() => {
            onSectorChange(null);
            onSubThemeChange(null);
          }}
          style={{
            padding: "4px 10px",
            border: "1px solid var(--bg-border)",
            background: "transparent",
            color: "var(--text-secondary)",
            fontSize: 11,
            borderRadius: 4,
            cursor: "pointer",
            height: 26,
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
