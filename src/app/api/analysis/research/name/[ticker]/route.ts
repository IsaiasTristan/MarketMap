import { NextResponse, type NextRequest } from "next/server";
import { researchNameQuery } from "@/lib/api/schemas";
import { getNameScreen } from "@/server/services/revision/revision-name.service";

export const maxDuration = 30;

export async function GET(req: NextRequest, ctx: { params: Promise<{ ticker: string }> }) {
  const { ticker } = await ctx.params;
  const parsed = researchNameQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = await getNameScreen(ticker, parsed.data.date);
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: `No screen row for ${ticker.toUpperCase()} on that week.` },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
