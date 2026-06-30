import { NextResponse } from "next/server";
import { isValidTickerForStorage } from "@/domain/universe/parse";
import { resolveCompanyName } from "@/server/services/security-name.service";

// Provider round-trip can take a moment; keep it well under the serverless cap.
export const dynamic = "force-dynamic";

/**
 * Resolve a display name for an arbitrary ticker via FMP (Yahoo fallback). Used
 * by the "Add Stock" form to pre-fill the company name when adding a brand-new
 * ticker that isn't in the DB yet (the DB-backed `/analysis/securities/search`
 * cannot name an unknown symbol). Best-effort — falls back to the upper-cased
 * ticker when neither provider yields a real name.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("ticker")?.trim() ?? "";
  const ticker = raw.toUpperCase();
  if (!ticker || !isValidTickerForStorage(ticker)) {
    return NextResponse.json(
      { error: "Missing or invalid ticker" },
      { status: 400 }
    );
  }
  const name = (await resolveCompanyName(ticker)) ?? ticker;
  return NextResponse.json({ ticker, name });
}
