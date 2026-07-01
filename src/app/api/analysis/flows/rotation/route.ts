import { NextResponse, type NextRequest } from "next/server";
import { flowsRotationQuery } from "@/lib/api/schemas";
import { getRotation } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsRotationQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getRotation(parsed.data.period);
  if (!result) return NextResponse.json({ error: "NO_DATA", reason: "No aggregates yet." }, { status: 404 });
  return NextResponse.json(result);
}
