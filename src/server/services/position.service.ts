/**
 * position.service â€” lot-based portfolio positions for the analysis dashboard.
 *
 * Responsibilities:
 *  - CSV upload (papaparse): validate 4 required columns, upsert Security rows,
 *    write PortfolioPosition lots, optionally backfill sector/currency from Yahoo.
 *  - Manual CRUD (add / edit / delete individual positions).
 *  - Demo portfolio seeder.
 *  - Never performs HTTP I/O unless explicitly asked (backfill flag).
 */

import Papa from "papaparse";
import { prisma as db } from "@/infrastructure/db/client";
import { fetchYahooFundamentals } from "@/infrastructure/providers/yahoo-fundamentals";
import { writeAuditLog } from "./audit.service";

// â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export interface PositionInput {
  ticker: string;
  shares: number;
  entryPrice: number;
  entryDate: string; // ISO YYYY-MM-DD
  sector?: string;
  currency?: string;
  notes?: string;
}

export interface PositionRow {
  id: string;
  ticker: string;
  name: string;
  shares: number;
  entryPrice: number;
  entryDate: string;
  sector: string | null;
  currency: string | null;
  notes: string | null;
  closedAt: string | null;
  exitPrice: number | null;
}

// â”€â”€ CSV Parsing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const REQUIRED_COLS = ["ticker", "shares", "entry_price", "entry_date"];
const COL_ALIASES: Record<string, string> = {
  symbol: "ticker",
  "entry price": "entry_price",
  "entry date": "entry_date",
  entryprice: "entry_price",
  entrydate: "entry_date",
  quantity: "shares",
};

function normalizeHeader(h: string): string {
  const lower = h.toLowerCase().trim().replace(/\s+/g, "_");
  return COL_ALIASES[lower.replace(/_/g, " ")] ?? lower;
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
    const entryPrice = parseFloat(row.entry_price);
    const entryDate = row.entry_date?.trim();

    if (!ticker) {
      errors.push(`Row ${i + 2}: missing ticker`);
      continue;
    }
    if (isNaN(shares) || shares <= 0) {
      errors.push(`Row ${i + 2} (${ticker}): invalid shares`);
      continue;
    }
    if (isNaN(entryPrice) || entryPrice <= 0) {
      errors.push(`Row ${i + 2} (${ticker}): invalid entry_price`);
      continue;
    }
    if (!entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
      errors.push(
        `Row ${i + 2} (${ticker}): entry_date must be YYYY-MM-DD, got: ${entryDate}`,
      );
      continue;
    }

    rows.push({
      ticker,
      shares,
      entryPrice,
      entryDate,
      sector: row.sector?.trim() || undefined,
      currency: row.currency?.trim() || "USD",
      notes: row.notes?.trim() || undefined,
    });
  }

  return { rows, errors, columnMap };
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€ Write positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      let currency = pos.currency ?? "USD";

      if (backfillProfile && !sector) {
        try {
          const fund = await fetchYahooFundamentals(pos.ticker);
          sector = fund.sector ?? sector;
          currency = fund.currency ?? currency;
          // Backfill Security profile
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

      await db.portfolioPosition.create({
        data: {
          portfolioId,
          securityId: secId,
          shares: pos.shares,
          entryPrice: pos.entryPrice,
          entryDate: new Date(pos.entryDate),
          sector: sector ?? null,
          currency,
          notes: pos.notes ?? null,
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

// â”€â”€ Read positions â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export async function getPositions(
  portfolioId: string,
  includeClosedAfter?: string,
): Promise<PositionRow[]> {
  const rows = await db.portfolioPosition.findMany({
    where: {
      portfolioId,
      closedAt: includeClosedAfter
        ? { gte: new Date(includeClosedAfter) }
        : null, // open only
    },
    include: { security: true },
    orderBy: { entryDate: "asc" },
  });

  return rows.map((r) => ({
    id: r.id,
    ticker: r.security.ticker,
    name: r.security.name,
    shares: Number(r.shares),
    entryPrice: Number(r.entryPrice),
    entryDate: r.entryDate.toISOString().slice(0, 10),
    sector: r.sector ?? r.security.sector ?? null,
    currency: r.currency ?? null,
    notes: r.notes ?? null,
    closedAt: r.closedAt?.toISOString().slice(0, 10) ?? null,
    exitPrice: r.exitPrice != null ? Number(r.exitPrice) : null,
  }));
}

export async function addPosition(
  portfolioId: string,
  input: PositionInput,
): Promise<string> {
  const secId = await upsertSecurity(input.ticker);
  const pos = await db.portfolioPosition.create({
    data: {
      portfolioId,
      securityId: secId,
      shares: input.shares,
      entryPrice: input.entryPrice,
      entryDate: new Date(input.entryDate),
      sector: input.sector ?? null,
      currency: input.currency ?? "USD",
      notes: input.notes ?? null,
    },
  });
  await writeAuditLog("position.add", { portfolioId, ticker: input.ticker });
  return pos.id;
}


export interface PositionUpdateInput {
  shares?: number;
  entryPrice?: number;
  entryDate?: string;
  sector?: string | null;
  currency?: string;
  notes?: string | null;
}

export async function updatePosition(
  id: string,
  input: PositionUpdateInput,
): Promise<void> {
  await db.portfolioPosition.update({
    where: { id },
    data: {
      ...(input.shares !== undefined && { shares: input.shares }),
      ...(input.entryPrice !== undefined && { entryPrice: input.entryPrice }),
      ...(input.entryDate !== undefined && { entryDate: new Date(input.entryDate) }),
      ...(input.sector !== undefined && { sector: input.sector }),
      ...(input.currency !== undefined && { currency: input.currency }),
      ...(input.notes !== undefined && { notes: input.notes }),
    },
  });
  await writeAuditLog("position.update", { id, ...input });
}
export async function deletePosition(id: string): Promise<void> {
  await db.portfolioPosition.delete({ where: { id } });
  await writeAuditLog("position.delete", { id });
}

export async function closePosition(
  id: string,
  exitPrice: number,
  closedAt: string,
): Promise<void> {
  await db.portfolioPosition.update({
    where: { id },
    data: { exitPrice, closedAt: new Date(closedAt) },
  });
  await writeAuditLog("position.close", { id, exitPrice, closedAt });
}

// â”€â”€ Demo Portfolio â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const DEMO_POSITIONS: PositionInput[] = [
  { ticker: "AAPL", shares: 50, entryPrice: 165.0, entryDate: "2023-01-15", sector: "Technology" },
  { ticker: "MSFT", shares: 30, entryPrice: 235.0, entryDate: "2023-01-15", sector: "Technology" },
  { ticker: "NVDA", shares: 20, entryPrice: 175.0, entryDate: "2023-03-01", sector: "Technology" },
  { ticker: "GOOGL", shares: 40, entryPrice: 95.0, entryDate: "2023-02-01", sector: "Communication Services" },
  { ticker: "META", shares: 25, entryPrice: 145.0, entryDate: "2023-02-01", sector: "Communication Services" },
  { ticker: "AMZN", shares: 35, entryPrice: 100.0, entryDate: "2023-01-20", sector: "Consumer Discretionary" },
  { ticker: "JPM", shares: 45, entryPrice: 125.0, entryDate: "2023-02-15", sector: "Financials" },
  { ticker: "BAC", shares: 100, entryPrice: 33.0, entryDate: "2023-03-01", sector: "Financials" },
  { ticker: "JNJ", shares: 30, entryPrice: 165.0, entryDate: "2023-01-15", sector: "Health Care" },
  { ticker: "UNH", shares: 12, entryPrice: 490.0, entryDate: "2023-02-01", sector: "Health Care" },
  { ticker: "XOM", shares: 40, entryPrice: 110.0, entryDate: "2023-01-25", sector: "Energy" },
  { ticker: "CVX", shares: 25, entryPrice: 165.0, entryDate: "2023-02-10", sector: "Energy" },
  { ticker: "PG", shares: 30, entryPrice: 140.0, entryDate: "2023-01-15", sector: "Consumer Staples" },
  { ticker: "KO", shares: 60, entryPrice: 60.0, entryDate: "2023-03-01", sector: "Consumer Staples" },
  { ticker: "NEE", shares: 35, entryPrice: 75.0, entryDate: "2023-02-20", sector: "Utilities" },
];

export async function seedDemoPortfolio(portfolioId: string): Promise<number> {
  // Wipe existing positions
  await db.portfolioPosition.deleteMany({ where: { portfolioId } });

  const { imported } = await importPositions(portfolioId, DEMO_POSITIONS, false);
  await writeAuditLog("portfolio.demo_loaded", { portfolioId });
  return imported;
}

