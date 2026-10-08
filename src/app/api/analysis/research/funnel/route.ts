import { NextResponse } from "next/server";
import { getFunnelValidation } from "@/server/services/revision/revision-funnel.service";

export const maxDuration = 120;

export async function GET() {
  const payload = await getFunnelValidation();
  if (!payload) {
    return NextResponse.json(
      { error: "NO_DATA", reason: "No screen-row grid yet. Run job:revision-screen-rows." },
      { status: 404 },
    );
  }
  return NextResponse.json(payload);
}
