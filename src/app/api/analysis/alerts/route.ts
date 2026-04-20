import { NextResponse } from "next/server";
import { getAlerts, generateAlerts, dismissAlert } from "@/server/services/alerts.service";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const portfolioId = searchParams.get("portfolioId");
  const alerts = await getAlerts(false);
  return NextResponse.json(alerts);
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => ({}));
  const { action, id, portfolioId } = body;

  if (action === "dismiss" && id) {
    await dismissAlert(id);
    return NextResponse.json({ ok: true });
  }

  if (action === "generate" && portfolioId) {
    await generateAlerts(portfolioId);
    return NextResponse.json({ ok: true });
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
