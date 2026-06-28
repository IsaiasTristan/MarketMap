import { NextResponse, type NextRequest } from "next/server";
import { researchQueueQuery } from "@/lib/api/schemas";
import { getLatestQueue } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchQueueQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const queue = await getLatestQueue(parsed.data.limit);
  if (!queue) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No research queue computed yet. Run the weekly job." },
      { status: 404 },
    );
  }
  return NextResponse.json(queue);
}
