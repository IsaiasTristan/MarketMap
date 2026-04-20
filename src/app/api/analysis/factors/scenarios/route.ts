/**
 * GET /api/analysis/factors/scenarios
 * Lists available scenario presets.
 */
import { NextResponse } from "next/server";
import { listScenarios } from "@/server/services/factor-scenarios.service";

export async function GET() {
  return NextResponse.json(listScenarios());
}
