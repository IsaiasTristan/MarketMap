"use client";

/**
 * TSV clipboard + CSV download helpers for the COMMODITIES tab's Excel
 * workflows. Rows are arrays of cells; null/undefined render as empty cells.
 */
export async function copyTsv(rows: (string | number | null | undefined)[][]): Promise<boolean> {
  const text = rows
    .map((r) => r.map((c) => (c === null || c === undefined ? "" : String(c))).join("\t"))
    .join("\n");
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadCsv(filename: string, rows: (string | number | null | undefined)[][]): void {
  const esc = (c: string | number | null | undefined): string => {
    if (c === null || c === undefined) return "";
    const s = String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(esc).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
