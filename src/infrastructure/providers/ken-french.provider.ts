/**
 * KenFrenchProvider: downloads and parses Fama-French factor ZIPs.
 * Returns daily factor returns as a Map<date-string, factorValues>.
 */

import JSZip from "jszip";

export interface FfFactorRow {
  date: string; // YYYY-MM-DD
  mktRf: number;
  smb: number;
  hml: number;
  rmw: number;
  cma: number;
  rf: number;
}

export interface MomFactorRow {
  date: string;
  mom: number;
}

const FF5_URL =
  "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Research_Data_5_Factors_2x3_daily_CSV.zip";
const MOM_URL =
  "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/F-F_Momentum_Factor_daily_CSV.zip";

function yyyymmddToIso(raw: string): string {
  const s = raw.trim();
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

function parseDelimited(text: string, skipUntilData: boolean): string[][] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows: string[][] = [];
  let inData = false;

  for (const line of lines) {
    if (!inData) {
      const firstToken = line.split(",")[0].trim();
      if (skipUntilData && /^\d{8}$/.test(firstToken)) {
        inData = true;
      } else if (!skipUntilData) {
        inData = true;
      }
    }
    if (inData) {
      const cols = line.split(",").map((c) => c.trim());
      if (cols[0] && /^\d{8}$/.test(cols[0])) {
        rows.push(cols);
      }
    }
  }
  return rows;
}

async function downloadZipText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketMap/1.0)" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`FF download failed: ${res.status} ${url}`);
  const buf = await res.arrayBuffer();
  const zip = await JSZip.loadAsync(buf);
  const csvFile = Object.values(zip.files).find(
    (f) => !f.dir && f.name.endsWith(".CSV"),
  );
  if (!csvFile) throw new Error("No CSV in FF zip");
  return csvFile.async("string");
}

export async function fetchFf5Factors(): Promise<FfFactorRow[]> {
  const text = await downloadZipText(FF5_URL);
  const rows = parseDelimited(text, true);
  return rows.map((cols) => ({
    date: yyyymmddToIso(cols[0]),
    mktRf: parseFloat(cols[1]) / 100,
    smb: parseFloat(cols[2]) / 100,
    hml: parseFloat(cols[3]) / 100,
    rmw: parseFloat(cols[4]) / 100,
    cma: parseFloat(cols[5]) / 100,
    rf: parseFloat(cols[6]) / 100,
  })).filter((r) => !isNaN(r.mktRf));
}

export async function fetchMomFactor(): Promise<MomFactorRow[]> {
  const text = await downloadZipText(MOM_URL);
  const rows = parseDelimited(text, true);
  return rows.map((cols) => ({
    date: yyyymmddToIso(cols[0]),
    mom: parseFloat(cols[1]) / 100,
  })).filter((r) => !isNaN(r.mom));
}
