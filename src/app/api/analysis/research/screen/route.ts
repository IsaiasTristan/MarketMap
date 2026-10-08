import { NextResponse, type NextRequest } from "next/server";
import { researchScreenQuery } from "@/lib/api/schemas";
import { getQueueScreen } from "@/server/services/revision/revision-screen.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchScreenQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const f = parsed.data;
  const payload = await getQueueScreen({
    date: f.date,
    side: f.side,
    minZ: f.minZ,
    cap: f.cap,
    cov: f.cov,
    minWeeks: f.minWeeks,
    er: f.er,
    isNew: f.new,
    tri: f.tri,
    subsector: f.subsector,
    q: f.q,
    page: f.page,
    pageSize: f.pageSize,
  });
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No screen rows materialized yet. Run job:revision-screen-rows." },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
