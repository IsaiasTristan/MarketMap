/**
 * Manual CSV fallback for basis/curve settlements the primary provider can't
 * serve. Admin uploads a settlement file via POST /api/commodities/admin/
 * manual-csv; this module parses + groups it into per-(curve, settleDate)
 * strips ready for FuturesCurveSnapshot upserts. Push-style, so it exposes a
 * parser rather than implementing the pull FuturesCurveProvider port.
 *
 * Expected columns (header row required, case-insensitive):
 *   curve_code, settle_date (YYYY-MM-DD), contract_month (YYYY-MM or
 *   YYYY-MM-DD), price
 */
import Papa from "papaparse";
import type { CurvePoint } from "@/types/commodities";

export interface ManualCsvStrip {
  curveCode: string;
  settleDate: string;
  points: CurvePoint[];
}

export interface ManualCsvParseResult {
  strips: ManualCsvStrip[];
  errors: string[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

export function parseManualCsv(text: string): ManualCsvParseResult {
  const errors: string[] = [];
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (h) => h.trim().toLowerCase().replace(/\s+/g, "_"),
  });
  for (const err of parsed.errors.slice(0, 5)) {
    errors.push(`CSV row ${err.row}: ${err.message}`);
  }

  const byKey = new Map<string, ManualCsvStrip>();
  (parsed.data ?? []).forEach((row, i) => {
    const curveCode = row.curve_code?.trim().toUpperCase();
    const settleDate = row.settle_date?.trim();
    const rawMonth = row.contract_month?.trim();
    const price = Number(row.price);
    if (!curveCode || !settleDate || !rawMonth) {
      errors.push(`row ${i + 2}: missing curve_code/settle_date/contract_month`);
      return;
    }
    if (!ISO_DATE.test(settleDate)) {
      errors.push(`row ${i + 2}: settle_date "${settleDate}" is not YYYY-MM-DD`);
      return;
    }
    const contractMonth = MONTH_KEY.test(rawMonth)
      ? rawMonth
      : ISO_DATE.test(rawMonth)
        ? rawMonth.slice(0, 7)
        : null;
    if (!contractMonth) {
      errors.push(`row ${i + 2}: contract_month "${rawMonth}" is not YYYY-MM[-DD]`);
      return;
    }
    if (!Number.isFinite(price)) {
      errors.push(`row ${i + 2}: price "${row.price}" is not a number`);
      return;
    }
    const key = `${curveCode}|${settleDate}`;
    const strip = byKey.get(key) ?? { curveCode, settleDate, points: [] };
    strip.points.push({ contractMonth, price });
    byKey.set(key, strip);
  });

  const strips = [...byKey.values()].map((s) => ({
    ...s,
    points: s.points.sort((a, b) => (a.contractMonth < b.contractMonth ? -1 : 1)),
  }));
  return { strips, errors };
}
