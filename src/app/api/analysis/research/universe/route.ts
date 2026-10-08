import { NextResponse, type NextRequest } from "next/server";
import { researchUniverseQuery } from "@/lib/api/schemas";
import { getUniverseScreen } from "@/server/services/revision/revision-screen.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchUniverseQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = await getUniverseScreen(parsed.data.date);
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No screen rows materialized yet. Run job:revision-screen-rows." },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
