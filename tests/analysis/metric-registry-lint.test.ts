import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { METRIC_REGISTRY, METRIC_IDS } from "@/lib/institutional/metric-registry";

/**
 * Metric-registry drift lint (Fund Overview Part 4d). Enforces the registry as the
 * SINGLE SOURCE for metric definitions: no flows component may hard-code a metric
 * definition string that belongs to the registry — it must render through MetricTooltip
 * so the copy cannot drift from the code. This is the "fails on hardcoded definition
 * strings outside the registry" guard, scoped to the registry's own metrics (interaction
 * hints like "open ledger" / "reset zoom" are NOT metric definitions and are exempt).
 */
const FLOWS_DIR = resolve(process.cwd(), "src/components/analysis/flows");
const REGISTRY_FILE = resolve(process.cwd(), "src/lib/institutional/metric-registry.ts");

function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTsx(p));
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A distinctive fragment of a definition — long enough that an accidental match means
 *  the definition text was copy-pasted, not a coincidental short phrase. */
function distinctiveFragment(def: string): string {
  // Take the first sentence, trimmed to a stable, punctuation-light chunk.
  const firstSentence = def.split(/[.—·]/)[0]!.trim();
  return firstSentence.length > 40 ? firstSentence.slice(0, 60) : firstSentence;
}

describe("metric registry drift lint", () => {
  const files = collectTsx(FLOWS_DIR).filter((f) => f !== REGISTRY_FILE);

  it("no flows component hardcodes a registry metric definition (must use MetricTooltip)", () => {
    const offenders: string[] = [];
    for (const id of METRIC_IDS) {
      const frag = distinctiveFragment(METRIC_REGISTRY[id].short_def);
      if (frag.length < 25) continue; // too short to be a reliable signal
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        if (src.includes(frag)) offenders.push(`${id}: "${frag}" found in ${f.replace(process.cwd(), "")}`);
      }
    }
    expect(offenders, `Move these definitions into the registry and render via MetricTooltip:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("registry covers the metrics the dossier renders (sanity: non-empty, unique labels)", () => {
    const labels = METRIC_IDS.map((id) => METRIC_REGISTRY[id].label);
    expect(new Set(labels).size).toBe(labels.length); // no duplicate labels
    expect(METRIC_IDS.length).toBeGreaterThanOrEqual(25);
  });
});
