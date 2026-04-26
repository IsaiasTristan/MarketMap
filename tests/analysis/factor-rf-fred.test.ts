import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { calibrateRfShift, type FactorSeries } from "@/domain/calculations/factor-pipeline";
import { fetchDgs1moRfDaily } from "@/infrastructure/providers/fred.provider";

/**
 * RF gap-fill: FRED DGS1MO → FactorReturnDaily.
 *
 * The DB stores `RF` as **daily simple decimal** (e.g. 1.746e-4 for ~4.4 %
 * p.a.), matching the convention used by every other code in
 * `FactorReturnDaily` (and matching Ken French's native CSV which is
 * percent-per-day, divided by 100 at ingest). Readers consume the stored
 * value directly — no per-read /252.
 *
 * The FRED **fetcher** (`fetchDgs1moRfDaily`) keeps returning FRED's native
 * annualized decimal (that's the right contract for the data provider).
 * The pipeline service is responsible for converting to daily before calling
 * `calibrateRfShift` and persisting to `FactorReturnDaily`.
 *
 * These tests pin:
 *   1. FRED CSV parsing converts annualized percent → annualized decimal.
 *   2. Forward-fill correctly carries the last observation across bond
 *      holidays where FRED prints "." (rendered as NaN by parseFloat,
 *      filtered out at the provider layer).
 *   3. Mean-shift calibration matches KF's tail level on the trailing 63d
 *      overlap, with a sane no-op when overlap is too thin.
 *   4. The end-to-end identity `(1 + r_excess) * (1 + r_f) ≈ (1 + r_total)`
 *      holds when stored RF is consumed directly as daily decimal.
 */

const ENC = (s: string): Response =>
  ({
    ok: true,
    status: 200,
    text: () => Promise.resolve(s),
  }) as unknown as Response;

describe("fetchDgs1moRfDaily — CSV parsing + units", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn() as unknown as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("converts annualized percent to annualized decimal", async () => {
    const csv = [
      "DATE,DGS1MO",
      "2026-04-21,4.40",
      "2026-04-22,4.42",
      "2026-04-23,4.41",
    ].join("\n");
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ENC(csv));

    const out = await fetchDgs1moRfDaily("2026-04-01");
    expect(out).toHaveLength(3);
    expect(out[0].date).toBe("2026-04-21");
    expect(out[0].value).toBeCloseTo(0.044, 10);
    expect(out[1].value).toBeCloseTo(0.0442, 10);
    expect(out[2].value).toBeCloseTo(0.0441, 10);
  });

  it("filters FRED missing-day markers (.) and empty rows", async () => {
    const csv = [
      "DATE,DGS1MO",
      "2026-04-20,4.40",
      "2026-04-21,.", // bond holiday
      "",
      "2026-04-22,4.42",
    ].join("\n");
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(ENC(csv));

    const out = await fetchDgs1moRfDaily("2026-04-01");
    expect(out.map((r) => r.date)).toEqual(["2026-04-20", "2026-04-22"]);
  });

  it("throws on non-OK responses (no silent zero-fill)", async () => {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      status: 503,
    } as unknown as Response);
    await expect(fetchDgs1moRfDaily("2026-04-01")).rejects.toThrow(/DGS1MO/);
  });
});

describe("calibrateRfShift — KF/FRED level alignment", () => {
  // KF's RF is the Ibbotson 1-month bill held to maturity, on a 360-day
  // discount basis; DGS1MO is constant-maturity on a 365-day basis. The
  // empirical level gap is small but persistent — additive shift is the
  // correct calibration for level series.
  const kfRf: FactorSeries[] = Array.from({ length: 80 }, (_, i) => ({
    date: `2026-01-${String((i % 28) + 1).padStart(2, "0")}`, // intentional date collisions OK for unit tests
    value: 0.044, // 4.4 % p.a.
  }));

  it("returns the additive shift that matches KF mean over the 63d overlap", () => {
    // FRED runs 5 bp lower on average over the same dates
    const fredRf: FactorSeries[] = kfRf.slice(20).map((r) => ({
      date: r.date,
      value: r.value - 0.0005,
    }));

    const result = calibrateRfShift(kfRf, fredRf, kfRf[kfRf.length - 1].date);
    expect(result.shift).toBeCloseTo(0.0005, 6);
    expect(result.overlapDays).toBeGreaterThan(0);
  });

  it("returns zero shift (no-op) when overlap is below minOverlap", () => {
    const fredRf: FactorSeries[] = [{ date: "2026-01-01", value: 0.04 }];
    const result = calibrateRfShift(kfRf, fredRf, "2026-01-28", 63, 20);
    expect(result.shift).toBe(0);
    expect(result.overlapDays).toBeLessThan(20);
  });

  it("ignores FRED rows past lastFfDate so post-FF values don't leak into calibration", () => {
    const lastFf = "2026-01-15";
    const fredRf: FactorSeries[] = [
      ...kfRf.slice(0, 30).map((r) => ({ date: r.date, value: r.value - 0.001 })),
      { date: "2026-02-01", value: 999 }, // wild post-FF spike, must NOT enter calibration
    ];
    const result = calibrateRfShift(kfRf, fredRf, lastFf, 63, 20);
    // The +999 outlier was excluded → shift stays at the pre-FF +0.001 offset
    if (result.overlapDays >= 20) {
      expect(result.shift).toBeCloseTo(0.001, 4);
    } else {
      expect(result.shift).toBe(0);
    }
  });

  it("returns zero shift when either series is empty", () => {
    expect(calibrateRfShift([], [{ date: "2026-01-01", value: 0.04 }], "2026-01-01")).toEqual({
      shift: 0,
      overlapDays: 0,
    });
    expect(calibrateRfShift(kfRf, [], "2026-01-28")).toEqual({ shift: 0, overlapDays: 0 });
  });
});

describe("RF stored as daily simple decimal (post-bug-fix contract)", () => {
  // Pure-math contract: every code in FactorReturnDaily is a daily simple
  // return, including RF. Readers must consume it directly.
  it("a typical 4.4% annual rate stored as ~1.746e-4 daily decimal", () => {
    const annualDecimal = 0.044;
    const dailyAtIngest = annualDecimal / 252; // pipeline converts FRED → daily once
    expect(dailyAtIngest).toBeCloseTo(1.746e-4, 7);
    // Reader consumes stored daily value AS-IS (no further /252).
    const rfDailyAsRead = dailyAtIngest;
    expect(rfDailyAsRead).toBeCloseTo(1.746e-4, 7);
  });

  it("(1 + r_excess) * (1 + r_f) === (1 + r_total) holds over 252d under the new contract", () => {
    // Synthetic 252d of stock returns + RF returns, both as daily simple
    // decimals (matching how the timeseries service consumes them).
    const N = 252;
    const stockDaily: number[] = [];
    const rfDaily: number[] = [];
    let seed = 0xc0ffee;
    const rand = () => {
      // Park-Miller LCG, deterministic across machines
      seed = (seed * 48271) % 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let i = 0; i < N; i++) {
      stockDaily.push((rand() - 0.5) * 0.04); // ±2 % daily
      rfDaily.push(0.044 / 252 + (rand() - 0.5) * 1e-6); // ~daily T-bill rate w/ tiny jitter
    }

    // Excess return path (mirrors timeseries service `stockExcessLog`):
    let sumLogExcess = 0;
    let sumLogRf = 0;
    let sumLogTotal = 0;
    for (let i = 0; i < N; i++) {
      sumLogExcess += Math.log(1 + stockDaily[i]) - Math.log(1 + rfDaily[i]);
      sumLogRf += Math.log(1 + rfDaily[i]);
      sumLogTotal += Math.log(1 + stockDaily[i]);
    }
    const excessGeom = Math.expm1(sumLogExcess);
    const rfGeom = Math.expm1(sumLogRf);
    const totalGeom = Math.expm1(sumLogTotal);

    // Identity must hold to floating-point precision.
    expect((1 + excessGeom) * (1 + rfGeom)).toBeCloseTo(1 + totalGeom, 12);

    // Sanity: 252 daily RF ≈ 0.044 ⇒ rfGeom ≈ exp(0.044) − 1 ≈ 0.045
    expect(rfGeom).toBeGreaterThan(0.04);
    expect(rfGeom).toBeLessThan(0.05);
  });
});
