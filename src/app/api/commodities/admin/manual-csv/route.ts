import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { parseManualCsv } from "@/infrastructure/providers/manual-csv-curve-provider";
import { requireAdminGuard } from "@/lib/api/guards";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Admin: upload basis/curve settlements as CSV (fallback path when a market
 * isn't on the AEGIS feed). Body: text/csv or multipart form with a `file`
 * field. Columns: curve_code, settle_date, contract_month, price.
 */
export async function POST(req: Request) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;

  let text: string;
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!file || typeof file === "string") {
      return NextResponse.json({ error: "multipart upload requires a `file` field" }, { status: 400 });
    }
    text = await file.text();
  } else {
    text = await req.text();
  }
  if (!text.trim()) return NextResponse.json({ error: "empty CSV body" }, { status: 400 });

  const { strips, errors } = parseManualCsv(text);
  if (strips.length === 0) {
    return NextResponse.json({ error: "no valid rows", errors }, { status: 400 });
  }

  const curves = await prisma.commodityCurve.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(curves.map((c) => [c.code, c.id]));

  let upserted = 0;
  const skipped: string[] = [];
  for (const strip of strips) {
    const curveId = idByCode.get(strip.curveCode);
    if (!curveId) {
      skipped.push(`${strip.curveCode} (unknown curve code)`);
      continue;
    }
    const settleDate = new Date(`${strip.settleDate}T00:00:00.000Z`);
    const json = strip.points as unknown as Prisma.InputJsonValue;
    await prisma.futuresCurveSnapshot.upsert({
      where: { curveId_settleDate: { curveId, settleDate } },
      create: { curveId, settleDate, points: json, source: "MANUAL_CSV" },
      update: { points: json, source: "MANUAL_CSV", computedAt: new Date() },
    });
    upserted += 1;
  }

  return NextResponse.json({ upserted, skipped, parseErrors: errors });
}
