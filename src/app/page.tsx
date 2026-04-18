import Link from "next/link";

export default function HomePage() {
  return (
    <main className="shell">
      <h1>MarketMap</h1>
      <p>
        Internal-style dashboard for universe management, a six-column market
        map (1D–1Y trading horizons), and weighted portfolio analytics. Prices
        load from Yahoo Finance (adjusted closes) into PostgreSQL.
      </p>
      <ul>
        <li>
          <Link href="/universe">Universe</Link> — paste tickers, save, refresh
          prices &amp; benchmarks
        </li>
        <li>
          <Link href="/market-map">Market map</Link> — heatmap matrix, metric /
          row level, drill-down
        </li>
        <li>
          <Link href="/portfolios">Portfolios</Link> — weights, save, compare
          to benchmark
        </li>
        <li>
          <Link href="/api/health">/api/health</Link> — database check
        </li>
      </ul>
      <p style={{ fontSize: "0.9rem", color: "#5a6b7d" }}>
        Set <code>DATABASE_URL</code> in <code>.env</code>, then{" "}
        <code>npx prisma db push</code> (or <code>migrate</code>), then{" "}
        <code>npm run dev</code>.
      </p>
    </main>
  );
}
