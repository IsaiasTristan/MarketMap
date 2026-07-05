import { NextResponse, type NextRequest } from "next/server";
import { researchCalendarQuery } from "@/lib/api/schemas";
import { getCalendar } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchCalendarQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = await getCalendar(parsed.data.days);
  return NextResponse.json(payload);
}
