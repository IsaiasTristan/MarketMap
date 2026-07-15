import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { curveSetCreateBody } from "@/lib/api/schemas";
import { createCurveSet, listCurveSets } from "@/server/services/curve-sets.service";

export async function GET(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const sets = await listCurveSets(auth.user.id);
  return NextResponse.json({ sets });
}

export async function POST(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const parsed = curveSetCreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }
  const set = await createCurveSet(auth.user.id, parsed.data.name, parsed.data.curveCodes ?? []);
  return NextResponse.json(set);
}
