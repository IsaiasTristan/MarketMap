import { NextResponse, type NextRequest } from "next/server";
import { fundamentalsDiligenceQuery } from "@/lib/api/schemas";
import { getDiligence } from "@/server/services/fundamental/fundamental-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = fundamentalsDiligenceQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const result = await getDiligence(parsed.data.ticker);
  if (!result) {
    return NextResponse.json(
      { error: "NO_DATA", reason: `No fundamentals stored for ${parsed.data.ticker}.` },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
