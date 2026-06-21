/**
 * Curated successor map for tickers that we know have been renamed, merged,
 * spun off, or acquired. Used to seed `Security.suggestedReplacement` when
 * the dynamic Yahoo lookup returns nothing useful.
 *
 * Conventions:
 *  - Key is the *old* ticker (uppercase). Value is the surviving symbol on
 *    a US exchange, or `null` if the company went private / bankrupt with
 *    no public successor (so we don't surface a misleading suggestion).
 *  - Only include entries with high confidence. When in doubt, leave it out;
 *    the Data tab UI will fall back to the live Yahoo successor lookup.
 */
export const TICKER_SUCCESSORS: Record<string, string | null> = {
  // Bank/financial M&A and rebrands
  NYCB: "FLG", // New York Community Bancorp → Flagstar Financial (rebrand 2024)
  DFS: "COF", // Discover acquired by Capital One
  CMA: null, // pending — leave for user

  // Energy mergers
  CHK: "EXE", // Chesapeake + Southwestern → Expand Energy
  SWN: "EXE", // ditto
  CPE: "APA", // Callon Petroleum acquired by APA
  SBOW: "CRGY", // SilverBow acquired by Crescent Energy
  HES: "CVX", // Hess being acquired by Chevron
  CEIX: "CNR", // Consol + Arch → Core Natural Resources
  ARCH: "CNR", // ditto
  CHX: "SLB", // ChampionX acquired by SLB

  // Tech M&A
  SPLK: "CSCO", // Splunk acquired by Cisco
  ANSS: "SNPS", // Ansys acquired by Synopsys
  JNPR: "HPE", // Juniper acquired by HPE
  SMAR: null, // Smartsheet taken private (Vista/Blackstone) — no public successor
  EDR: null, // Endeavor taken private
  CYBR: "PANW", // CyberArk being acquired by Palo Alto Networks
  DAY: null, // Dayforce/Ceridian taken private (Thoma Bravo)
  ZI: null, // ZoomInfo — still trades, would not normally fail; leave blank

  // Industrial / consumer M&A
  WRK: "SW", // WestRock + Smurfit Kappa → Smurfit Westrock
  BLL: "BALL", // Ball Corp ticker change to BALL
  HA: "ALK", // Hawaiian Airlines acquired by Alaska Air
  SAVE: null, // Spirit Airlines bankruptcy/delist — no successor
  X: null, // US Steel acquired by Nippon Steel (foreign — no US ticker)
  K: "MARS", // Kellanova being acquired by Mars (private; placeholder — keep null below)
  // Note: Mars is private, so K really has no public successor. Override:
  // (we keep K here just to document; loader treats null as "no suggestion"):
  // K: null,
  SIX: "FUN", // Six Flags merged into Cedar Fair
  LSI: "EXR", // Life Storage merged into Extra Space
  VRNA: "MRK", // Verona Pharma acquired by Merck
  AY: null, // Atlantica Sustainable taken private
  NEP: "XPLR", // NextEra Partners renamed XPLR Infrastructure
  TPIC: null, // TPI Composites — bankruptcy
  NOVA: null, // SunNova — bankruptcy
  WBA: null, // Walgreens being taken private (Sycamore) — pending
};

/** Override the K placeholder: Mars is private so there is no public successor. */
TICKER_SUCCESSORS.K = null;

/** Lookup helper that returns null both for "unknown" and "no public successor". */
export function curatedSuccessor(ticker: string): string | null {
  const v = TICKER_SUCCESSORS[ticker.trim().toUpperCase()];
  return v ?? null;
}
