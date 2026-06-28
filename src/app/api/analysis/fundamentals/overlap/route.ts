import { NextResponse, type NextRequest } from "next/server";
import { fundamentalsOverlapQuery } from "@/lib/api/schemas";
import { getOverlap } from "@/server/services/fundamental/fundamental-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = fundamentalsOverlapQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await getOverlap(parsed.data.topDecile);
  return NextResponse.json(result);
}
