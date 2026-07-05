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
}
