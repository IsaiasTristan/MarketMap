/**
 * position.service — portfolio positions for the analysis dashboard.
 *
 * Simplified data model (2026-04-26): users supply only ticker + shares +
 * long/short direction. Weights are derived at read time from
 * shares × current price (see loadPortfolioWeights in portfolio.service).
 *
 * Responsibilities:
 *  - CSV upload (papaparse): validate ticker / shares / direction, upsert
 *    Security rows, write PortfolioPosition rows.
 *  - Manual CRUD (add / edit / delete individual positions).
 *  - Demo portfolio seeder.
 */

import Papa from "papaparse";
import { prisma as db } from "@/infrastructure/db/client";
import { fetchYahooFundamentals } from "@/infrastructure/providers/yahoo-fundamentals";
import { writeAuditLog } from "./audit.service";

// ── Types ────────────────────────────────────────────────────────────────

export interface PositionInput {
  ticker: string;
  shares: number;
  isShort?: boolean;
  sector?: string;
}

export interface PositionRow {
  id: string;
  ticker: string;
  name: string;
  shares: number;
  isShort: boolean;
  sector: string | null;
}

// ── CSV Parsing ──────────────────────────────────────────────────────────

const REQUIRED_COLS = ["ticker", "shares"];
const COL_ALIASES: Record<string, string> = {
  symbol: "ticker",
  quantity: "shares",
  side: "direction",
  position: "direction",
  long_short: "direction",
  "long short": "direction",
  ls: "direction",
};

function normalizeHeader(h: string): string {
  const lower = h.toLowerCase().trim().replace(/\s+/g, "_");
  return COL_ALIASES[lower.replace(/_/g, " ")] ?? lower;
}

/**
 * Parse a direction cell ("L", "S", "long", "short", "+", "-") into the
 * isShort flag. Empty / unrecognized → long (default).
 */
function parseDirection(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toUpperCase();
  if (v === "S" || v === "SHORT" || v === "-") return true;
  return false;
}

export function parseCsv(csvText: string): {
  rows: PositionInput[];
  errors: string[];
  columnMap: Record<string, string>;
} {
  const result = Papa.parse<Record<string, string>>(csvText, {
    header: true,
    skipEmptyLines: true,
    transformHeader: normalizeHeader,
  });

  const headers = result.meta.fields ?? [];
  const columnMap: Record<string, string> = {};
  for (const h of headers) columnMap[h] = h;

  const missing = REQUIRED_COLS.filter((c) => !headers.includes(c));
  if (missing.length > 0) {
    return {
      rows: [],
      errors: [`Missing required columns: ${missing.join(", ")}`],
      columnMap,
    };
  }

  const rows: PositionInput[] = [];
  const errors: string[] = [];

  for (let i = 0; i < result.data.length; i++) {
    const row = result.data[i];
    const ticker = row.ticker?.trim().toUpperCase();
    const shares = parseFloat(row.shares);

    if (!ticker) {
      errors.push(`Row ${i + 2}: missing ticker`);
      continue;
    }
    if (isNaN(shares) || shares <= 0) {
      errors.push(`Row ${i + 2} (${ticker}): invalid shares`);
      continue;
    }

    rows.push({
      ticker,
      shares,
      isShort: parseDirection(row.direction),
      sector: row.sector?.trim() || undefined,
    });
  }

  return { rows, errors, columnMap };
}

// ── Helpers ──────────────────────────────────────────────────────────────

async function upsertSecurity(
  ticker: string,
  name?: string,
): Promise<string> {
  const existing = await db.security.findUnique({ where: { ticker } });
  if (existing) return existing.id;
  const sec = await db.security.create({
    data: { ticker, name: name ?? ticker },
  });
  return sec.id;
}

// ── Write positions ──────────────────────────────────────────────────────

export async function importPositions(
  portfolioId: string,
  inputs: PositionInput[],
  backfillProfile = false,
): Promise<{ imported: number; errors: string[] }> {
  const errors: string[] = [];
  let imported = 0;

  for (const pos of inputs) {
    try {
      let sector = pos.sector;

      if (backfillProfile && !sector) {
        try {
          const fund = await fetchYahooFundamentals(pos.ticker);
          sector = fund.sector ?? sector;
          await db.security.updateMany({
            where: { ticker: pos.ticker },
            data: {
              sector: fund.sector ?? undefined,
              country: fund.country ?? undefined,
              currency: fund.currency ?? undefined,
            },
          });
        } catch {
          // profile backfill is best-effort
        }
      }

      const secId = await upsertSecurity(pos.ticker);

      // Upsert so re-importing a ticker updates shares/direction rather than
      // erroring on the (portfolioId, securityId) unique constraint.
      await db.portfolioPosition.upsert({
        where: {
          portfolioId_securityId: { portfolioId, securityId: secId },
        },
        create: {
          portfolioId,
          securityId: secId,
          shares: pos.shares,
          isShort: pos.isShort ?? false,
          sector: sector ?? null,
        },
        update: {
          shares: pos.shares,
          isShort: pos.isShort ?? false,
          sector: sector ?? null,
        },
      });
      imported++;
    } catch (e) {
      errors.push(`${pos.ticker}: ${(e as Error).message}`);
    }
  }

  await writeAuditLog("position.import", {
    portfolioId,
    imported,
    errors: errors.length,
  });

  return { imported, errors };
}

/**
 * Replace ALL positions for a portfolio (used by the editor's "Save" button).
 * Wipes existing positions then writes the new set in a transaction.
 */
export async function replacePositions(
  portfolioId: string,
  inputs: PositionInput[],
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.portfolioPosition.deleteMany({ where: { portfolioId } });
    for (const pos of inputs) {
      const t = pos.ticker.trim().toUpperCase();
      const existing = await tx.security.findUnique({ where: { ticker: t } });
      const secId = existing
        ? existing.id
        : (await tx.security.create({ data: { ticker: t, name: t } })).id;
      await tx.portfolioPosition.create({
        data: {
          portfolioId,
          securityId: secId,
          shares: pos.shares,
          isShort: pos.isShort ?? false,
          sector: pos.sector ?? null,
        },
      });
    }
  });
  await writeAuditLog("position.replace", { portfolioId, count: inputs.length });
}

// ── Read positions ───────────────────────────────────────────────────────

export async function getPositions(portfolioId: string): Promise<PositionRow[]> {
  const rows = await db.portfolioPosition.findMany({
    where: { portfolioId },
    include: { security: true },
    orderBy: { createdAt: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    ticker: r.security.ticker,
    name: r.security.name,
    shares: Number(r.shares),
    isShort: r.isShort,
    sector: r.sector ?? r.security.sector ?? null,
  }));
}

export async function addPosition(
  portfolioId: string,
  input: PositionInput,
): Promise<string> {
  const secId = await upsertSecurity(input.ticker);
  const pos = await db.portfolioPosition.upsert({
    where: { portfolioId_securityId: { portfolioId, securityId: secId } },
    create: {
      portfolioId,
      securityId: secId,
      shares: input.shares,
      isShort: input.isShort ?? false,
      sector: input.sector ?? null,
    },
    update: {
      shares: input.shares,
      isShort: input.isShort ?? false,
      sector: input.sector ?? null,
    },
  });
  await writeAuditLog("position.add", { portfolioId, ticker: input.ticker });
  return pos.id;
}

export interface PositionUpdateInput {
  shares?: number;
  isShort?: boolean;
  sector?: string | null;
}

export async function updatePosition(
  id: string,
  input: PositionUpdateInput,
): Promise<void> {
  await db.portfolioPosition.update({
    where: { id },
    data: {
      ...(input.shares !== undefined && { shares: input.shares }),
      ...(input.isShort !== undefined && { isShort: input.isShort }),
      ...(input.sector !== undefined && { sector: input.sector }),
    },
  });
  await writeAuditLog("position.update", { id, ...input });
}

export async function deletePosition(id: string): Promise<void> {
  await db.portfolioPosition.delete({ where: { id } });
  await writeAuditLog("position.delete", { id });
}

// ── Demo Portfolio ───────────────────────────────────────────────────────

const DEMO_POSITIONS: PositionInput[] = [
  { ticker: "AAPL", shares: 50, sector: "Technology" },
  { ticker: "MSFT", shares: 30, sector: "Technology" },
  { ticker: "NVDA", shares: 20, sector: "Technology" },
  { ticker: "GOOGL", shares: 40, sector: "Communication Services" },
  { ticker: "META", shares: 25, sector: "Communication Services" },
  { ticker: "AMZN", shares: 35, sector: "Consumer Discretionary" },
  { ticker: "JPM", shares: 45, sector: "Financials" },
  { ticker: "BAC", shares: 100, sector: "Financials" },
  { ticker: "JNJ", shares: 30, sector: "Health Care" },
  { ticker: "UNH", shares: 12, sector: "Health Care" },
  { ticker: "XOM", shares: 40, sector: "Energy" },
  { ticker: "CVX", shares: 25, sector: "Energy" },
  { ticker: "PG", shares: 30, sector: "Consumer Staples" },
  { ticker: "KO", shares: 60, sector: "Consumer Staples" },
  { ticker: "NEE", shares: 35, sector: "Utilities" },
];

export async function seedDemoPortfolio(portfolioId: string): Promise<number> {
  await db.portfolioPosition.deleteMany({ where: { portfolioId } });
  const { imported } = await importPositions(portfolioId, DEMO_POSITIONS, false);
  await writeAuditLog("portfolio.demo_loaded", { portfolioId });
  return imported;
}
