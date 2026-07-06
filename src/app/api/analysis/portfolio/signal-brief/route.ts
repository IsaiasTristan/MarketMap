import { NextResponse, type NextRequest } from "next/server";
import { signalBriefQuery } from "@/lib/api/schemas";
import { requirePortfolioAccess } from "@/lib/api/guards";
import { getSignalBrief } from "@/server/services/signal-brief.service";

export const maxDuration = 30;

/**
 * Overview SIGNAL BRIEF — read-only composition of the portfolio's tickers
 * onto the precomputed revision + 13F signals (scatter verdicts, earnings
 * timeline, what-changed feed). 404 NO_DATA on an empty book; each signal leg
 * degrades independently inside the payload.
 */
export async function GET(req: NextRequest) {
  const parsed = signalBriefQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const guard = await requirePortfolioAccess(req, parsed.data.portfolioId);
  if (guard) return guard;

  try {
    const result = await getSignalBrief(parsed.data.portfolioId);
    if (!result) {
      return NextResponse.json(
        { error: "NO_DATA", reason: "No positions in this portfolio yet." },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
