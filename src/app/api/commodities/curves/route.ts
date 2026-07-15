import { NextResponse } from "next/server";
import { resolveUserOrResponse } from "@/lib/api/guards";
import { getCurveRegistry } from "@/server/services/commodities.service";

export async function GET(req: Request) {
  const auth = await resolveUserOrResponse(req);
  if ("response" in auth) return auth.response;
  try {
    const curves = await getCurveRegistry();
    return NextResponse.json({ curves });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}
