import { NextResponse, type NextRequest } from "next/server";
import { requireAdminGuard } from "@/lib/api/guards";
import { flowsIngestBody } from "@/lib/api/schemas";
import { runInstitutionalIngest } from "@/server/services/institutional/institutional-ingest.service";
import { runInstitutionalAggregate } from "@/server/services/institutional/institutional-aggregate.service";

// Long-running: a full backfill hits many FMP endpoints. For large backfills
// prefer the CLI job (npm run job:institutional); this route defaults to a
// light "refresh" of the latest quarters.
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;
  const parsed = flowsIngestBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const { mode } = parsed.data;
  const log = (m: string) => console.log(m);
  const summary: Record<string, unknown> = { mode };

  try {
    if (mode !== "aggregate") {
      const quarters = parsed.data.quarters ?? (mode === "full" ? 12 : 2);
      summary.ingest = await runInstitutionalIngest({ quarters, log });
    }
    summary.aggregate = await runInstitutionalAggregate({ log });
    return NextResponse.json(summary);
  } catch (e) {
    return NextResponse.json(
      { error: "INGEST_FAILED", reason: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
