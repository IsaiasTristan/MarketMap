import { describe, it, expect } from "vitest";
import {
  enqueueJob,
  getJobQueueDepth,
  type JobResult,
} from "@/server/services/job-spawner";

function okResult(): JobResult {
  return { ok: true, skipped: false, code: 0, logPath: null, error: null };
}

/** A task that resolves when `release()` is called, recording run order. */
function gatedTask(order: string[], name: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const task = async (): Promise<JobResult> => {
    order.push(`start:${name}`);
    await gate;
    order.push(`end:${name}`);
    return okResult();
  };
  return { task, release };
}

describe("enqueueJob", () => {
  it("runs jobs strictly serially in FIFO order", async () => {
    const order: string[] = [];
    const a = gatedTask(order, "a");
    const b = gatedTask(order, "b");

    const pa = enqueueJob("a", "enqueue", a.task);
    const pb = enqueueJob("b", "enqueue", b.task);

    // Let microtasks flush: only "a" may have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:a"]);
    expect(getJobQueueDepth()).toBe(2);

    a.release();
    await pa;
    b.release();
    await pb;
    expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
    expect(getJobQueueDepth()).toBe(0);
  });

  it("skip-if-busy resolves skipped while anything is running or queued", async () => {
    const order: string[] = [];
    const a = gatedTask(order, "a");
    const pa = enqueueJob("a", "enqueue", a.task);

    const skipped = await enqueueJob("b", "skip-if-busy", async () => okResult());
    expect(skipped.skipped).toBe(true);
    expect(skipped.ok).toBe(false);

    a.release();
    await pa;

    // Queue drained — skip-if-busy now runs.
    const ran = await enqueueJob("c", "skip-if-busy", async () => okResult());
    expect(ran.skipped).toBe(false);
    expect(ran.ok).toBe(true);
  });

  it("drops jobs past MAX_QUEUE as skipped", async () => {
    const order: string[] = [];
    const gates = ["a", "b", "c", "d"].map((n) => gatedTask(order, n));
    const pending = gates.map((g, i) =>
      enqueueJob(`job${i}`, "enqueue", g.task),
    );
    expect(getJobQueueDepth()).toBe(4);

    const overflow = await enqueueJob("overflow", "enqueue", async () => okResult());
    expect(overflow.skipped).toBe(true);

    for (const g of gates) g.release();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(getJobQueueDepth()).toBe(0);
  });

  it("a rejecting task resolves as a failed (not skipped) result and frees the queue", async () => {
    const r = await enqueueJob("boom", "enqueue", async () => {
      throw new Error("kaput");
    });
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
    expect(r.error).toContain("kaput");
    expect(getJobQueueDepth()).toBe(0);

    const next = await enqueueJob("after", "enqueue", async () => okResult());
    expect(next.ok).toBe(true);
  });
});
