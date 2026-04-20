# AGENTS.md

**Status freshness check:** 2026-04-19 (factor refactor) — Institutional Factor Analysis tab now live at `/factors` (CAPM/FF3/Carhart4/FF5/Extended presets; joint multivariate OLS; rolling betas; risk decomposition; attribution; drivers; scenarios; market context; drift alerts; 91 tests pass). Single-universe screener: Market Map ("Performance") dashboard with top-bar **Manage Tickers** modal (CSV Import / Paste Tickers / Current N) replacing the removed `/universe` page; **Current tab now supports per-row removal** via `DELETE /api/universes/:id/constituents?ticker=…` (UniverseConstituent row deleted, Security row preserved); `GET /api/universe/default` auto-resolves the one active universe; CSV/TSV parser requires 4 columns (Ticker, Name, Sector, Sub-Theme) with optional headers; **`POST /api/universes/:id/constituents` is now batched + timeout-safe for large (~1k row) pastes** — service de-dupes input by uppercased ticker, pre-loads existing securities outside the transaction, then runs a single short transaction (`deleteMany` → `createMany` security → `updateMany` reactivate → small per-row name updates → `findMany` IDs → `createMany` constituents) with `{ timeout: 30_000, maxWait: 10_000 }`; route sets `maxDuration = 120` and returns a JSON error body on failure; modal surfaces a count-aware parse-error message and colours the footer red/green based on outcome; **market map renders as a block-grouped Sector → Sub-Theme → Ticker hierarchy** — columns are Sector | Sub-Theme | Ticker | horizons, sectors are the default top-level rows styled as uppercase amber block headers, expanding a sector reveals its sub-themes as a contiguous "card" underneath (continuous left-edge spine via `box-shadow: inset 4px 0 0 …` on the sector column, internal row dividers suppressed, distinct row backgrounds `#1c2638` / `#0e1624` / `#091018`, `#06090f` spacer rows separating sectors); each level has its own visual rhythm — sector rows are tall + uppercase amber (`#f0b65d`, 700, wide letter-spacing), sub-theme rows are mid-density with cool light text (`#d8e3f0`, 500), ticker rows are compact monospaced slate (`#9eb0c8`); heat cells follow the same 3-step density (0.86 → 0.84 → 0.8 rem); per-row chevrons drill into sub-themes / tickers and the controls-strip **Show sub-themes / Hide sub-themes** button toggles only sector-level expansion; the client makes one `rowLevel=COMPANY` fetch and aggregates sector / sub-theme cells in-browser (avg of leaf metrics per horizon, matching the server) with **per-level heatmap ranges**; **dashboard auto-updates** — fires `?onlyMissing=true` price ingest on first load + after Apply, and re-fetches the market map every 30 s. Yahoo ingest is hardened against throttling: chart endpoint retries on HTTP 401/429/5xx with exponential backoff, universe ingest uses a small concurrent worker pool (3 workers, ~150 ms inter-request delay) and `maxDuration = 600` so a 400-ticker initial run completes; per-ticker failures don't abort the batch (returned in `failed[]`). Symbol normalisation is precise: single trailing letter only (`BRK.B` → `BRK-B`), foreign exchange suffixes preserved (`MC.PA`, `NOVO-B.CO`), bare US index codes auto-`^`-prefixed (`VIX` → `^VIX`), and explicit overrides for tickers whose Yahoo chart symbol differs (`DXY` → `DX-Y.NYB`, `ABB` → `ABBNY` post-NYSE-delisting). Portfolios + analytics unchanged; Yahoo chart/quote HTTP (no `yahoo-finance2`); APIs under `/api/*`. Commands: `npm install` → `npx prisma db push` (Postgres + `DATABASE_URL`) → `npm run dev` → `npm test` / `npm run build`.

## Project Scope

**MarketMap** is a web-based equity analytics platform for **market map visualization** and **portfolio construction / analytics**, built as a serious internal investment analytics product.

- **Core purpose:** Map performance and risk across a single user-defined **universe of stocks** using a fixed hierarchy (Sector → Sub-Theme → Company), and support multi-portfolio construction with analytics and benchmark comparison.
- **Primary problem:** Centralize universe management, historical prices, trading-day-based analytics, rankings, and portfolio metrics in one maintainable system with clear domain boundaries—no analytics logic in UI components.
- **Key capabilities:** One persistent ticker universe managed via a **Manage Tickers** modal on the Performance page (CSV Import with drop-zone, Paste Tickers, Current list with per-column search); ingestion requires 4 columns per row (Ticker, Name, Sector, Sub-Theme), CSV/TSV both accepted with optional headers; 10+ years of adjusted daily prices stored in PostgreSQL; trading-day return/volatility/Sharpe/excess return; matrix heatmap market map (all horizons as columns) rendered as a **block-grouped Sector → Sub-Theme → Ticker hierarchy** with per-row chevrons, a "Show sub-themes / Hide sub-themes" global toggle, and visual block grouping that ties each sector's sub-themes (and tickers) into one card-like cluster with clear gaps between sectors; sector/sub-theme/company rollups by average; portfolio builder (ticker + weight); portfolio vs S&P 500, NASDAQ, DOW; factor exposure module (proxies in stage 1); scheduled refresh and analytics jobs.
- **Expected architecture:** Modular monolith: UI → API → services → data (Prisma/PostgreSQL) → external market data providers behind interfaces. Financial math in `src/domain/calculations` and related services.

---

## Mirrored user rules (terminal / agent visibility)

The following mirrors the repository’s Cursor user rules so terminal agents and non-Cursor tools see the same guidance. **Do not treat this as a second source of truth**—when Cursor rules change, update this section to match.

### Follow all instructions

- Think about **all** instructions in user rules, user queries, skills, system reminders, and MCP tool descriptions in full. Do not skip or partially apply them.
- When a skill, rule, or tool specifies format, output structure, naming, or workflow, **follow it**.
- Pay special attention to constraints in tool/skill/MCP descriptions—they are requirements.
- When a skill is relevant, **read and follow** the skill file; do not only mention it.

### Real environment

- This is a real environment with shell and network—**run commands and investigate**; do not only tell the user what to run.
- Do not give up after one failure; try alternatives or diagnose and retry.
- **Date authority:** The `Today's date` field in the session is authoritative (e.g. 2026).
- If about to write instructions instead of executing, **execute** them.

### Communication (user-facing)

- Use code citations as ` ```startLine:endLine:path ` for existing code; opening fence on its own line; skip large chunks with `...` where needed.
- In non-citation code blocks, full commands—no `...` omissions.
- Prefer markdown links for web URLs; full paths/URLs, not shortened.
- Prose: precise, well-structured, complete sentences; proportional length; avoid filler; use **bold** and backticks sparingly; no `§` in user-facing text; no engagement-bait closings.

### Code and scope discipline

- Only change code required for the task; no drive-by refactors or unrelated files.
- Do not add markdown files the user did not ask for (exception: `PROJECT_BRIEF.md` / this file / scope process as per project rules).
- Read surrounding code; match style; reuse abstractions; avoid unnecessary comments and defensive try/catch.
- For UI: polished, consistent with existing design patterns.

### Reason about conversation history

- Latest messages inherit context; identify underlying goals and implicit requirements; refinements default to steering the current task, not canceling it.

### Cursor skills

When relevant, read skills from paths listed in the session (e.g. under `.cursor/skills` or `.codex/skills`) and follow them.

### PROJECT_BRIEF.md (living project brief)

- Keep **`PROJECT_BRIEF.md`** in the project root updated for scope, structure, and major decisions.
- **Before major work:** Check `PROJECT_BRIEF.md` exists; create using the project’s suggested structure if missing.
- **Update** when architecture, major components, scope, stack, or capabilities change materially. If uncertain, ask the user.

### Project scope in AGENTS.md

- Confirm a **Project Scope** section exists (this document).
- If missing, ask the user for a concise outline, create `AGENTS.md`, add **Project Scope** with their description, and keep it updated on material direction changes (ask the user if needed).

### AGENTS.md synchronization

- **AGENTS.md** should mirror **existing** user-defined Cursor rules (visibility only): **no new rules, no removed rules, no changed meaning**—reorganize for agent consumption.
- On Cursor rules updates, update `AGENTS.md` to stay aligned.
- **Status freshness check:** verify blockers with commands and update date stamps (see top of this file).

### Engineering principles (architecture, data, quality, security, observability, schema, discipline)

- **Modular monolith** with strict layers: `ui → api → services → data → database/external`. Lower layers do not depend on higher layers. Business logic framework-agnostic in services/domain. Data access centralized; no SQL/ORM in business rules beyond repositories.
- **Data:** Treat external inputs as untrusted; validate at boundaries; canonical internal model; parse/normalize external data; adapters for new source formats.
- **Quality:** Simple, readable code; explicit names; reasonable file/function size; no duplicated logic; tests for critical domain logic.
- **Reliability:** Testable design; domain invariants explicit; idempotent/ordered/retry behavior explicit; deliberate error handling (validation, user-facing, retryable, fault).
- **Security:** AuthZ at server boundaries; never rely on UI for security.
- **Observability:** Log errors and important events; no silent failures.
- **Schema/contracts:** No breaking public contract changes without impact note; safe migrations; avoid destructive DB changes unless approved.
- **Discipline:** No speculative abstraction; default to simplest correct design; consider simplify/reuse/remove before adding code.

---

## Technology (this repo)

- **Frontend:** Next.js (App Router) + React + TypeScript  
- **Backend:** Next.js Route Handlers + shared domain package layout under `src/`  
- **Database:** PostgreSQL  
- **ORM:** Prisma  
- **Jobs:** `tsx` scripts + scheduler-friendly modules (BullMQ/Redis optional later)  

---

## Commands (typical)

```bash
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
pnpm test
pnpm job:refresh   # when implemented; placeholder until jobs wired
```

Set `DATABASE_URL` in `.env` before Prisma operations.
