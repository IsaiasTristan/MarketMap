import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { deckExpandedQuery } from "@/lib/api/schemas";
import { expandPriceDeck } from "@/server/services/price-decks.service";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { id } = await ctx.params;

  const url = new URL(req.url);
  const parsed = deckExpandedQuery.safeParse({
    curve: url.searchParams.get("curve") ?? undefined,
    basisMode: url.searchParams.get("basisMode") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }

  const out = await expandPriceDeck(auth.user.id, id, parsed.data.curve, parsed.data.basisMode);
  if (!out) return NextResponse.json({ error: "Price deck or curve not found" }, { status: 404 });
  if (!out.result.ok) {
    // Domain rejection (basis differential, empty strip, missing terminal
    // value) — a client error, not a server fault.
    return NextResponse.json({ error: out.result.reason }, { status: 400 });
  }
  return NextResponse.json({ deck: out.deck, months: out.result.months });
}
