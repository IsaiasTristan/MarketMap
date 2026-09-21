import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { resolveAdminOrResponse } from "@/lib/api/guards";
import { pairsLinkCreateBody, pairsLinkDeleteBody, pairsLinkPatchBody } from "@/lib/api/schemas";
import { getPairLinks } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

/** List curated Tier-3 links (user-readable). ?all=1 includes inactive. */
export async function GET(req: NextRequest) {
  const includeInactive = req.nextUrl.searchParams.get("all") === "1";
  return NextResponse.json({ links: await getPairLinks(includeInactive) });
}

/** Admin — create a curated link; curatedBy is stamped from the caller. */
export async function POST(req: NextRequest) {
  const auth = await resolveAdminOrResponse(req);
  if ("response" in auth) return auth.response;
  const parsed = pairsLinkCreateBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { tickerA, tickerB, relationType, note } = parsed.data;
  const link = await prisma.pairCuratedLink.create({
    data: { tickerA, tickerB, relationType, note: note ?? null, curatedBy: auth.user.email },
  });
  return NextResponse.json({ id: link.id }, { status: 201 });
}

/** Admin — patch a curated link (any subset of fields). */
export async function PATCH(req: NextRequest) {
  const auth = await resolveAdminOrResponse(req);
  if ("response" in auth) return auth.response;
  const parsed = pairsLinkPatchBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { id, ...rest } = parsed.data;
  await prisma.pairCuratedLink.update({ where: { id }, data: { ...rest, curatedBy: auth.user.email } });
  return NextResponse.json({ ok: true });
}

/** Admin — delete a curated link (and its read-through history via cascade). */
export async function DELETE(req: NextRequest) {
  const auth = await resolveAdminOrResponse(req);
  if ("response" in auth) return auth.response;
  const parsed = pairsLinkDeleteBody.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  await prisma.pairLinkReadThrough.deleteMany({ where: { linkId: parsed.data.id } });
  await prisma.pairCuratedLink.delete({ where: { id: parsed.data.id } });
  return NextResponse.json({ ok: true });
}
