import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { curveSetPatchBody } from "@/lib/api/schemas";
import { deleteCurveSet, renameCurveSet } from "@/server/services/curve-sets.service";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const parsed = curveSetPatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success || !parsed.data.name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const set = await renameCurveSet(auth.user.id, id, parsed.data.name);
  if (!set) return NextResponse.json({ error: "Curve set not found" }, { status: 404 });
  return NextResponse.json(set);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const ok = await deleteCurveSet(auth.user.id, id);
  if (!ok) return NextResponse.json({ error: "Curve set not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
