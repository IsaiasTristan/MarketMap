/**
 * Engine 3 — curated 13F fund watchlist (seed configuration).
 *
 * This is the SEED only. Once seeded into `InstitutionalFund`, the database is
 * the source of truth and the list is user-maintained via the admin UI / API
 * (append, edit CIK/name/tier, toggle isActive, flag isMostRespected). Re-running
 * the seed upserts by CIK and never deletes user-added funds.
 *
 * tier: 1 = long-only / long-biased growth & quality · 2 = value / permanent
 * capital · 3 = activists. `isMostRespected` marks the hand-weighted subset used
 * by the first-mover / consensus-lag view (purest early-edge signal); it is a
 * default starting point, fully editable.
 *
 * Compiled from SEC EDGAR 13F-HR cover pages (see SEC_EDGAR_CIK_list_68_funds).
 */

export type WatchlistFund = {
  cik: string; // 10-digit zero-padded
  name: string; // display name
  edgarName: string; // EDGAR 13F-HR filer name
  tier: 1 | 2 | 3;
  isMostRespected?: boolean;
};

export const WATCHLIST_SEED: WatchlistFund[] = [
  // ── Tier 1 — long-only / long-biased growth & quality ────────────────────
  { cik: "0001061165", name: "Lone Pine Capital", edgarName: "LONE PINE CAPITAL LLC", tier: 1, isMostRespected: true },
  { cik: "0001103804", name: "Viking Global", edgarName: "VIKING GLOBAL INVESTORS LP", tier: 1, isMostRespected: true },
  { cik: "0001167483", name: "Tiger Global", edgarName: "TIGER GLOBAL MANAGEMENT LLC", tier: 1, isMostRespected: true },
  { cik: "0001135730", name: "Coatue", edgarName: "COATUE MANAGEMENT LLC", tier: 1, isMostRespected: true },
  { cik: "0001387322", name: "Whale Rock", edgarName: "WHALE ROCK CAPITAL MANAGEMENT LLC", tier: 1, isMostRespected: true },
  { cik: "0001569049", name: "Light Street", edgarName: "LIGHT STREET CAPITAL MANAGEMENT LLC", tier: 1 },
  { cik: "0001747057", name: "D1 Capital", edgarName: "D1 CAPITAL PARTNERS LP", tier: 1, isMostRespected: true },
  { cik: "0001541617", name: "Altimeter", edgarName: "ALTIMETER CAPITAL MANAGEMENT LP", tier: 1, isMostRespected: true },
  { cik: "0001798849", name: "Durable Capital", edgarName: "DURABLE CAPITAL PARTNERS LP", tier: 1, isMostRespected: true },
  { cik: "0001020066", name: "Sands Capital", edgarName: "SANDS CAPITAL MANAGEMENT LLC", tier: 1, isMostRespected: true },
  { cik: "0001112520", name: "Akre Capital", edgarName: "AKRE CAPITAL MANAGEMENT LLC", tier: 1, isMostRespected: true },
  { cik: "0001569205", name: "Fundsmith", edgarName: "FUNDSMITH LLP", tier: 1 },
  { cik: "0001034524", name: "Polen Capital", edgarName: "POLEN CAPITAL MANAGEMENT LLC", tier: 1 },
  { cik: "0001290668", name: "Sustainable Growth Advisers", edgarName: "SUSTAINABLE GROWTH ADVISERS LP", tier: 1 },
  { cik: "0001553733", name: "Brave Warrior", edgarName: "BRAVE WARRIOR ADVISORS LLC", tier: 1 },
  { cik: "0000860643", name: "Gardner Russo & Quinn", edgarName: "GARDNER RUSSO & QUINN LLC", tier: 1 },
  { cik: "0001641864", name: "Giverny Capital", edgarName: "GIVERNY CAPITAL INC", tier: 1 },
  { cik: "0001387366", name: "Ensemble Capital", edgarName: "ENSEMBLE CAPITAL MANAGEMENT LLC", tier: 1 },
  { cik: "0001568621", name: "Broad Run", edgarName: "BROAD RUN INVESTMENT MANAGEMENT LLC", tier: 1 },
  { cik: "0001279936", name: "Cantillon", edgarName: "CANTILLON CAPITAL MANAGEMENT LLC", tier: 1 },
  { cik: "0001581811", name: "Egerton Capital", edgarName: "EGERTON CAPITAL (UK) LLP", tier: 1 },
  { cik: "0001315309", name: "Lansdowne", edgarName: "LANSDOWNE PARTNERS (UK) LLP", tier: 1 },
  { cik: "0001318757", name: "Marshall Wace", edgarName: "MARSHALL WACE LLP", tier: 1 },
  { cik: "0001214822", name: "Steadfast", edgarName: "STEADFAST CAPITAL MANAGEMENT LP", tier: 1 },
  { cik: "0001553936", name: "Tybourne", edgarName: "TYBOURNE CAPITAL MANAGEMENT (HK) LTD", tier: 1 },
  { cik: "0001750312", name: "Hidden Lake", edgarName: "HIDDEN LAKE CAPITAL MANAGEMENT", tier: 1 },
  { cik: "0000859804", name: "Wedgewood", edgarName: "WEDGEWOOD PARTNERS INC", tier: 1 },
  { cik: "0001439303", name: "Polar Capital", edgarName: "POLAR CAPITAL LLP", tier: 1 },
  // ── Tier 2 — value / quality & permanent-capital ─────────────────────────
  { cik: "0001067983", name: "Berkshire Hathaway", edgarName: "BERKSHIRE HATHAWAY INC", tier: 2, isMostRespected: true },
  { cik: "0001096343", name: "Markel", edgarName: "MARKEL GROUP INC", tier: 2 },
  { cik: "0001336528", name: "Pershing Square", edgarName: "PERSHING SQUARE CAPITAL MANAGEMENT LP", tier: 2, isMostRespected: true },
  { cik: "0001040273", name: "Third Point", edgarName: "THIRD POINT LLC", tier: 2, isMostRespected: true },
  { cik: "0001079114", name: "Greenlight", edgarName: "GREENLIGHT CAPITAL INC", tier: 2 },
  { cik: "0001656456", name: "Appaloosa", edgarName: "APPALOOSA LP", tier: 2 },
  { cik: "0001061768", name: "Baupost", edgarName: "BAUPOST GROUP LLC/MA", tier: 2, isMostRespected: true },
  { cik: "0000949509", name: "Oaktree", edgarName: "OAKTREE CAPITAL MANAGEMENT LP", tier: 2 },
  { cik: "0000200217", name: "Dodge & Cox", edgarName: "DODGE & COX", tier: 2 },
  { cik: "0001325447", name: "First Eagle", edgarName: "FIRST EAGLE INVESTMENT MANAGEMENT LLC", tier: 2 },
  { cik: "0000732905", name: "Tweedy Browne", edgarName: "TWEEDY BROWNE CO LLC", tier: 2 },
  { cik: "0000807985", name: "Southeastern / Longleaf", edgarName: "SOUTHEASTERN ASSET MANAGEMENT INC/TN", tier: 2 },
  { cik: "0001036325", name: "Davis Selected Advisers", edgarName: "DAVIS SELECTED ADVISERS LP", tier: 2 },
  { cik: "0000728014", name: "Ruane Cunniff & Goldfarb", edgarName: "RUANE CUNNIFF & GOLDFARB LP", tier: 2 },
  { cik: "0001164833", name: "Hotchkis & Wiley", edgarName: "HOTCHKIS & WILEY CAPITAL MANAGEMENT LLC", tier: 2 },
  { cik: "0001027796", name: "Pzena", edgarName: "PZENA INVESTMENT MANAGEMENT LLC", tier: 2 },
  { cik: "0000813917", name: "Oakmark / Harris Associates", edgarName: "HARRIS ASSOCIATES L P", tier: 2 },
  { cik: "0001427008", name: "Smead", edgarName: "SMEAD CAPITAL MANAGEMENT INC", tier: 2 },
  { cik: "0000807249", name: "Gabelli / GAMCO", edgarName: "GAMCO INVESTORS INC", tier: 2 },
  { cik: "0000905567", name: "Yacktman", edgarName: "YACKTMAN ASSET MANAGEMENT LP", tier: 2 },
  { cik: "0001217541", name: "Diamond Hill", edgarName: "DIAMOND HILL CAPITAL MANAGEMENT INC", tier: 2 },
  { cik: "0001377581", name: "FPA", edgarName: "FIRST PACIFIC ADVISORS LLC", tier: 2 },
  { cik: "0001466153", name: "Artisan Partners", edgarName: "ARTISAN PARTNERS LIMITED PARTNERSHIP", tier: 2 },
  { cik: "0001419999", name: "Mar Vista", edgarName: "MAR VISTA INVESTMENT PARTNERS LLC", tier: 2 },
  { cik: "0001556785", name: "Vulcan Value", edgarName: "VULCAN VALUE PARTNERS LLC", tier: 2 },
  // ── Tier 3 — activists ────────────────────────────────────────────────────
  { cik: "0001791786", name: "Elliott", edgarName: "ELLIOTT INVESTMENT MANAGEMENT L.P.", tier: 3, isMostRespected: true },
  { cik: "0001517137", name: "Starboard Value", edgarName: "STARBOARD VALUE LP", tier: 3, isMostRespected: true },
  { cik: "0001351069", name: "ValueAct", edgarName: "VALUEACT CAPITAL MANAGEMENT L.P.", tier: 3, isMostRespected: true },
  { cik: "0001345471", name: "Trian", edgarName: "TRIAN FUND MANAGEMENT L.P.", tier: 3 },
  { cik: "0001159159", name: "Jana Partners", edgarName: "JANA PARTNERS LLC", tier: 3 },
  { cik: "0001535472", name: "Corvex", edgarName: "CORVEX MANAGEMENT LP", tier: 3 },
  { cik: "0001582090", name: "Sachem Head", edgarName: "SACHEM HEAD CAPITAL MANAGEMENT LP", tier: 3 },
  { cik: "0001885245", name: "Politan", edgarName: "POLITAN CAPITAL MANAGEMENT LP", tier: 3 },
  { cik: "0001559771", name: "Engaged Capital", edgarName: "ENGAGED CAPITAL LLC", tier: 3 },
  { cik: "0001560207", name: "Legion Partners", edgarName: "LEGION PARTNERS ASSET MANAGEMENT LLC", tier: 3 },
  { cik: "0001446114", name: "Ancora", edgarName: "ANCORA ADVISORS LLC", tier: 3 },
  { cik: "0001817187", name: "Inclusive Capital", edgarName: "INCLUSIVE CAPITAL PARTNERS L.P.", tier: 3 },
  { cik: "0001536520", name: "Land & Buildings", edgarName: "LAND & BUILDINGS INVESTMENT MANAGEMENT LLC", tier: 3 },
  { cik: "0001107310", name: "Eminence", edgarName: "EMINENCE CAPITAL LP", tier: 3 },
  { cik: "0001279150", name: "Scopia", edgarName: "SCOPIA CAPITAL MANAGEMENT LP", tier: 3 },
];
