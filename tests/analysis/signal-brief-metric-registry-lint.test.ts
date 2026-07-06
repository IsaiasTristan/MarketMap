import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  SIGNAL_METRIC_REGISTRY,
  SIGNAL_METRIC_IDS,
  buildSignalBriefRegistry,
} from "@/lib/analysis/signal-brief/metric-registry";
import { SIGNAL_BRIEF_THRESHOLDS } from "@/lib/analysis/signal-brief/config";

/**
 * Signal-brief metric-registry drift lint (mirrors the revision/flows lints).
 * Enforces the registry as the SINGLE SOURCE for the Overview signal modules'
 * definitions: no overview component may hard-code a definition string that
 * belongs to the registry — it must render through SignalMetricTip so the copy
 * cannot drift from the code.
 */
const OVERVIEW_DIR = resolve(process.cwd(), "src/components/analysis/overview");

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

describe("signal-brief metric registry drift lint", () => {
  const files = collectTsx(OVERVIEW_DIR);

  it("no overview component hardcodes a registry metric definition (must use SignalMetricTip)", () => {
    const offenders: string[] = [];
    for (const id of SIGNAL_METRIC_IDS) {
      const frag = distinctiveFragment(SIGNAL_METRIC_REGISTRY[id].short_def);
      if (frag.length < 25) continue; // too short to be a reliable signal
      for (const f of files) {
        const src = readFileSync(f, "utf8");
        if (src.includes(frag)) offenders.push(`${id}: "${frag}" found in ${f.replace(process.cwd(), "")}`);
      }
    }
    expect(offenders, `Move these definitions into the registry and render via SignalMetricTip:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("registry sanity: full id coverage, unique labels", () => {
    const labels = SIGNAL_METRIC_IDS.map((id) => SIGNAL_METRIC_REGISTRY[id].label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const id of SIGNAL_METRIC_IDS) {
      expect(SIGNAL_METRIC_REGISTRY[id].short_def.length).toBeGreaterThan(20);
    }
  });

  it("copy interpolates the live thresholds (registry is a function of the config)", () => {
    const custom = buildSignalBriefRegistry({
      ...SIGNAL_BRIEF_THRESHOLDS,
      verdictConfirmMinFlowBps: 77,
      feedMaxRows: 9,
    });
    expect(custom.verdictConfirm.short_def).toContain("+77bps");
    expect(custom.severityOrder.short_def).toContain("9 rows");
    expect(SIGNAL_METRIC_REGISTRY.verdictConfirm.short_def).toContain(
      `+${Math.round(SIGNAL_BRIEF_THRESHOLDS.verdictConfirmMinFlowBps)}bps`,
    );
  });
});
