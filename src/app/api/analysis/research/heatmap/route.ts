import { NextResponse, type NextRequest } from "next/server";
import { researchGroupQuery } from "@/lib/api/schemas";
import { getHeatmap } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchGroupQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { groupType, weeks } = parsed.data;
  const heatmap = await getHeatmap(groupType, weeks);
  return NextResponse.json(heatmap);
}
