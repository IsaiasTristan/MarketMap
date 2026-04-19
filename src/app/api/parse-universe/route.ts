import { NextResponse } from "next/server";
import { parseUniverseBody } from "@/lib/api/schemas";
import {
  parsePastedUniverse,
  parseUniverseCsv,
} from "@/domain/universe/parse";

export async function POST(req: Request) {
  const json = await req.json().catch(() => null);
  const parsed = parseUniverseBody.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, errors: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const format =
    parsed.data.format ?? detectFormat(parsed.data.text);
  const result =
    format === "csv"
      ? parseUniverseCsv(parsed.data.text)
      : parsePastedUniverse(parsed.data.text);
  if (!result.ok) {
    return NextResponse.json({ ok: false, errors: result.errors }, { status: 400 });
  }
  return NextResponse.json({ ok: true, rows: result.rows, format });
}

function detectFormat(text: string): "paste" | "csv" {
  const firstLine =
    text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  if (firstLine.includes("\t")) return "paste";
  const commas = (firstLine.match(/,/g) ?? []).length;
  if (commas >= 2) return "csv";
  return "paste";
}
