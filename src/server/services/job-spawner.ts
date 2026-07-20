/**
 * job-spawner — shared child-process launcher for heavy background jobs.
 *
 * Why child processes?
 *   The runners (revision / fundamental / institutional / snapshot-refresh /
 *   price-tail / precompute) keep their scheduling + cheap DB gating inside
 *   the web server, but the heavy work itself runs in a short-lived
 *   `npm run job:*` child so its memory is returned to the OS on exit. The
 *   web process previously hosted all of it in-process and idled pinned at
 *   its heap ceiling (~6.5 GB on a 16 GB box), starving the whole machine.
 *
 * Why a queue?
 *   Heavy children are serialized (max ONE at a time, FIFO) so a boot after
 *   downtime — when several runners are stale at once — cannot stack
 *   concurrent multi-GB children. Beyond MAX_QUEUE pending jobs new requests
 *   resolve as skipped: every job here is freshness-gated and idempotent, so
 *   a skipped run is simply retried by its runner's next tick.
 *
 * Spawn mechanics mirror what precompute-runner proved out: shell:true so
 * `npm` resolves to npm.cmd on Windows, windowsHide to avoid console flash,
 * stdout/stderr teed to a timestamped file under logs/ and mirrored to the
 * server console. Args are always internally generated constants — never
 * user input — which is what makes shell:true acceptable.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";

export interface JobResult {
  /** True when the child ran and exited 0. */
  ok: boolean;
  /** True when the job never ran (queue full / busy). `ok` is false. */
  skipped: boolean;
  /** Child exit code, when it ran and exited. */
  code: number | null;
  /** Path of the tee'd log file, when the child was spawned. */
  logPath: string | null;
  /** Failure description (spawn error / non-zero exit / skip reason). */
  error: string | null;
}

export interface RunJobOptions {
  /**
   * "enqueue" (default): wait in the FIFO queue (dropped only past MAX_QUEUE).
   * "skip-if-busy": resolve skipped when ANY job is running or queued — for
   * frequent freshness ticks where stale work is worthless by the time the
   * queue drains (the next tick catches up).
   */
  mode?: "enqueue" | "skip-if-busy";
  /** Called once the child is spawned (for status surfaces that expose pid). */
  onSpawn?: (pid: number | null, logPath: string) => void;
}

/** Hard cap on pending jobs; beyond this, new jobs resolve skipped. */
const MAX_QUEUE = 4;

/**
 * Children get their own heap ceiling, decoupled from the web process's
 * NODE_OPTIONS (spawn inherits env, so without this the web heap setting
 * would silently apply to jobs too).
 */
const CHILD_NODE_OPTIONS =
  process.env.JOB_NODE_OPTIONS ?? "--max-old-space-size=4096";

let chain: Promise<void> = Promise.resolve();
let queueDepth = 0;

/** Number of jobs currently running or waiting (0 = idle). */
export function getJobQueueDepth(): number {
  return queueDepth;
}

/**
 * Serialize `task` behind every previously enqueued job. Exported for the
 * queue's unit tests; production callers use `runJobChild`.
 */
export function enqueueJob(
  name: string,
  mode: "enqueue" | "skip-if-busy",
  task: () => Promise<JobResult>,
): Promise<JobResult> {
  if (mode === "skip-if-busy" && queueDepth > 0) {
    return Promise.resolve({
      ok: false,
      skipped: true,
      code: null,
      logPath: null,
      error: `skipped: a job is already running/queued (depth ${queueDepth})`,
    });
  }
  if (queueDepth >= MAX_QUEUE) {
    console.warn(
      `[job:${name}] queue full (${queueDepth}); skipping — the runner's next tick will retry`,
    );
    return Promise.resolve({
      ok: false,
      skipped: true,
      code: null,
      logPath: null,
      error: `skipped: job queue full (depth ${queueDepth})`,
    });
  }
  queueDepth++;
  const run = chain
    .then(() => task())
    .catch((e): JobResult => ({
      ok: false,
      skipped: false,
      code: null,
      logPath: null,
      error: e instanceof Error ? e.message : String(e),
    }))
    .then((r) => {
      queueDepth--;
      return r;
    });
  chain = run.then(() => undefined);
  return run;
}

/**
 * Run `npm run <npmScript> [-- ...args]` as a serialized child process.
 * Resolves (never rejects) with the outcome; callers gate their "done for
 * today" bookkeeping on `result.ok` so failures retry on the next tick.
 */
export function runJobChild(
  name: string,
  npmScript: string,
  args: string[] = [],
  opts: RunJobOptions = {},
): Promise<JobResult> {
  return enqueueJob(name, opts.mode ?? "enqueue", () =>
    spawnJob(name, npmScript, args, opts.onSpawn),
  );
}

function spawnJob(
  name: string,
  npmScript: string,
  args: string[],
  onSpawn?: (pid: number | null, logPath: string) => void,
): Promise<JobResult> {
  return new Promise((resolve) => {
    let logPath: string | null = null;
    try {
      const repoRoot = process.cwd();
      const logDir = join(repoRoot, "logs");
      mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      logPath = join(logDir, `${name}-${stamp}.log`);
      const logStream = createWriteStream(logPath, { flags: "a" });

      const npmArgs =
        args.length > 0 ? ["run", npmScript, "--", ...args] : ["run", npmScript];
      const child = spawn("npm", npmArgs, {
        cwd: repoRoot,
        shell: true,
        windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: CHILD_NODE_OPTIONS },
      });
      console.log(
        `[job:${name}] spawned pid=${child.pid ?? "?"} (npm run ${npmScript}${args.length ? " -- " + args.join(" ") : ""}); logging to ${logPath}`,
      );
      onSpawn?.(child.pid ?? null, logPath);

      child.stdout?.on("data", (d: Buffer) => {
        logStream.write(d);
        process.stdout.write(d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        logStream.write(d);
        process.stderr.write(d);
      });

      let settled = false;
      child.on("error", (e) => {
        if (settled) return;
        settled = true;
        logStream.end();
        const error = e instanceof Error ? e.message : String(e);
        console.error(`[job:${name}] child spawn failed:`, e);
        resolve({ ok: false, skipped: false, code: null, logPath, error });
      });
      child.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        logStream.end();
        if (code === 0) {
          console.log(`[job:${name}] completed.`);
          resolve({ ok: true, skipped: false, code, logPath, error: null });
        } else {
          const error = `exited with ${code != null ? `code ${code}` : `signal ${signal}`}`;
          console.error(`[job:${name}] ${error}`);
          resolve({ ok: false, skipped: false, code, logPath, error });
        }
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      console.error(`[job:${name}] failed to spawn:`, e);
      resolve({ ok: false, skipped: false, code: null, logPath, error });
    }
  });
}
