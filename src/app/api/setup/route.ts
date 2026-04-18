import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";

/** One-time / dev: create Benchmark rows (no prices). */
export async function POST() {
  try {
    await ensureBenchmarksSeeded(prisma);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 503 }
    );
  }
}
