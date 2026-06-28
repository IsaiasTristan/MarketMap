import { NextResponse } from "next/server";
import { requireAdminGuard } from "@/lib/api/guards";
import { researchIngestBody } from "@/lib/api/schemas";
import { runRevisionWeekly } from "@/server/services/revision/revision-weekly-job.service";
import { scoreRevisionWeek } from "@/server/services/revision/revision-scoring.service";

// Heavy: full-universe FMP pull + per-symbol estimates. Prefer the scheduled
// CLI (npm run job:revision) for routine runs; this is an admin convenience.
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
  const parsed = researchIngestBody.safeParse(body ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const ingest = await runRevisionWeekly(parsed.data);
    const scoring = ingest.snapshotsWritten > 0 ? await scoreRevisionWeek({ snapshotDate: ingest.snapshotDate }) : null;
    return NextResponse.json({ ingest, scoring });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
