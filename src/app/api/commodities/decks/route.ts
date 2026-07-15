import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { priceDeckCreateBody } from "@/lib/api/schemas";
import { createPriceDeck, listPriceDecks } from "@/server/services/price-decks.service";

export async function GET(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const decks = await listPriceDecks(auth.user.id);
  return NextResponse.json({ decks });
}

export async function POST(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const parsed = priceDeckCreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }
  const deck = await createPriceDeck(auth.user.id, parsed.data);
  return NextResponse.json(deck);
}
