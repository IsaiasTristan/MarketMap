import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";

export const dynamic = "force-dynamic";

export async function GET() {
  const started = Date.now();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({
      ok: true,
      database: "connected",
      ms: Date.now() - started,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        database: "unreachable",
        ms: Date.now() - started,
        error: e instanceof Error ? e.message : "unknown error",
      },
      { status: 503 }
    );
  }
}
