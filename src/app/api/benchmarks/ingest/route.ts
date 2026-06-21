import { NextResponse } from "next/server";
import { prisma } from "@/infrastructure/db/client";
import {
  ingestAllBenchmarks,
  refreshBenchmarksTail,
} from "@/server/services/ingest-universe.service";
import { requireAdminGuard } from "@/lib/api/guards";

type Mode = "missing" | "tail" | "all";

function resolveMode(url: URL): Mode {
  const m = url.searchParams.get("mode");
  if (m === "missing" || m === "tail" || m === "all") return m;
  if (url.searchParams.get("onlyMissing") === "true") return "missing";
  return "all";
}

export async function POST(req: Request) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  const url = new URL(req.url);
  const mode = resolveMode(url);
  const tailDays = Math.max(
    1,
    Number(url.searchParams.get("days") ?? "") || 10
  );
  try {
    if (mode === "tail") {
      const r = await refreshBenchmarksTail(prisma, tailDays);
      return NextResponse.json({ ok: true, mode, tailDays, ...r });
    }
    const r = await ingestAllBenchmarks(prisma, 10, {
      onlyMissing: mode === "missing",
    });
    return NextResponse.json({ ok: true, mode, ...r });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
