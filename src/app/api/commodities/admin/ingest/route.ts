import { NextResponse } from "next/server";
import { requireAdminGuard } from "@/lib/api/guards";
import { commoditiesIngestBody } from "@/lib/api/schemas";
import { runCommoditiesDailyPrecomputeLocked } from "@/server/services/commodities-daily-precompute.service";

export const maxDuration = 600;
export const dynamic = "force-dynamic";

/** Admin: trigger the AEGIS curve sweep (optionally forcing the 1Y backfill). */
export async function POST(req: Request) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;
  const parsed = commoditiesIngestBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, errors: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const outcome = await runCommoditiesDailyPrecomputeLocked({
      forceBackfill: parsed.data.backfill,
    });
    if (outcome.deduped) {
      return NextResponse.json({ deduped: true }, { status: 202 });
    }
    const summary = outcome.summary!;
    const status = summary.authFailed ? 502 : 200;
    return NextResponse.json({ deduped: false, summary }, { status });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
