/**
 * AqrBabProvider — downloads AQR's daily Betting-Against-Beta (BAB) factor
 * series for the United States.
 *
 * Source: https://www.aqr.com/library/data-sets/betting-against-beta-equity-factors-daily
 * The XLSX is publicly downloadable (no auth) and refreshed monthly with a
 * ~2-month lag. We splice the recent gap with a USMV-SPY proxy in the
 * factor pipeline.
 */
import { downloadAqrXlsx, parseAqrDailyXlsx, type AqrDailyRow } from "./aqr-xlsx-parser";

const BAB_DAILY_URL =
  "https://www.aqr.com/-/media/AQR/Documents/Insights/Data-Sets/Betting-Against-Beta-Equity-Factors-Daily.xlsx";

/** Fetch the AQR BAB daily series for the United States. */
export async function fetchAqrBabUs(): Promise<AqrDailyRow[]> {
  const buf = await downloadAqrXlsx(BAB_DAILY_URL);
  return parseAqrDailyXlsx(buf, { countryHeader: "USA" });
}
