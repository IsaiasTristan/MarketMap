/**
 * Tests for the AQR XLSX parser. We build a small in-memory XLSX that mimics
 * the AQR Betting-Against-Beta layout (single sheet, header row with "DATE"
 * in column A and country codes in subsequent columns; data rows below) and
 * verify the parser extracts the requested country column correctly.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { parseAqrDailyXlsx } from "../../src/infrastructure/providers/aqr-xlsx-parser";

/**
 * Build a minimal valid XLSX buffer with the AQR daily-factor layout:
 *   row 1: title "BAB Factors"
 *   row 2: header — A="DATE", B="USA", C="GBR"
 *   row 3+: data rows
 */
async function buildSyntheticXlsx(rows: { date: string; usa: number; gbr: number }[]) {
  const sst = ["BAB Factors", "DATE", "USA", "GBR"];
  const sstXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">` +
    sst.map((s) => `<si><t>${s}</t></si>`).join("") +
    `</sst>`;

  // Convert ISO YYYY-MM-DD → MM/DD/YYYY (AQR's locale)
  function toMdy(iso: string): string {
    const [y, m, d] = iso.split("-");
    return `${m}/${d}/${y}`;
  }

  // Add date strings to sst on the fly
  const dateIndices: number[] = [];
  for (const r of rows) {
    sst.push(toMdy(r.date));
    dateIndices.push(sst.length - 1);
  }
  // Rebuild sstXml with dates appended
  const sstXmlFinal =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sst.length}" uniqueCount="${sst.length}">` +
    sst.map((s) => `<si><t>${s}</t></si>`).join("") +
    `</sst>`;

  // Build the worksheet XML
  const headerRow =
    `<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c><c r="C2" t="s"><v>3</v></c></row>`;
  const dataRows = rows
    .map(
      (r, i) =>
        `<row r="${i + 3}"><c r="A${i + 3}" t="s"><v>${dateIndices[i]}</v></c><c r="B${i + 3}"><v>${r.usa}</v></c><c r="C${i + 3}"><v>${r.gbr}</v></c></row>`,
    )
    .join("");

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
      <sheetData>${headerRow}${dataRows}</sheetData>
    </worksheet>`;

  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
    <workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
              xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
      <sheets><sheet name="BAB Factors" sheetId="1" r:id="rId1"/></sheets>
    </workbook>`;

  const zip = new JSZip();
  zip.file("xl/sharedStrings.xml", sstXmlFinal);
  zip.file("xl/worksheets/sheet1.xml", sheetXml);
  zip.file("xl/workbook.xml", workbookXml);
  return await zip.generateAsync({ type: "nodebuffer" });
}

describe("parseAqrDailyXlsx", () => {
  it("extracts the USA column from a synthetic AQR-style workbook", async () => {
    const buf = await buildSyntheticXlsx([
      { date: "2024-01-02", usa: 0.0021, gbr: 0.0011 },
      { date: "2024-01-03", usa: -0.0035, gbr: -0.0008 },
      { date: "2024-01-04", usa: 0.0014, gbr: 0.0019 },
    ]);
    const result = await parseAqrDailyXlsx(buf, { countryHeader: "USA" });
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ date: "2024-01-02", value: 0.0021 });
    expect(result[1]).toEqual({ date: "2024-01-03", value: -0.0035 });
    expect(result[2]).toEqual({ date: "2024-01-04", value: 0.0014 });
  });

  it("returns rows sorted ascending even when input is shuffled", async () => {
    const buf = await buildSyntheticXlsx([
      { date: "2024-03-05", usa: 0.001, gbr: 0 },
      { date: "2024-01-02", usa: 0.002, gbr: 0 },
      { date: "2024-02-01", usa: 0.003, gbr: 0 },
    ]);
    const result = await parseAqrDailyXlsx(buf, { countryHeader: "USA" });
    expect(result.map((r) => r.date)).toEqual(["2024-01-02", "2024-02-01", "2024-03-05"]);
  });

  it("can extract a different column (GBR)", async () => {
    const buf = await buildSyntheticXlsx([
      { date: "2024-01-02", usa: 0.001, gbr: 0.002 },
      { date: "2024-01-03", usa: 0.001, gbr: -0.004 },
    ]);
    const result = await parseAqrDailyXlsx(buf, { countryHeader: "GBR" });
    expect(result.map((r) => r.value)).toEqual([0.002, -0.004]);
  });

  it("throws when the requested country header is missing", async () => {
    const buf = await buildSyntheticXlsx([
      { date: "2024-01-02", usa: 0.001, gbr: 0.002 },
    ]);
    await expect(parseAqrDailyXlsx(buf, { countryHeader: "JPN" })).rejects.toThrow(/JPN/);
  });
});
