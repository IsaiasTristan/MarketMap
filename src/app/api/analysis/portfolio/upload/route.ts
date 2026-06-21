import { NextResponse } from "next/server";
import { parseCsv, importPositions } from "@/server/services/position.service";
import { requirePortfolioAccess } from "@/lib/api/guards";

export const maxDuration = 60;

export async function POST(req: Request) {
  const formData = await req.formData().catch(() => null);
  if (!formData) return NextResponse.json({ error: "multipart required" }, { status: 400 });

  const portfolioId = String(formData.get("portfolioId") ?? "");
  if (!portfolioId) return NextResponse.json({ error: "portfolioId required" }, { status: 400 });
  const guard = await requirePortfolioAccess(req, portfolioId);
  if (guard) return guard;

  const file = formData.get("file");
  let csvText: string;
  if (file && typeof file === "object" && "text" in file) {
    csvText = await (file as File).text();
  } else if (typeof file === "string") {
    csvText = file;
  } else {
    return NextResponse.json({ error: "file required" }, { status: 400 });
  }

  const { rows, errors: parseErrors, columnMap } = parseCsv(csvText);

  if (parseErrors.length && rows.length === 0) {
    return NextResponse.json({ error: parseErrors.join("; "), columnMap }, { status: 422 });
  }

  const { imported, errors: importErrors } = await importPositions(
    portfolioId,
    rows,
    true, // backfill sector/currency from Yahoo
  );

  return NextResponse.json({
    imported,
    parseErrors,
    importErrors,
    columnMap,
  });
}
