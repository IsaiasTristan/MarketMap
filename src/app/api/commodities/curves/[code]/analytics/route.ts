import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { commoditiesAnalyticsQuery } from "@/lib/api/schemas";
import { getCurveAnalytics } from "@/server/services/commodities.service";

export async function GET(req: Request, ctx: { params: Promise<{ code: string }> }) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const { code } = await ctx.params;

  const url = new URL(req.url);
  const parsed = commoditiesAnalyticsQuery.safeParse({
    basisMode: url.searchParams.get("basisMode") ?? undefined,
  });
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const dto = await getCurveAnalytics(code.toUpperCase(), parsed.data.basisMode);
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
