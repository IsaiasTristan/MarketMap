/**
 * Engine 3 — curated 13F fund watchlist (seed configuration).
 *
 * This is the SEED only. Once seeded into `InstitutionalFund`, the database is
 * the source of truth and the list is user-maintained via the admin UI / API
 * (append, edit CIK/name/category, toggle isActive, flag isMostRespected).
 * Re-running the seed upserts by CIK; with --replace it also deactivates funds
 * that are no longer in this list (deleting only rows with no ingested data).
 *
 * Source: smart_money_universe.csv (2026-07-02). Every CIK verified against
 * SEC EDGAR (data.sec.gov/submissions) as the entity's current 13F-HR filer;
 * several funds file under successor entities (see notes). Four CSV names had
 * no active 13F filer and were dropped: Bloom Tree, Cedar Rock, Ides Capital,
 * Blackwells Capital. Two "(pre-…)" legacy rows keep history for funds whose
 * filer entity changed mid-window.
 *
 * `category` is the display taxonomy; `tier` (1 growth-ish · 2 value-ish ·
 * 3 activist/event) is derived via CATEGORY_TIER for coarse sorting only.
 * `isMostRespected` marks the hand-weighted subset used by the first-mover /
 * consensus-lag view; it mirrors the CSV's elite_tier and is fully editable.
 */

export const FUND_CATEGORIES = [
  "Growth/Quality",
  "Quality Compounder",
  "TMT",
  "Healthcare",
  "Value",
  "Smid Specialist",
  "Energy",
  "Financials",
  "Event-Driven",
  "Activist",
] as const;

export type FundCategory = (typeof FUND_CATEGORIES)[number];

/** Coarse legacy tier used for sorting: 1 growth-ish · 2 value-ish · 3 activist/event. */
export const CATEGORY_TIER: Record<FundCategory, 1 | 2 | 3> = {
  "Growth/Quality": 1,
  "Quality Compounder": 1,
  TMT: 1,
  Healthcare: 1,
  Value: 2,
  "Smid Specialist": 2,
  Energy: 2,
  Financials: 2,
  "Event-Driven": 3,
  Activist: 3,
};

export type WatchlistFund = {
  cik: string; // 10-digit zero-padded, verified current 13F-HR filer
  name: string; // display name
  edgarName: string; // EDGAR conformed filer name
  category: FundCategory;
  isMostRespected?: boolean;
  notes?: string;
};

export const WATCHLIST_SEED: WatchlistFund[] = [
  // ── Growth/Quality ──────────────────────────────────────────────────────
  { cik: "0001112520", name: "Akre Capital", edgarName: "AKRE CAPITAL MANAGEMENT LLC", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001541617", name: "Altimeter", edgarName: "Altimeter Capital Management, LP", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001827442", name: "Alua Capital", edgarName: "Alua Capital Management LP", category: "Growth/Quality", notes: "Viking alums, quality growth" },
  { cik: "0001553733", name: "Brave Warrior", edgarName: "Brave Warrior Advisors, LLC", category: "Growth/Quality", notes: "Glenn Greenberg (ex-Chieftain)" },
  { cik: "0001568621", name: "Broad Run", edgarName: "Broad Run Investment Management, LLC", category: "Growth/Quality" },
  { cik: "0001279936", name: "Cantillon", edgarName: "CANTILLON CAPITAL MANAGEMENT LLC", category: "Growth/Quality" },
  { cik: "0001135730", name: "Coatue", edgarName: "COATUE MANAGEMENT LLC", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001747057", name: "D1 Capital", edgarName: "D1 Capital Partners L.P.", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001609098", name: "Darsana Capital", edgarName: "Darsana Capital Partners LP", category: "Growth/Quality", notes: "Anand Desai, Eton Park lineage" },
  { cik: "0001602189", name: "Dragoneer Investment Group", edgarName: "Dragoneer Investment Group, LLC", category: "Growth/Quality", notes: "Marc Stad, growth crossover" },
  { cik: "0001798849", name: "Durable Capital", edgarName: "Durable Capital Partners LP", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001581811", name: "Egerton Capital", edgarName: "Egerton Capital (UK) LLP", category: "Growth/Quality" },
  { cik: "0001387366", name: "Ensemble Capital", edgarName: "Ensemble Capital Management, LLC", category: "Growth/Quality", notes: "Last 13F-HR Nov 2024 (Q3 2024) — no longer filing; history retained." },
  { cik: "0001590531", name: "Foxhaven Asset Management", edgarName: "Foxhaven Asset Management, LP", category: "Growth/Quality", notes: "Tiger grandcub, media/internet" },
  { cik: "0001569205", name: "Fundsmith", edgarName: "Fundsmith LLP", category: "Growth/Quality", notes: "Terry Smith" },
  { cik: "0000860643", name: "Gardner Russo & Quinn", edgarName: "GARDNER RUSSO & QUINN LLC", category: "Growth/Quality" },
  { cik: "0001641864", name: "Giverny Capital", edgarName: "Giverny Capital Inc.", category: "Growth/Quality" },
  { cik: "0001750312", name: "Hidden Lake", edgarName: "Hidden Lake Asset Management LP", category: "Growth/Quality" },
  { cik: "0001608485", name: "Lansdowne", edgarName: "LANSDOWNE PARTNERS (UK) LLP", category: "Growth/Quality", notes: "Files as Lansdowne Partners (UK) LLP; prior seed CIK 1315309 was the dormant Limited Partnership (no 13F-HR since 2014)." },
  { cik: "0001569049", name: "Light Street", edgarName: "LIGHT STREET CAPITAL MANAGEMENT, LLC", category: "Growth/Quality" },
  { cik: "0001061165", name: "Lone Pine Capital", edgarName: "LONE PINE CAPITAL LLC", category: "Growth/Quality", isMostRespected: true, notes: "Tiger cub" },
  { cik: "0001318757", name: "Marshall Wace", edgarName: "MARSHALL WACE, LLP", category: "Growth/Quality", notes: "RECOMMEND: move to context tier - quant multi-manager, 2592 positions is noise for signal purposes" },
  { cik: "0001410830", name: "Matrix Capital Management", edgarName: "Matrix Capital Management Company, LP", category: "Growth/Quality", notes: "David Goel, concentrated TMT, Tiger lineage" },
  { cik: "0000934639", name: "Maverick Capital", edgarName: "MAVERICK CAPITAL LTD", category: "Growth/Quality", isMostRespected: true, notes: "Lee Ainslie, original Tiger cub" },
  { cik: "0001837309", name: "Polar Capital", edgarName: "Polar Capital Holdings Plc", category: "Growth/Quality", notes: "13F-HR filed by parent Polar Capital Holdings Plc; the LLP went notice-only (13F-NT) in 2021." },
  { cik: "0001034524", name: "Polen Capital", edgarName: "POLEN CAPITAL MANAGEMENT LLC", category: "Growth/Quality", notes: "Large long-only; consider context tier or weight-cap" },
  { cik: "0001020066", name: "Sands Capital", edgarName: "SANDS CAPITAL MANAGEMENT, LLC", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001537530", name: "SCGE Management", edgarName: "SCGE MANAGEMENT, L.P.", category: "Growth/Quality", notes: "Sequoia-affiliated public growth" },
  { cik: "0001675884", name: "Skye Global", edgarName: "Skye Global Management LP", category: "Growth/Quality", notes: "Jamie Sterne, concentrated" },
  { cik: "0001559706", name: "Slate Path Capital", edgarName: "Slate Path Capital LP", category: "Growth/Quality", notes: "Blue Ridge lineage" },
  { cik: "0001517857", name: "Soroban Capital", edgarName: "Soroban Capital Partners LP", category: "Growth/Quality", notes: "Mandelblatt, concentrated industrials/TMT" },
  { cik: "0001214822", name: "Steadfast", edgarName: "STEADFAST CAPITAL MANAGEMENT LP", category: "Growth/Quality" },
  { cik: "0001290668", name: "Sustainable Growth Advisers", edgarName: "Sustainable Growth Advisers, LP", category: "Growth/Quality" },
  { cik: "0001167483", name: "Tiger Global", edgarName: "TIGER GLOBAL MANAGEMENT LLC", category: "Growth/Quality", isMostRespected: true },
  { cik: "0001553936", name: "Tybourne", edgarName: "TYBOURNE CAPITAL MANAGEMENT (HK) LTD", category: "Growth/Quality", notes: "Tiger grandcub. Last 13F-HR Nov 2025 (Q3 2025) — monitor filing status." },
  { cik: "0001103804", name: "Viking Global", edgarName: "VIKING GLOBAL INVESTORS LP", category: "Growth/Quality", isMostRespected: true, notes: "Tiger cub" },
  { cik: "0000859804", name: "Wedgewood", edgarName: "WEDGEWOOD PARTNERS INC", category: "Growth/Quality" },
  { cik: "0001387322", name: "Whale Rock", edgarName: "Whale Rock Capital Management LLC", category: "Growth/Quality", isMostRespected: true },
  // ── Quality Compounder ──────────────────────────────────────────────────
  { cik: "0001578684", name: "Abdiel Capital", edgarName: "Abdiel Capital Advisors, LP", category: "Quality Compounder", notes: "Ultra-concentrated software" },
  { cik: "0001376879", name: "AKO Capital", edgarName: "AKO CAPITAL LLP", category: "Quality Compounder", notes: "London quality specialist" },
  { cik: "0001631014", name: "Altarock Partners", edgarName: "ALTAROCK PARTNERS LP", category: "Quality Compounder", notes: "Mark Massey, ~6 positions" },
  { cik: "0001340807", name: "Bares Capital Management", edgarName: "Bares Capital Management, Inc.", category: "Quality Compounder", notes: "Brian Bares, concentrated smid quality Last 13F-HR Nov 2025 (Q3 2025) — monitor filing status." },
  { cik: "0001671657", name: "Dorsey Asset Management", edgarName: "Dorsey Asset Management, LLC", category: "Quality Compounder", notes: "Pat Dorsey, moats framework" },
  { cik: "0000945631", name: "Eagle Capital Management", edgarName: "EAGLE CAPITAL MANAGEMENT LLC", category: "Quality Compounder", notes: "Boykin Curry" },
  { cik: "0001709323", name: "Himalaya Capital", edgarName: "Himalaya Capital Management LLC", category: "Quality Compounder", isMostRespected: true, notes: "Li Lu - Munger endorsed" },
  { cik: "0001484150", name: "Lindsell Train", edgarName: "Lindsell Train Ltd", category: "Quality Compounder", notes: "Nick Train; verify US 13F filer status" },
  { cik: "0001427119", name: "Meritage Group", edgarName: "Meritage Group LP", category: "Quality Compounder", notes: "Simons family office, low profile, quality" },
  { cik: "0001631664", name: "Punch Card Management", edgarName: "Punch Card Management L.P.", category: "Quality Compounder", notes: "Norbert Lou, ~4 positions" },
  { cik: "0001115373", name: "Semper Augustus", edgarName: "SEMPER AUGUSTUS INVESTMENTS GROUP LLC", category: "Quality Compounder", notes: "Chris Bloomstran" },
  { cik: "0001647251", name: "TCI Fund Management", edgarName: "TCI Fund Management Ltd", category: "Quality Compounder", isMostRespected: true, notes: "Chris Hohn - very concentrated, exceptional record" },
  { cik: "0001697868", name: "Valley Forge Capital", edgarName: "Valley Forge Capital Management, LP", category: "Quality Compounder", notes: "Dev Kantesaria, ~8 positions" },
  // ── TMT ─────────────────────────────────────────────────────────────────
  { cik: "0001510669", name: "Contour Asset Management", edgarName: "Contour Asset Management LLC", category: "TMT", notes: "Tech long/short" },
  { cik: "0001410833", name: "Night Owl Capital", edgarName: "Night Owl Capital Management, LLC", category: "TMT", notes: "Quality growth" },
  { cik: "0001680964", name: "SoMa Equity Partners", edgarName: "SOMA EQUITY PARTNERS LP", category: "TMT", notes: "Concentrated internet/software" },
  { cik: "0002003074", name: "Sylebra Capital", edgarName: "SYLEBRA CAPITAL LLC", category: "TMT", notes: "Global tech New filer entity Sylebra Capital LLC since 2024 (predecessor Ltd stopped Q3 2023)." },
  // ── Healthcare ──────────────────────────────────────────────────────────
  { cik: "0001633313", name: "Avoro Capital", edgarName: "Avoro Capital Advisors LLC", category: "Healthcare", notes: "Biotech" },
  { cik: "0001263508", name: "Baker Bros Advisors", edgarName: "BAKER BROS. ADVISORS LP", category: "Healthcare", isMostRespected: true, notes: "Premier biotech specialist" },
  { cik: "0001856083", name: "Deep Track Capital", edgarName: "Deep Track Capital, LP", category: "Healthcare", notes: "Biotech" },
  { cik: "0001055951", name: "OrbiMed Advisors", edgarName: "ORBIMED ADVISORS LLC", category: "Healthcare", notes: "Largest HC specialist" },
  { cik: "0001224962", name: "Perceptive Advisors", edgarName: "PERCEPTIVE ADVISORS LLC", category: "Healthcare", notes: "Biotech" },
  { cik: "0001346824", name: "RA Capital Management", edgarName: "RA CAPITAL MANAGEMENT, L.P.", category: "Healthcare", notes: "Biotech, deep science DD" },
  { cik: "0001425738", name: "Redmile Group", edgarName: "Redmile Group, LLC", category: "Healthcare" },
  { cik: "0001577524", name: "Sarissa Capital", edgarName: "Sarissa Capital Management LP", category: "Healthcare", notes: "Alex Denner, HC activist" },
  // ── Value ───────────────────────────────────────────────────────────────
  { cik: "0001358706", name: "Abrams Capital", edgarName: "ABRAMS CAPITAL MANAGEMENT, L.P.", category: "Value", isMostRespected: true, notes: "David Abrams, Baupost alum, concentrated" },
  { cik: "0001656456", name: "Appaloosa", edgarName: "Appaloosa LP", category: "Value", notes: "David Tepper" },
  { cik: "0001466153", name: "Artisan Partners", edgarName: "Artisan Partners Limited Partnership", category: "Value", notes: "Large diversified; consider context tier" },
  { cik: "0001061768", name: "Baupost", edgarName: "BAUPOST GROUP LLC/MA", category: "Value", isMostRespected: true, notes: "Seth Klarman" },
  { cik: "0001067983", name: "Berkshire Hathaway", edgarName: "BERKSHIRE HATHAWAY INC", category: "Value", isMostRespected: true, notes: "Buffett" },
  { cik: "0001166559", name: "Bill & Melinda Gates Foundation Trust", edgarName: "GATES FOUNDATION TRUST", category: "Value", notes: "Ultra-low turnover, ~20 positions" },
  { cik: "0001549575", name: "Dalal Street (Pabrai)", edgarName: "Dalal Street, LLC", category: "Value", notes: "Mohnish Pabrai" },
  { cik: "0001036325", name: "Davis Selected Advisers", edgarName: "DAVIS SELECTED ADVISERS", category: "Value" },
  { cik: "0001217541", name: "Diamond Hill", edgarName: "DIAMOND HILL CAPITAL MANAGEMENT INC", category: "Value", notes: "Consider context tier" },
  { cik: "0000200217", name: "Dodge & Cox", edgarName: "DODGE & COX", category: "Value", notes: "Consider context tier" },
  { cik: "0001536411", name: "Duquesne Family Office", edgarName: "Duquesne Family Office LLC", category: "Value", isMostRespected: true, notes: "Druckenmiller - macro-informed, higher turnover" },
  { cik: "0000915191", name: "Fairfax Financial", edgarName: "FAIRFAX FINANCIAL HOLDINGS LTD/ CAN", category: "Value", notes: "Prem Watsa insurance float book" },
  { cik: "0001056831", name: "Fairholme", edgarName: "FAIRHOLME CAPITAL MANAGEMENT LLC", category: "Value", notes: "Berkowitz - now mostly St. Joe, marginal" },
  { cik: "0001325447", name: "First Eagle", edgarName: "First Eagle Investment Management, LLC", category: "Value", notes: "Consider context tier - 414 positions" },
  { cik: "0001377581", name: "FPA", edgarName: "First Pacific Advisors, LP", category: "Value" },
  { cik: "0000807249", name: "Gabelli / GAMCO", edgarName: "GAMCO INVESTORS, INC. ET AL", category: "Value", notes: "RECOMMEND: context tier - 950 positions" },
  { cik: "0001138995", name: "Glenview Capital", edgarName: "GLENVIEW CAPITAL MANAGEMENT, LLC", category: "Value", notes: "Larry Robbins, healthcare tilt" },
  { cik: "0000846222", name: "Greenhaven Associates", edgarName: "GREENHAVEN ASSOCIATES INC", category: "Value", notes: "Ed Wachenheim" },
  { cik: "0001489933", name: "Greenlight", edgarName: "DME Capital Management, LP", category: "Value", notes: "David Einhorn David Einhorn — files as DME Capital Management LP since Q1 2024." },
  { cik: "0001079114", name: "Greenlight (pre-2024 filer)", edgarName: "GREENLIGHT CAPITAL INC", category: "Value", notes: "Legacy Einhorn filer — history through Q4 2023; successor filer is DME Capital Management LP." },
  { cik: "0001056823", name: "Horizon Kinetics", edgarName: "HORIZON KINETICS ASSET MANAGEMENT LLC", category: "Value", notes: "Murray Stahl - TPL heavy" },
  { cik: "0001164833", name: "Hotchkis & Wiley", edgarName: "HOTCHKIS & WILEY CAPITAL MANAGEMENT LLC", category: "Value", notes: "Consider context tier - 454 positions" },
  { cik: "0000921669", name: "Icahn Capital", edgarName: "ICAHN CARL C", category: "Value", notes: "Carl Icahn (also activist)" },
  { cik: "0001039565", name: "Kahn Brothers", edgarName: "KAHN BROTHERS GROUP INC", category: "Value", notes: "Deep value" },
  { cik: "0001419999", name: "Mar Vista", edgarName: "MAR VISTA INVESTMENT PARTNERS LLC", category: "Value" },
  { cik: "0001096343", name: "Markel", edgarName: "MARKEL GROUP INC.", category: "Value" },
  { cik: "0001732811", name: "MFN Partners", edgarName: "MFN Partners Management, LP", category: "Value", notes: "Concentrated value, MP alums" },
  { cik: "0000813917", name: "Oakmark / Harris Associates", edgarName: "HARRIS ASSOCIATES L P", category: "Value" },
  { cik: "0000949509", name: "Oaktree", edgarName: "OAKTREE CAPITAL MANAGEMENT LP", category: "Value", notes: "Marks; mostly credit - equities are residual" },
  { cik: "0001336528", name: "Pershing Square", edgarName: "Pershing Square Capital Management, L.P.", category: "Value", isMostRespected: true, notes: "Ackman" },
  { cik: "0001027796", name: "Pzena", edgarName: "PZENA INVESTMENT MANAGEMENT LLC", category: "Value", notes: "Consider context tier" },
  { cik: "0001720792", name: "Ruane Cunniff & Goldfarb", edgarName: "Ruane, Cunniff & Goldfarb L.P.", category: "Value", notes: "Sequoia Fund Sequoia Fund. Re-registered as L.P. — holdings under CIK 1720792 since 2018." },
  { cik: "0001649339", name: "Scion Asset Management", edgarName: "Scion Asset Management, LLC", category: "Value", notes: "Michael Burry — treat as sentiment. Deregistered late 2025; last 13F-HR Q3 2025." },
  { cik: "0001427008", name: "Smead", edgarName: "Smead Capital Management, Inc.", category: "Value" },
  { cik: "0001029160", name: "Soros Fund Management", edgarName: "SOROS FUND MANAGEMENT LLC", category: "Value", notes: "Family office" },
  { cik: "0000807985", name: "Southeastern / Longleaf", edgarName: "SOUTHEASTERN ASSET MANAGEMENT INC/TN/", category: "Value" },
  { cik: "0001099281", name: "Third Avenue Management", edgarName: "THIRD AVENUE MANAGEMENT LLC", category: "Value", notes: "Deep value / real assets" },
  { cik: "0001040273", name: "Third Point", edgarName: "Third Point LLC", category: "Value", isMostRespected: true, notes: "Loeb; also activist" },
  { cik: "0000732905", name: "Tweedy Browne", edgarName: "Tweedy, Browne Co LLC", category: "Value" },
  { cik: "0001556785", name: "Vulcan Value", edgarName: "Vulcan Value Partners, LLC", category: "Value" },
  { cik: "0000883965", name: "Weitz Investment Management", edgarName: "WEITZ INVESTMENT MANAGEMENT, INC.", category: "Value" },
  { cik: "0000905567", name: "Yacktman", edgarName: "YACKTMAN ASSET MANAGEMENT LP", category: "Value" },
  // ── Smid Specialist ─────────────────────────────────────────────────────
  { cik: "0001540531", name: "12 West Capital", edgarName: "12 West Capital Management LP", category: "Smid Specialist", notes: "Concentrated growth smid" },
  { cik: "0001399386", name: "Bandera Partners", edgarName: "Bandera Partners LLC", category: "Smid Specialist", notes: "Concentrated small value" },
  { cik: "0001058854", name: "Cannell Capital", edgarName: "CANNELL CAPITAL LLC", category: "Smid Specialist", notes: "Micro-cap activist" },
  { cik: "0001531612", name: "Cove Street Capital", edgarName: "Cove Street Capital, LLC", category: "Smid Specialist", notes: "Small-cap value Last 13F-HR Nov 2025 (Q3 2025) — monitor filing status." },
  { cik: "0001741129", name: "Greenhaven Road", edgarName: "Greenhaven Road Investment Management, L.P.", category: "Smid Specialist", notes: "Scott Miller, micro/smid" },
  { cik: "0001592643", name: "Select Equity Group", edgarName: "Select Equity Group, L.P.", category: "Smid Specialist", notes: "Quality smid; larger position count - maybe context" },
  { cik: "0001505183", name: "Stockbridge Partners", edgarName: "Stockbridge Partners LLC", category: "Smid Specialist", notes: "Berkshire Partners public arm" },
  { cik: "0001484148", name: "Turtle Creek Asset Management", edgarName: "Turtle Creek Asset Management Inc.", category: "Smid Specialist", notes: "Canadian, concentrated mid-cap" },
  { cik: "0001730145", name: "Voss Capital", edgarName: "Voss Capital, LP", category: "Smid Specialist", notes: "Texas smid value" },
  // ── Energy ──────────────────────────────────────────────────────────────
  { cik: "0001541901", name: "Encompass Capital", edgarName: "Encompass Capital Advisors LLC", category: "Energy", notes: "Energy long/short" },
  { cik: "0001706220", name: "Kimmeridge Energy", edgarName: "Kimmeridge Energy Management Company, LLC", category: "Energy", notes: "Energy activist" },
  // ── Financials ──────────────────────────────────────────────────────────
  { cik: "0001085393", name: "Basswood Capital", edgarName: "BASSWOOD CAPITAL MANAGEMENT, L.L.C.", category: "Financials", notes: "Financials specialist" },
  // ── Event-Driven ────────────────────────────────────────────────────────
  { cik: "0001825564", name: "Browning West", edgarName: "BROWNING WEST LP", category: "Event-Driven", notes: "Concentrated constructivist" },
  { cik: "0001665590", name: "Engine Capital", edgarName: "Engine Capital Management, LP", category: "Event-Driven", notes: "Smid activist" },
  { cik: "0000909661", name: "Farallon Capital", edgarName: "FARALLON CAPITAL MANAGEMENT, L.L.C.", category: "Event-Driven", notes: "Multi-strategy event" },
  { cik: "0001525362", name: "HG Vora Capital", edgarName: "HG Vora Capital Management, LLC", category: "Event-Driven", notes: "Event + gaming/lodging" },
  { cik: "0001786767", name: "Impactive Capital", edgarName: "Impactive Capital LP", category: "Event-Driven", notes: "Constructivist" },
  { cik: "0001929389", name: "Irenic Capital", edgarName: "Irenic Capital Management LP", category: "Event-Driven", notes: "Elliott/Indaba alums" },
  { cik: "0001687509", name: "Rubric Capital", edgarName: "Rubric Capital Management LP", category: "Event-Driven", notes: "Smid event/value" },
  { cik: "0001443689", name: "Senator Investment Group", edgarName: "Senator Investment Group LP", category: "Event-Driven" },
  // ── Activist ────────────────────────────────────────────────────────────
  { cik: "0001446114", name: "Ancora", edgarName: "Ancora Advisors LLC", category: "Activist", notes: "RECOMMEND: context tier OR filter to activist book only - 2151 positions is mostly wealth-mgmt noise" },
  { cik: "0000887762", name: "Barington Companies", edgarName: "BARINGTON COMPANIES MANAGEMENT, LLC", category: "Activist", notes: "Smid activist" },
  { cik: "0001535472", name: "Corvex", edgarName: "Corvex Management LP", category: "Activist", notes: "Meister" },
  { cik: "0001791786", name: "Elliott", edgarName: "Elliott Investment Management L.P.", category: "Activist", isMostRespected: true, notes: "Note: 13F understates - much exposure via swaps" },
  { cik: "0001107310", name: "Eminence", edgarName: "EMINENCE CAPITAL, LP", category: "Activist" },
  { cik: "0001559771", name: "Engaged Capital", edgarName: "Engaged Capital LLC", category: "Activist" },
  { cik: "0001817187", name: "Inclusive Capital", edgarName: "INCLUSIVE CAPITAL PARTNERS, L.P.", category: "Activist", notes: "Ubben; winding down — last 13F-HR Nov 2025 (Q3 2025)." },
  { cik: "0001998597", name: "Jana Partners", edgarName: "JANA Partners Management, LP", category: "Activist", notes: "Files as JANA Partners Management LP since Q3 2023." },
  { cik: "0001159159", name: "Jana Partners (pre-2024 filer)", edgarName: "JANA PARTNERS LLC", category: "Activist", notes: "Legacy filer — history through Q2 2023; successor filer is JANA Partners Management LP." },
  { cik: "0001536520", name: "Land & Buildings", edgarName: "Land & Buildings Investment Management, LLC", category: "Activist", notes: "REIT activist" },
  { cik: "0001560207", name: "Legion Partners", edgarName: "Legion Partners Asset Management, LLC", category: "Activist" },
  { cik: "0001695459", name: "Mantle Ridge", edgarName: "Mantle Ridge LP", category: "Activist", notes: "Paul Hilal, 1-2 positions at a time" },
  { cik: "0001885245", name: "Politan", edgarName: "Politan Capital Management LP", category: "Activist", notes: "Quentin Koffey" },
  { cik: "0001582090", name: "Sachem Head", edgarName: "Sachem Head Capital Management LP", category: "Activist" },
  { cik: "0001279150", name: "Scopia", edgarName: "SCOPIA CAPITAL MANAGEMENT LP", category: "Activist" },
  { cik: "0001517137", name: "Starboard Value", edgarName: "Starboard Value LP", category: "Activist", isMostRespected: true },
  { cik: "0001345471", name: "Trian", edgarName: "TRIAN FUND MANAGEMENT, L.P.", category: "Activist", notes: "Peltz" },
  { cik: "0001418814", name: "ValueAct", edgarName: "ValueAct Holdings, L.P.", category: "Activist", isMostRespected: true, notes: "13F filed by ValueAct Holdings LP (CIK 1418814), not the Management entity." },
];
