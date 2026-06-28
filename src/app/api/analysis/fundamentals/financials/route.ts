import { NextResponse, type NextRequest } from "next/server";
import { fundamentalsFinancialsQuery } from "@/lib/api/schemas";
import { getFinancials } from "@/server/services/fundamental/fundamental-financials.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = fundamentalsFinancialsQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  try {
    const result = await getFinancials(parsed.data.ticker, parsed.data.basis);
    if (!result) {
      return NextResponse.json(
        { error: "NO_DATA", reason: `No fundamentals stored for ${parsed.data.ticker}.` },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (err) {
    const reason = err instanceof Error ? err.message : "Unexpected error";
    console.error(`[fundamentals/financials] failed for ${parsed.data.ticker}:`, err);
    return NextResponse.json({ error: "INTERNAL", reason }, { status: 500 });
  }
}
