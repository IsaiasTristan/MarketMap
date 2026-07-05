import { NextResponse, type NextRequest } from "next/server";
import { researchDecompQuery } from "@/lib/api/schemas";
import { getDecomp } from "@/server/services/revision/revision-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = researchDecompQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const payload = await getDecomp(parsed.data.groupType);
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No scores computed yet. Run the weekly job." },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
