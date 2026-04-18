import { NextResponse } from "next/server";
import { parseUniverseBody } from "@/lib/api/schemas";
import { parsePastedUniverse } from "@/domain/universe/parse";

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = parseUniverseBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const result = parsePastedUniverse(parsed.data.text);
  if (!result.ok) {
    return NextResponse.json({ ok: false, errors: result.errors }, { status: 400 });
  }
  return NextResponse.json({ ok: true, rows: result.rows });
}
