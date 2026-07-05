import { NextResponse } from "next/server";
import { requireAdminGuard } from "@/lib/api/guards";
import { researchIngestBody } from "@/lib/api/schemas";
import { runRevisionPipeline } from "@/server/services/revision/revision-weekly-job.service";

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
    const pipeline = await runRevisionPipeline(parsed.data);
    return NextResponse.json(pipeline);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
