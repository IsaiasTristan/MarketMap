import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { commoditiesVintagesQuery } from "@/lib/api/schemas";
import { getCurveVintages } from "@/server/services/commodities.service";

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { code } = await ctx.params;

  const url = new URL(req.url);
  const parsed = commoditiesVintagesQuery.safeParse({
    ids: url.searchParams.get("ids") ?? undefined,
    basisMode: url.searchParams.get("basisMode") ?? undefined,
    history: url.searchParams.get("history") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const dto = await getCurveVintages(code.toUpperCase(), parsed.data);
    if (!dto) {
      return NextResponse.json(
        { error: "NO_DATA", reason: `no snapshots for curve ${code} yet — ingest accruing` },
        { status: 404 },
      );
    }
    return NextResponse.json(dto);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
