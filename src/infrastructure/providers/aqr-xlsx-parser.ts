/**
 * AQR XLSX parser — common machinery for AQR daily factor data sets.
 *
 * AQR ships factor returns as Excel workbooks where:
 *   - Sheet 1 is the "<FactorName> Factors" sheet
 *   - Header row (typically ~row 19) labels each column with a country / region
 *     code via sharedStrings indices
 *   - Each subsequent row is a single trading day with date in column A and
 *     decimal returns in the country columns (USA is the column we want)
 *
 * The AQR daily files are too large for the `xlsx` SheetJS package to inflate
 * in one shot (it OOMs because the inflated worksheet XML can exceed Node's
 * default ArrayBuffer size). We instead stream the worksheet XML out of the
 * ZIP container with JSZip and walk it line-by-line with a narrow regex.
 */

import JSZip from "jszip";

export interface AqrDailyRow {
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** US factor return as a decimal (e.g. 0.0023 for 23 bps). */
  value: number;
}

/** Parse MM/DD/YYYY (AQR's US-locale format) into ISO YYYY-MM-DD. */
function aqrDateToIso(raw: string | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const mm = m[1]!.padStart(2, "0");
  const dd = m[2]!.padStart(2, "0");
  const yyyy = m[3]!;
  return `${yyyy}-${mm}-${dd}`;
}

/** Convert an Excel column reference (A, B, ..., Z, AA, AB, ...) to a 1-based index. */
function columnRefToIndex(ref: string): number {
  let n = 0;
  for (let i = 0; i < ref.length; i++) {
    const ch = ref.charCodeAt(i);
    if (ch < 65 || ch > 90) break;
    n = n * 26 + (ch - 64);
  }
  return n;
}

/** Strip the row-number suffix from a cell reference like "A123" → "A". */
function cellColumn(ref: string): string {
  let i = 0;
  while (i < ref.length && ref.charCodeAt(i) >= 65 && ref.charCodeAt(i) <= 90) i++;
  return ref.slice(0, i);
}

interface ParseOptions {
  /** Country/portfolio column header to extract (e.g. "USA"). */
  countryHeader: string;
  /**
   * Worksheet XML entry path inside the ZIP. Defaults to the first sheet
   * (`xl/worksheets/sheet1.xml`).
   */
  sheetPath?: string;
}

/**
 * Parse an AQR daily-factor XLSX buffer and return the requested column's
 * daily series in ISO date order.
 */
export async function parseAqrDailyXlsx(
  buf: Buffer | ArrayBuffer | Uint8Array,
  opts: ParseOptions,
): Promise<AqrDailyRow[]> {
  const zip = await JSZip.loadAsync(buf);
  const sheetPath = opts.sheetPath ?? "xl/worksheets/sheet1.xml";

  const sstFile = zip.file("xl/sharedStrings.xml");
  if (!sstFile) throw new Error("AQR XLSX missing xl/sharedStrings.xml");
  const sheetFile = zip.file(sheetPath);
  if (!sheetFile) throw new Error(`AQR XLSX missing ${sheetPath}`);

  const sstXml = await sstFile.async("string");
  // Each <si> element is a unique shared string. Use the inner <t>…</t>.
  // We accept both <t> and <t xml:space="preserve"> variants.
  const sst: string[] = [...sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => {
    const inner = m[1] ?? "";
    // Concatenate all <t>…</t> runs (rich text shows up as <r><t>…</t></r>).
    const parts = [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1] ?? "");
    return parts.join("");
  });

  const sheetXml = await sheetFile.async("string");

  // Walk rows. Header row is identified by the first row that contains
  // the literal "DATE" string in column A (AQR's standard layout).
  const rowRegex = /<row[^>]*r="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  const cellRegex = /<c\s+r="([A-Z]+\d+)"(?:\s+s="\d+")?(?:\s+t="([^"]+)")?\s*(?:\/>|>(?:<v>([^<]*)<\/v>|<is>(?:<t[^>]*>([^<]*)<\/t>)?<\/is>)?<\/c>)/g;

  let headerRow = -1;
  let dateColIdx = -1;
  let valueColIdx = -1;

  const want = opts.countryHeader.toUpperCase();
  const out: AqrDailyRow[] = [];

  let match: RegExpExecArray | null;
  while ((match = rowRegex.exec(sheetXml)) !== null) {
    const rowNum = Number(match[1]!);
    const inner = match[2]!;

    // Build a quick map: column index → raw value (string)
    const colVals = new Map<number, string>();
    let cm: RegExpExecArray | null;
    cellRegex.lastIndex = 0;
    while ((cm = cellRegex.exec(inner)) !== null) {
      const ref = cm[1]!;
      const t = cm[2];
      const v = cm[3];
      const inlineStr = cm[4];

      const colIdx = columnRefToIndex(cellColumn(ref));
      let resolved: string | undefined;
      if (t === "s" && v != null) {
        resolved = sst[Number(v)];
      } else if (t === "inlineStr" || t === "str") {
        resolved = inlineStr ?? v;
      } else if (v != null) {
        resolved = v;
      }
      if (resolved !== undefined) colVals.set(colIdx, resolved);
    }

    if (headerRow < 0) {
      // Look for "DATE" in column A; if found, identify the want column
      const colA = colVals.get(1);
      if (colA && /^date$/i.test(colA.trim())) {
        headerRow = rowNum;
        dateColIdx = 1;
        for (const [idx, val] of colVals.entries()) {
          if (val.trim().toUpperCase() === want) {
            valueColIdx = idx;
            break;
          }
        }
        if (valueColIdx < 0) {
          throw new Error(
            `AQR XLSX header row ${rowNum} does not contain column "${want}". ` +
              `Available columns: ${[...colVals.values()].join(", ")}`,
          );
        }
      }
      continue;
    }

    // Data row: needs both date and value
    const dateRaw = colVals.get(dateColIdx);
    const valRaw = colVals.get(valueColIdx);
    if (!dateRaw || !valRaw) continue;

    const iso = aqrDateToIso(dateRaw);
    if (!iso) continue;
    const num = Number(valRaw);
    if (!Number.isFinite(num)) continue;
    out.push({ date: iso, value: num });
  }

  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Download an AQR XLSX with retry. AQR's CDN is generally fast and not
 * rate-limited, but we still guard against transient 5xx.
 */
export async function downloadAqrXlsx(url: string): Promise<Buffer> {
  const MAX_ATTEMPTS = 3;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketMap/1.0)" },
        // AQR files can be 30+ MB. Give the request 90s before timing out.
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
          lastErr = new Error(`AQR HTTP ${res.status} for ${url}`);
          await sleep(500 * 2 ** (attempt - 1));
          continue;
        }
        throw new Error(`AQR HTTP ${res.status} for ${url}`);
      }
      const arr = await res.arrayBuffer();
      return Buffer.from(arr);
    } catch (e) {
      lastErr = e;
      if (attempt === MAX_ATTEMPTS) throw e;
      await sleep(500 * 2 ** (attempt - 1));
    }
  }
  throw lastErr ?? new Error(`AQR download failed for ${url}`);
}
