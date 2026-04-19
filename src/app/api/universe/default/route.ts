import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import { getOrCreateDefaultUniverse } from "@/server/services/universe.service";
import { ensureBenchmarksSeeded } from "@/server/services/benchmark-seed.service";

export async function GET() {
  try {
    await ensureBenchmarksSeeded(prisma);
  } catch {
    // Benchmarks seeding is best-effort; ingest actions can retry.
  }
  const u = await getOrCreateDefaultUniverse(prisma);
  return NextResponse.json({
    id: u.id,
    name: u.name,
    constituentCount: u.constituentCount,
  });
}
