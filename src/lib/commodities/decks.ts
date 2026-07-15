import type {
  CommodityGroupCode,
  CurveKindCode,
  CurvePoint,
  DeckExpansionResult,
  PriceDeckDto,
} from "@/types/commodities";
import { addMonths } from "./format";

/**
 * Price-deck expansion: turns a deck definition (strip window + terminal
 * rule) plus the latest strip into a month-by-month price path. Pure —
 * prices are returned raw (no rounding; the UI rounds).
 *
 * Structure of the path (months 0..horizon-1, keys continuing from the
 * strip's front month):
 *  - i < stripMonths: strip prices, extended flat at the last strip price
 *    when the deck's strip window outruns the actual strip; the optional
 *    haircut (e.g. 5 = 5% off) applies to this portion only.
 *  - i ≥ stripMonths (terminal): FLAT holds the group's terminal value;
 *    STRIP_AVG holds the average of the (haircut) strip-portion prices;
 *    ESCALATE compounds that same average by escalationPctPerYear once per
 *    whole year past the terminal start (floor((i − stripMonths) / 12)),
 *    with a null escalation treated as 0%.
 */

const DEFAULT_HORIZON_MONTHS = 360;

function terminalValueForGroup(
  deck: PriceDeckDto,
  group: CommodityGroupCode,
): number | null {
  switch (group) {
    case "OIL":
      return deck.terminalValueOil;
    case "GAS":
      return deck.terminalValueGas;
    case "NGL":
      return deck.terminalValueNgl;
  }
}

export function expandDeck(
  deck: PriceDeckDto,
  latestStrip: CurvePoint[],
  curve: { kind: CurveKindCode; group: CommodityGroupCode },
  basisModeIsDiff: boolean,
): DeckExpansionResult {
  // A differential (basis-mode) strip is not a price level — decks only make
  // sense on outrights.
  if (curve.kind === "BASIS" && basisModeIsDiff) {
    return { ok: false, reason: "BASIS_NOT_ALLOWED" };
  }
  if (latestStrip.length === 0) return { ok: false, reason: "NO_STRIP" };

  const horizon = deck.horizonMonths > 0 ? deck.horizonMonths : DEFAULT_HORIZON_MONTHS;
  const stripMonths = deck.stripMonths;
  const haircutMult = deck.haircutPct !== null ? 1 - deck.haircutPct / 100 : 1;
  const startMonth = latestStrip[0]!.contractMonth;
  const lastStripPrice = latestStrip[latestStrip.length - 1]!.price;

  // Strip-portion prices (haircut applied), padded flat past the real strip.
  const stripPrices: number[] = [];
  for (let i = 0; i < Math.min(stripMonths, horizon); i++) {
    const raw = i < latestStrip.length ? latestStrip[i]!.price : lastStripPrice;
    stripPrices.push(raw * haircutMult);
  }

  const hasTerminalMonths = horizon > stripMonths;

  let flatTerminal: number | null = null;
  if (deck.terminalRule === "FLAT" && hasTerminalMonths) {
    flatTerminal = terminalValueForGroup(deck, curve.group);
    if (flatTerminal === null) return { ok: false, reason: "NO_TERMINAL_VALUE" };
  }

  // STRIP_AVG / ESCALATE terminal base: average of the strip-portion prices
  // (post-haircut).
  let stripAvg = 0;
  if (stripPrices.length > 0) {
    let total = 0;
    for (const p of stripPrices) total += p;
    stripAvg = total / stripPrices.length;
  }

  const escalationPct = deck.escalationPctPerYear ?? 0;

  const months: { month: string; price: number }[] = [];
  for (let i = 0; i < horizon; i++) {
    const month = addMonths(startMonth, i);
    let price: number;
    if (i < stripMonths) {
      price = stripPrices[i]!;
    } else if (deck.terminalRule === "FLAT") {
      price = flatTerminal!;
    } else if (deck.terminalRule === "STRIP_AVG") {
      price = stripAvg;
    } else {
      const years = Math.floor((i - stripMonths) / 12);
      price = stripAvg * Math.pow(1 + escalationPct / 100, years);
    }
    months.push({ month, price });
  }

  return { ok: true, months };
}
