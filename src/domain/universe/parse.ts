import { z } from "zod";

const TickerLine = z.object({
  ticker: z
    .string()
    .min(1)
    .max(12)
    .transform((s) => s.trim().toUpperCase()),
  companyName: z.string().min(1).max(256).transform((s) => s.trim()),
  sector: z.string().min(1).max(128).transform((s) => s.trim()),
  subTheme: z.string().min(1).max(128).transform((s) => s.trim()),
});

export type ParsedUniverseRow = z.infer<typeof TickerLine>;

/**
 * Tab-separated: columns may contain spaces; extra middle fields are joined into Sector.
 * Space-only paste: columns must be separated by **two or more spaces** so values like
 * "AI Chips" stay one column.
 */
export function splitFourColumns(line: string): string[] | null {
  if (line.includes("\t")) {
    const parts = line.split(/[\t]+/).map((p) => p.trim()).filter((p) => p.length > 0);
    if (parts.length < 4) return null;
    const ticker = parts[0]!;
    const companyName = parts[1]!;
    const subTheme = parts[parts.length - 1]!;
    const sector = parts.slice(2, -1).join(" ");
    return [ticker, companyName, sector, subTheme];
  }
  const parts = line.split(/\s{2,}/).map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 4) return parts;
  return null;
}

/**
 * Parse pasted tab- or space-separated text (4 columns: Ticker, Company, Sector, Sub-Theme).
 * Commas in company names: best-effort — prefer tab separation from spreadsheet paste.
 */
export function parsePastedUniverse(
  text: string
):
  | { ok: true; rows: ParsedUniverseRow[] }
  | { ok: false; errors: { line: number; message: string }[] } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const errors: { line: number; message: string }[] = [];
  const rows: ParsedUniverseRow[] = [];

  let i = 0;
  for (const line of lines) {
    i += 1;
    const parts = splitFourColumns(line);
    if (!parts) {
      errors.push({
        line: i,
        message:
          "Expected 4 columns (Ticker, Company, Sector, Sub-Theme). Use tab-separated paste from a spreadsheet, or align columns with 2+ spaces between fields.",
      });
      continue;
    }
    const [ticker, name, sector, subTheme] = parts;
    if (!ticker || !name || !sector || !subTheme) {
      errors.push({ line: i, message: "Missing required field" });
      continue;
    }
    const parsed = TickerLine.safeParse({
      ticker,
      companyName: name,
      sector,
      subTheme,
    });
    if (!parsed.success) {
      const msg = parsed.error.flatten().formErrors[0] ?? "Invalid row";
      errors.push({ line: i, message: msg });
      continue;
    }
    rows.push(parsed.data);
  }

  if (errors.length > 0) return { ok: false, errors };
  if (rows.length === 0) {
    return { ok: false, errors: [{ line: 0, message: "No data rows" }] };
  }
  return { ok: true, rows };
}

export function isValidTickerForStorage(ticker: string): boolean {
  return /^[A-Z0-9.\-]{1,12}$/.test(ticker);
}

/**
 * Split one CSV line into fields. Supports quoted fields ("...") with escaped
 * double quotes ("") but not embedded newlines.
 */
function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function looksLikeHeader(fields: string[]): boolean {
  const first = (fields[0] ?? "").toLowerCase();
  const joined = fields.map((f) => f.toLowerCase()).join(",");
  if (first === "ticker" || first === "symbol") return true;
  if (/\b(theme|sector|subtheme|sub[- ]?theme|name|company)\b/.test(joined)) {
    return true;
  }
  return false;
}

/**
 * Parse a CSV (or TSV) universe. Required shape: exactly 4 columns per row —
 * Ticker, Name, Sector, Sub-Theme. A header row is optional and skipped if
 * the first field looks like a header label (e.g. "ticker" / "symbol").
 *
 * Delimiter detection: if the first non-empty line contains a tab, every line
 * is split on tabs (CSV-quoting rules do not apply); otherwise standard CSV
 * splitting on commas with quoted-field support is used. This keeps the
 * "CSV Import" UI forgiving when users paste straight from a spreadsheet.
 */
export function parseUniverseCsv(
  text: string
):
  | { ok: true; rows: ParsedUniverseRow[] }
  | { ok: false; errors: { line: number; message: string }[] } {
  const rawLines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0);
  if (rawLines.length === 0) {
    return { ok: false, errors: [{ line: 0, message: "No data rows" }] };
  }
  const errors: { line: number; message: string }[] = [];
  const rows: ParsedUniverseRow[] = [];

  const tabDelimited = rawLines[0]!.includes("\t");
  const splitLine = (line: string): string[] =>
    tabDelimited
      ? line.split(/\t+/).map((f) => f.trim())
      : splitCsvLine(line).map((f) => f.trim());

  let startIdx = 0;
  if (looksLikeHeader(splitLine(rawLines[0]!))) startIdx = 1;

  for (let i = startIdx; i < rawLines.length; i += 1) {
    const lineNo = i + 1;
    const trimmed = splitLine(rawLines[i]!);
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === "") {
      trimmed.pop();
    }
    if (trimmed.length !== 4) {
      errors.push({
        line: lineNo,
        message: `Expected 4 columns (Ticker, Name, Sector, Sub-Theme); got ${trimmed.length}.`,
      });
      continue;
    }
    const [ticker, name, sector, subTheme] = trimmed;
    if (!ticker || !name || !sector || !subTheme) {
      errors.push({ line: lineNo, message: "Missing required field" });
      continue;
    }
    const parsed = TickerLine.safeParse({
      ticker,
      companyName: name,
      sector,
      subTheme,
    });
    if (!parsed.success) {
      const msg = parsed.error.flatten().formErrors[0] ?? "Invalid row";
      errors.push({ line: lineNo, message: msg });
      continue;
    }
    rows.push(parsed.data);
  }

  if (errors.length > 0) return { ok: false, errors };
  if (rows.length === 0) {
    return { ok: false, errors: [{ line: 0, message: "No data rows" }] };
  }
  return { ok: true, rows };
}
