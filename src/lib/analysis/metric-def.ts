/**
 * Shared metric-definition shape consumed by DefinitionTooltip. Each engine
 * keeps its own typed registry (flows: src/lib/institutional/metric-registry.ts,
 * revision: src/lib/revision/metric-registry.ts) built from the SAME config its
 * computations read, so tooltip copy cannot drift from the code.
 */
export interface MetricDef {
  id: string;
  /** Short human label (matches the on-screen term). */
  label: string;
  /** One/two-sentence definition — the tooltip body. Config numbers are interpolated. */
  short_def: string;
  /** How it's calculated (optional second paragraph). */
  calculation?: string;
  /** Caveats / gotchas (optional). */
  caveats?: string;
  /** Window / basis line (optional). */
  basis?: string;
  /**
   * Per-instance arithmetic line (optional) — e.g. a matrix cell or chart dot
   * showing its own computation ("gap +53pp = +31 minus -22, changed +8pp in
   * 4 weeks"). Rendered in accent below the definition body.
   */
  arithmetic?: string;
}
