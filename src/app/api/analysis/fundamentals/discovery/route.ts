import { NextResponse, type NextRequest } from "next/server";
import { fundamentalsQueueQuery } from "@/lib/api/schemas";
import { getDiscoveryQueue } from "@/server/services/fundamental/fundamental-query.service";

export const maxDuration = 30;

// Single cached read powering Discovery Rank + Margin Inflection + Quality/Value
// + Accruals + Compounder views (all projections of the same per-name row set).
export async function GET(req: NextRequest) {
  const parsed = fundamentalsQueueQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = await getDiscoveryQueue(parsed.data.limit);
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No discovery queue computed yet — run the fundamentals weekly job." },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
