import { NextResponse } from "next/server";
import { getPairValidation } from "@/server/services/pairs/pairs-validation.service";

export const maxDuration = 60;

/** Pooled Validation event study — cached blob, computes on a cold miss. */
export async function GET() {
  const payload = await getPairValidation();
  if (!payload) {
    return NextResponse.json({ error: "NO_DATA", reason: "No pair snapshots yet. Run job:pairs-backfill." }, { status: 404 });
  }
  return NextResponse.json(payload);
}
