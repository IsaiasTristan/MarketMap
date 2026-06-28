import { NextResponse } from "next/server";
import { requireAdminGuard } from "@/lib/api/guards";
import { fundamentalsIngestBody } from "@/lib/api/schemas";
import { runFundamentalWeekly } from "@/server/services/fundamental/fundamental-weekly-job.service";
import { scoreFundamentalWeek } from "@/server/services/fundamental/fundamental-scoring.service";

// Heavy: full-universe FMP statement pull. Prefer the scheduled CLI
// (npm run job:fundamental) for routine runs; this is an admin convenience.
export const maxDuration = 800;

export async function POST(req: Request) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;

  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    // empty body is fine — defaults apply
  }
  const parsed = fundamentalsIngestBody.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const ingest = await runFundamentalWeekly(parsed.data);
    const scoring =
      ingest.snapshotsWritten > 0 ? await scoreFundamentalWeek({ snapshotDate: ingest.snapshotDate }) : null;
    return NextResponse.json({ ingest, scoring });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
