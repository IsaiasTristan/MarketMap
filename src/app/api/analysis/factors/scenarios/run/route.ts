/**
 * POST /api/analysis/factors/scenarios/run
 * Run a factor stress scenario against the portfolio's current exposures.
 */
import { NextRequest, NextResponse } from "next/server";
import { factorScenarioRunBody } from "@/lib/api/schemas";
import { runScenario, getSensitivityTable } from "@/server/services/factor-scenarios.service";
import { requirePortfolioAccess } from "@/lib/api/guards";
import type { ModelPresetName } from "@/types/factors";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = factorScenarioRunBody.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { portfolioId, model, window: win, scenarioKey, customShocks } = parsed.data;

  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  if (!scenarioKey && !customShocks?.length) {
    return NextResponse.json(
      { error: "Provide scenarioKey or customShocks." },
      { status: 400 },
    );
  }

  const [result, sensitivity] = await Promise.all([
    runScenario(portfolioId, model as ModelPresetName, win, scenarioKey ?? "custom", customShocks),
    getSensitivityTable(portfolioId, model as ModelPresetName, win),
  ]);

  if (!result) {
    return NextResponse.json(
      { error: "INSUFFICIENT_DATA", reason: "Not enough data to compute portfolio exposures." },
      { status: 422 },
    );
  }

  return NextResponse.json({ result, sensitivity });
}
