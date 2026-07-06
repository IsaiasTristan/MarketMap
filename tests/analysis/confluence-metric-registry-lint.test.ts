import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  CONFLUENCE_METRIC_REGISTRY,
  CONFLUENCE_METRIC_IDS,
  buildConfluenceRegistry,
} from "@/lib/analysis/confluence/metric-registry";
import { CONFLUENCE_THRESHOLDS } from "@/lib/analysis/confluence/config";

/**
 * Confluence metric-registry drift lint (mirrors the revision/flows/signal-brief
 * lints). Enforces the registry as the SINGLE SOURCE for the CONFLUENCE tab's
 * definitions: no confluence component may hard-code a definition string that
 * belongs to the registry — it must render through ConfluenceMetricTip so the
 * copy cannot drift from the code.
 */
const CONFLUENCE_DIR = resolve(process.cwd(), "src/components/analysis/confluence");

function collectTsx(dir: string): string[] {
  if (!existsSync(dir)) return [];
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

describe("confluence metric registry drift lint", () => {
  const files = collectTsx(CONFLUENCE_DIR);

  it("no confluence component hardcodes a registry metric definition (must use ConfluenceMetricTip)", () => {
    const offenders: string[] = [];
    for (const id of CONFLUENCE_METRIC_IDS) {
      const frag = distinctiveFragment(CONFLUENCE_METRIC_REGISTRY[id].short_def);
      if (frag.length < 25) continue; // too short to be a reliable signal
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        if (src.includes(frag)) offenders.push(`${id}: "${frag}" found in ${f.replace(process.cwd(), "")}`);
      }
    }
    expect(
      offenders,
      `Move these definitions into the registry and render via ConfluenceMetricTip:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("registry sanity: full id coverage, unique labels, no engine codenames", () => {
    const labels = CONFLUENCE_METRIC_IDS.map((id) => CONFLUENCE_METRIC_REGISTRY[id].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of CONFLUENCE_METRIC_IDS) {
      const def = CONFLUENCE_METRIC_REGISTRY[id];
      expect(def.short_def.length).toBeGreaterThan(20);
      expect(`${def.label} ${def.short_def} ${def.caveats ?? ""}`).not.toMatch(/engine\s*[123]/i);
    }
  });

  it("copy interpolates the live thresholds (registry is a function of the config)", () => {
    const custom = buildConfluenceRegistry({
      ...CONFLUENCE_THRESHOLDS,
      flowLongMinBps: 77,
      fundLongMinDecile: 8,
      idioWarnPct: 55,
    });
    expect(custom.flowBps.short_def).toContain("+77bps");
    expect(custom.fundDecile.short_def).toContain("at or above 8");
    expect(custom.idioShare.short_def).toContain("55%");
    expect(CONFLUENCE_METRIC_REGISTRY.flowBps.short_def).toContain(
      `+${CONFLUENCE_THRESHOLDS.flowLongMinBps}bps`,
    );
  });
});
