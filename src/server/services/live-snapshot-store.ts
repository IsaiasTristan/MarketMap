/**
 * Shared on-disk store for live-quote snapshots produced by the out-of-process
 * live-sweep daemon (see scripts/live-sweep-daemon.ts) and read by the web
 * process. This keeps the heavy per-ticker extended-hours Yahoo sweep (one v8
 * chart fetch + JSON parse per ~2,872 tickers, every 60s during PRE/POST) OFF
 * the web server's event loop, while the existing in-memory snapshot getters
 * stay the read API — they just refresh from this file instead of an in-process
 * sweep.
 *
 * Files live under <cwd>/.live-snapshots/<name>.json. Writes are atomic
 * (temp + rename) so a reader never observes a half-written file; if the rename
 * fails (Windows sharing violation) we fall back to a direct write, and readers
 * tolerate a parse failure by keeping their last good value.
 */
import {
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const SNAPSHOT_DIR = join(process.cwd(), ".live-snapshots");

function pathFor(name: string): string {
  return join(SNAPSHOT_DIR, `${name}.json`);
}

/** Write a snapshot atomically. Never throws (logs and returns on failure). */
export function writeSnapshotFile(name: string, data: unknown): void {
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const path = pathFor(name);
    const tmp = `${path}.tmp`;
    const json = JSON.stringify(data);
    writeFileSync(tmp, json, "utf8");
    try {
      renameSync(tmp, path);
    } catch {
      // Windows can throw a sharing violation if a reader holds the target
      // open; a direct overwrite is good enough (readers self-heal on a rare
      // partial read by keeping their last value).
      writeFileSync(path, json, "utf8");
    }
  } catch (e) {
    console.error(`[live-snapshot-store] write ${name} failed:`, e);
  }
}

/** File mtime in ms, or null when the file is absent/unreadable. */
export function snapshotFileMtimeMs(name: string): number | null {
  try {
    return statSync(pathFor(name)).mtimeMs;
  } catch {
    return null;
  }
}

/** Parse a snapshot file, or null on absence / partial-write / parse error. */
export function readSnapshotFile<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(pathFor(name), "utf8")) as T;
  } catch {
    return null;
  }
}
