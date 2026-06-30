import { NextResponse, type NextRequest } from "next/server";
import { researchEventsQuery } from "@/lib/api/schemas";
import { getRecentRatingChanges } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchEventsQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = await getRecentRatingChanges({
    ticker: parsed.data.ticker,
    limit: parsed.data.limit,
  });
  return NextResponse.json(payload);
}
