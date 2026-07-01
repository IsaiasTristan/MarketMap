import { NextResponse, type NextRequest } from "next/server";
import { requireAdminGuard } from "@/lib/api/guards";
import { flowsFundCreateBody } from "@/lib/api/schemas";
import { createFund, listFunds } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

/** List the editable watchlist. Readable by any authenticated user. */
export async function GET() {
  const funds = await listFunds();
  return NextResponse.json({ funds });
}

/** Append a fund to the watchlist (admin only). */
export async function POST(req: NextRequest) {
  const guard = await requireAdminGuard(req);
  if (guard) return guard;
  const parsed = flowsFundCreateBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  try {
    const created = await createFund(parsed.data);
    return NextResponse.json(created, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const conflict = /unique|P2002/i.test(msg);
    return NextResponse.json({ error: conflict ? "DUPLICATE_CIK" : "CREATE_FAILED", reason: msg }, { status: conflict ? 409 : 500 });
  }
}
