import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { REV_METRIC_REGISTRY, REV_METRIC_IDS } from "@/lib/revision/metric-registry";

/**
 * Revision metric-registry drift lint (mirrors the flows lint). Enforces the
 * registry as the SINGLE SOURCE for metric definitions: no research component
 * may hard-code a metric definition string that belongs to the registry — it
 * must render through MetricTip so the copy cannot drift from the code.
 */
const RESEARCH_DIR = resolve(process.cwd(), "src/components/analysis/research");
const REGISTRY_FILE = resolve(process.cwd(), "src/lib/revision/metric-registry.ts");

function collectTsx(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTsx(p));
    else if (name.endsWith(".tsx") || name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A distinctive fragment of a definition — long enough that a match means copy-paste. */
function distinctiveFragment(def: string): string {
  const firstSentence = def.split(/[.—·]/)[0]!.trim();
  return firstSentence.length > 40 ? firstSentence.slice(0, 60) : firstSentence;
}

describe("revision metric registry drift lint", () => {
  const files = collectTsx(RESEARCH_DIR).filter((f) => f !== REGISTRY_FILE);

  it("no research component hardcodes a registry metric definition (must use MetricTip)", () => {
    const offenders: string[] = [];
    for (const id of REV_METRIC_IDS) {
      const frag = distinctiveFragment(REV_METRIC_REGISTRY[id].short_def);
      if (frag.length < 25) continue; // too short to be a reliable signal
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        if (src.includes(frag)) offenders.push(`${id}: "${frag}" found in ${f.replace(process.cwd(), "")}`);
      }
    }
    expect(offenders, `Move these definitions into the registry and render via MetricTip:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("registry covers the metrics the tabs render (sanity: non-empty, unique labels)", () => {
    const labels = REV_METRIC_IDS.map((id) => REV_METRIC_REGISTRY[id].label);
    expect(new Set(labels).size).toBe(labels.length);
    expect(REV_METRIC_IDS.length).toBeGreaterThanOrEqual(30);
  });
});
