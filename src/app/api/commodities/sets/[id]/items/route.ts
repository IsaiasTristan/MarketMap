import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { curveSetItemsPutBody } from "@/lib/api/schemas";
import { replaceCurveSetItems } from "@/server/services/curve-sets.service";

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const parsed = curveSetItemsPutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }
  const set = await replaceCurveSetItems(auth.user.id, id, parsed.data.items);
  if (!set) return NextResponse.json({ error: "Curve set not found" }, { status: 404 });
  return NextResponse.json(set);
}
