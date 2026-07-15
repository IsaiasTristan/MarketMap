import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { commoditiesExportBody } from "@/lib/api/schemas";
import { buildExportTable } from "@/server/services/commodities.service";

/**
 * Futures-only wide export: one row per contract month, one column per curve,
 * headers `NAME [BASIS] (UNIT) M/D/YY`. Never includes history rows — the
 * hist+fut copy lives in the curve-data modal client-side.
 */
export async function POST(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  const parsed = commoditiesExportBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }
  const { setId, curveCodes, vintageId, basisMode } = parsed.data;

  let codes = (curveCodes ?? []).map((c) => c.toUpperCase());
  if (codes.length === 0 && setId) {
    const set = await prisma.curveSet.findFirst({
      where: { id: setId, userId: auth.user.id },
      include: { items: { include: { curve: { select: { code: true } } }, orderBy: { sortOrder: "asc" } } },
    });
    if (!set) return NextResponse.json({ error: "Curve set not found" }, { status: 404 });
    codes = set.items.map((i) => i.curve.code);
  }
  if (codes.length === 0) {
    return NextResponse.json({ error: "curveCodes or setId required" }, { status: 400 });
  }

  const table = await buildExportTable(codes, vintageId, basisMode);
  if (!table) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "no snapshots for the requested curves/vintage" },
      { status: 404 },
    );
  }
  return NextResponse.json(table);
}
