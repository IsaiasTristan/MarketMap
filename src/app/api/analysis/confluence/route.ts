import { NextResponse, type NextRequest } from "next/server";
import { confluenceQuery } from "@/lib/api/schemas";
import { requirePortfolioAccess } from "@/lib/api/guards";
import { getConfluenceBoard } from "@/server/services/confluence.service";

export const maxDuration = 30;

/**
 * CONFLUENCE — read-only composition of the three signal systems' baked
 * payloads into the cross-signal stacking board. One payload; stage/side/
 * sector filtering happens client-side so the funnel counts always reflect
 * the full data. `?portfolioId=` only adds held-name annotations.
 */
export async function GET(req: NextRequest) {
  const parsed = confluenceQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.portfolioId) {
    const guard = await requirePortfolioAccess(req, parsed.data.portfolioId);
    if (guard) return guard;
  }

  try {
    const result = await getConfluenceBoard({ portfolioId: parsed.data.portfolioId });
    if (!result) {
      return NextResponse.json(
        { error: "NO_DATA", reason: "No signal snapshots computed yet — run the weekly jobs first." },
        { status: 404 },
      );
    }
    return NextResponse.json(result);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
