/**
 * price-decks.service — per-user price-deck presets + 360-month expansion.
 * Deck math lives in lib/commodities/decks (pure); this service owns
 * ownership-scoped CRUD and feeding the expansion with the latest strip.
 * Decks apply to flat prices only — expansion of a basis differential
 * returns the typed BASIS_NOT_ALLOWED error from expandDeck.
 */
import type { PriceDeck } from "@prisma/client";
import { prisma } from "@/infrastructure/db/client";
import { expandDeck } from "@/lib/commodities/decks";
import { toOutright } from "@/lib/commodities/outright";
import type { DeckExpansionResult, PriceDeckDto } from "@/types/commodities";

function toDto(d: PriceDeck): PriceDeckDto {
  return {
    id: d.id,
    name: d.name,
    stripMonths: d.stripMonths,
    terminalRule: d.terminalRule,
    terminalValueOil: d.terminalValueOil,
    terminalValueGas: d.terminalValueGas,
    terminalValueNgl: d.terminalValueNgl,
    escalationPctPerYear: d.escalationPctPerYear,
    haircutPct: d.haircutPct,
    horizonMonths: d.horizonMonths,
  };
}

export interface PriceDeckInput {
  name: string;
  stripMonths: number;
  terminalRule: "FLAT" | "STRIP_AVG" | "TRAILING_STRIP_AVG" | "ESCALATE";
  terminalValueOil?: number | null;
  terminalValueGas?: number | null;
  terminalValueNgl?: number | null;
  escalationPctPerYear?: number | null;
  haircutPct?: number | null;
  horizonMonths?: number;
}

export async function listPriceDecks(userId: string): Promise<PriceDeckDto[]> {
  const decks = await prisma.priceDeck.findMany({
    where: { userId },
    orderBy: { createdAt: "asc" },
  });
  return decks.map(toDto);
}

export async function createPriceDeck(userId: string, input: PriceDeckInput): Promise<PriceDeckDto> {
  const deck = await prisma.priceDeck.create({
    data: {
      userId,
      name: input.name,
      stripMonths: input.stripMonths,
      terminalRule: input.terminalRule,
      terminalValueOil: input.terminalValueOil ?? null,
      terminalValueGas: input.terminalValueGas ?? null,
      terminalValueNgl: input.terminalValueNgl ?? null,
      escalationPctPerYear: input.escalationPctPerYear ?? null,
      haircutPct: input.haircutPct ?? null,
      horizonMonths: input.horizonMonths ?? 360,
    },
  });
  return toDto(deck);
}

/** Returns null when the deck doesn't exist or belongs to someone else. */
export async function updatePriceDeck(
  userId: string,
  deckId: string,
  patch: Partial<PriceDeckInput>,
): Promise<PriceDeckDto | null> {
  const owned = await prisma.priceDeck.findFirst({ where: { id: deckId, userId }, select: { id: true } });
  if (!owned) return null;
  const deck = await prisma.priceDeck.update({ where: { id: deckId }, data: patch });
  return toDto(deck);
}

export async function deletePriceDeck(userId: string, deckId: string): Promise<boolean> {
  const owned = await prisma.priceDeck.findFirst({ where: { id: deckId, userId }, select: { id: true } });
  if (!owned) return false;
  await prisma.priceDeck.delete({ where: { id: deckId } });
  return true;
}

/**
 * Expand a deck against a curve's latest strip. Not-found and ownership
 * failures return null; domain-level rejections (basis differential, no
 * strip, missing terminal value) come back as the typed error from
 * expandDeck. Decks never apply to a differential: a BASIS curve in DIFF
 * mode is rejected, and in OUT mode the deck expands against the outright
 * strip (bench + basis, aligned by contract month).
 */
export async function expandPriceDeck(
  userId: string,
  deckId: string,
  curveCode: string,
  basisMode: "DIFF" | "OUT" = "DIFF",
): Promise<{ deck: PriceDeckDto; result: DeckExpansionResult } | null> {
  const deck = await prisma.priceDeck.findFirst({ where: { id: deckId, userId } });
  if (!deck) return null;
  const curve = await prisma.commodityCurve.findUnique({
    where: { code: curveCode },
    include: { benchCurve: { select: { id: true } } },
  });
  if (!curve) return null;
  const latest = await prisma.futuresCurveSnapshot.findFirst({
    where: { curveId: curve.id },
    orderBy: { settleDate: "desc" },
    select: { settleDate: true, points: true },
  });
  let points = Array.isArray(latest?.points) ? (latest.points as { contractMonth: string; price: number }[]) : [];

  const basisModeIsDiff = curve.kind === "BASIS" && basisMode === "DIFF";
  if (curve.kind === "BASIS" && basisMode === "OUT" && curve.benchCurve && latest) {
    const bench = await prisma.futuresCurveSnapshot.findFirst({
      where: { curveId: curve.benchCurve.id, settleDate: { lte: latest.settleDate } },
      orderBy: { settleDate: "desc" },
      select: { points: true },
    });
    const benchPoints = Array.isArray(bench?.points)
      ? (bench.points as { contractMonth: string; price: number }[])
      : [];
    points = toOutright(points, benchPoints);
  }

  const result = expandDeck(toDto(deck), points, { kind: curve.kind, group: curve.group }, basisModeIsDiff);
  return { deck: toDto(deck), result };
}
