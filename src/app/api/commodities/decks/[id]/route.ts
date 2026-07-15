import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { priceDeckPatchBody } from "@/lib/api/schemas";
import { deletePriceDeck, updatePriceDeck } from "@/server/services/price-decks.service";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const parsed = priceDeckPatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }
  const deck = await updatePriceDeck(auth.user.id, id, parsed.data);
  if (!deck) return NextResponse.json({ error: "Price deck not found" }, { status: 404 });
  return NextResponse.json(deck);
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;
  const ok = await deletePriceDeck(auth.user.id, id);
  if (!ok) return NextResponse.json({ error: "Price deck not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
