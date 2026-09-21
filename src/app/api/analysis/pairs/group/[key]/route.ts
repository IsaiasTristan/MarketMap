import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPairGroup } from "@/server/services/pairs/pairs-read.service";

export const maxDuration = 30;

const query = z.object({
  weighting: z.enum(["EQUAL", "CAP"]).optional().default("EQUAL"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export async function GET(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const parsed = query.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const payload = await getPairGroup(decodeURIComponent(key), parsed.data.weighting, parsed.data.date);
  if (!payload) return NextResponse.json({ error: "NO_DATA" }, { status: 404 });
  return NextResponse.json(payload);
}
