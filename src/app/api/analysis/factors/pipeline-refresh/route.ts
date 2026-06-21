import { NextResponse } from "next/server";
import { refreshFactorPipeline } from "@/server/services/factor-pipeline.service";
import { refreshMacroFactorPipeline } from "@/server/services/factor-pipeline-macro.service";
import { requireAdminGuard } from "@/lib/api/guards";

// Generous budget — the AQR XLSX is ~30MB, Yahoo fetches 12 ETFs, and we run
// upserts row-by-row. Plenty of headroom on the typical few-minute refresh.
export const maxDuration = 600;

export async function POST(req: Request) {
  const adminGuard = await requireAdminGuard(req);
  if (adminGuard) return adminGuard;
  try {
    // Run both pipelines in parallel. Each is independent (different factor
    // codes) so a failure in one does not block the other.
    const [ff, macro] = await Promise.allSettled([
      refreshFactorPipeline(),
      refreshMacroFactorPipeline(),
    ]);

    return NextResponse.json({
      ff: ff.status === "fulfilled" ? ff.value : { error: (ff.reason as Error).message },
      macro: macro.status === "fulfilled" ? macro.value : { error: (macro.reason as Error).message },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
