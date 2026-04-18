### Current Development Focus

Ship and harden the **equity market map and portfolio analytics** platform: universe paste + CRUD + Yahoo HTTP price/benchmark ingest to Postgres; market-map matrix API + heatmap UI (sort, metric/row/benchmark, sector/sub-theme drill-down); portfolio weights + benchmark analytics; keep financial math in `src/domain` and services out of presentational components.

### Key Decisions / Constraints

- **Hierarchy (only):** Sector → Sub-Theme → Company. Drives market map rows, drill-down, rankings, and aggregations (parent metric = **average of leaf company metrics** unless later specified otherwise).
- **Trading-day semantics:** 1/5/21/63/126/252 trading days for 1D, 5D, 1M, 3M, 6M, 1Y; not calendar days.
- **Returns:** From **adjusted** close; daily return = \(P_t/P_{t-1} - 1\). Volatility: annualized **realized** vol from daily returns, \(\sigma_{ann} = \text{stdev} \times \sqrt{252}\). Sharpe uses configurable risk-free; zero-vol edge case must not divide by zero.
- **Stack:** Next.js + TypeScript, Prisma + PostgreSQL, market data **behind interfaces**; default adapter uses Yahoo **public** chart + quote HTTP (no API key; unofficial—see `docs/ARCHITECTURE.md`). Benchmarks: S&P 500, NASDAQ, DOW stored in `BenchmarkPriceHistory`.
- **Quality:** No analytics logic in React components—call services/API from UI.

### Major Changes Log

- **2026-04-18:** Universe + market map + portfolio UIs; REST APIs (`/api/universes/*`, `/api/parse-universe`, `/api/benchmarks/ingest`, `/api/portfolios/*`); Yahoo chart/quote HTTP provider; `computeMarketMap` / portfolio analytics services; Vitest alignment tests; removed `yahoo-finance2` (Next bundle conflict).
- **2026-04-17:** App shell, `/api/health` (Prisma), domain calcs, feature stubs, initial tests.
- **2026-04-17 (init):** `docs/ARCHITECTURE.md`, Prisma schema, provider ports.
