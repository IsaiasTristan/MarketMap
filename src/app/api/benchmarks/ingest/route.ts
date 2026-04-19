import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { ingestAllBenchmarks } from "@/server/services/ingest-universe.service";

export async function POST(req: Request) {
  const url = new URL(req.url);
  const onlyMissing = url.searchParams.get("onlyMissing") === "true";
  try {
    const r = await ingestAllBenchmarks(prisma, 10, { onlyMissing });
    return NextResponse.json({ ok: true, onlyMissing, ...r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
