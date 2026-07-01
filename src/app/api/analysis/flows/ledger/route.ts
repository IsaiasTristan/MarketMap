import { NextResponse, type NextRequest } from "next/server";
import { flowsLedgerQuery } from "@/lib/api/schemas";
import { getLedger } from "@/server/services/institutional/institutional-query.service";

export const maxDuration = 30;

export async function GET(req: NextRequest) {
  const parsed = flowsLedgerQuery.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const result = await getLedger(parsed.data.ticker, parsed.data.period);
  if (!result || result.rows.length === 0) {
    return NextResponse.json(
      { error: "NO_DATA", reason: `No tracked funds hold ${parsed.data.ticker} in this period.` },
      { status: 404 },
    );
  }
  return NextResponse.json(result);
}
