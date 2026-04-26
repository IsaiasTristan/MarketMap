/**
 * AqrQmjProvider — downloads AQR's daily Quality-Minus-Junk (QMJ) factor
 * series for the United States.
 *
 * Source: https://www.aqr.com/library/data-sets/quality-minus-junk-factors-daily
 * Same XLSX layout as BAB; column "USA" carries the US factor return. The
 * file is refreshed monthly with a ~2-month lag — the recent gap is filled
 * by a QUAL-SPY proxy in the factor pipeline.
 */
import { downloadAqrXlsx, parseAqrDailyXlsx, type AqrDailyRow } from "./aqr-xlsx-parser";

const QMJ_DAILY_URL =
  "https://www.aqr.com/-/media/AQR/Documents/Insights/Data-Sets/Quality-Minus-Junk-Factors-Daily.xlsx";

/** Fetch the AQR QMJ daily series for the United States. */
export async function fetchAqrQmjUs(): Promise<AqrDailyRow[]> {
  const buf = await downloadAqrXlsx(QMJ_DAILY_URL);
  return parseAqrDailyXlsx(buf, { countryHeader: "USA" });
}
