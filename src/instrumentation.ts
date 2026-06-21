/**
 * Next.js instrumentation — fires once on server boot.
 *
 * Used here to trigger the precompute catch-up: if the saved per-stock
 * regression grids are not current to the last trading close (because the
 * 17:00 Scheduled Task was missed, e.g. PC was off/asleep), kick off the
 * full daily refresh in the background. Fire-and-forget — never blocks
 * boot, never throws.
 *
 * Edge runtime is excluded — Prisma + the long-running ingest chain require
 * the Node.js runtime. The guard also prevents the catch-up from running
 * during edge bundling.
 *
 * Next 15 supports `instrumentation.ts` natively (no experimental flag).
 */
export async function register() {
  // Positive `=== "nodejs"` guard (not an early `return`) so that in the edge
  // bundle — where `process.env.NEXT_RUNTIME` is statically replaced with
  // "edge" — webpack eliminates this entire block as a dead branch. An early
  // `return` leaves the dynamic import as unreachable-but-present code, which
  // webpack still tries to compile for edge, pulling in Prisma's
  // `node:child_process` and failing with UnhandledSchemeError.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    try {
      const { maybeRunStartupCatchUp } = await import(
        "@/server/services/precompute-runner"
      );
      void maybeRunStartupCatchUp();
    } catch (e) {
      console.error(
        "[instrumentation] failed to schedule startup catch-up:",
        e,
      );
    }
  }
}
