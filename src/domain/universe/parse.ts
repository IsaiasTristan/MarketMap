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
