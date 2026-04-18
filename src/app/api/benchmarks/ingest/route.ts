import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { ingestAllBenchmarks } from "@/server/services/ingest-universe.service";

export async function POST() {
  try {
    const r = await ingestAllBenchmarks(prisma, 10);
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
