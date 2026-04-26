import type { FactorCode, FactorInputType } from "@/types/factors";

export interface FactorNormalizationConfig {
  rollingWindow: number;
  minObservations: number;
  winsorSigma: number;
  targetAnnualVol: number | null;
}

export interface FactorNormalizationMeta {
  code: FactorCode;
  inputType: FactorInputType;
}

export interface FactorNormalizationDiagnostics {
  config: FactorNormalizationConfig;
  ambiguousFactors: FactorCode[];
  insufficientObservationsByFactor: Record<string, number>;
  totalRowsDroppedForNormalization: number;
}

export interface FactorNormalizationResult {
  normalizedRows: (number | null)[][];
  transformedRows: (number | null)[][];
  winsorizedRows: (number | null)[][];
  diagnostics: FactorNormalizationDiagnostics;
}

const DEFAULT_CONFIG: FactorNormalizationConfig = {
  rollingWindow: 252,
  minObservations: 60,
  winsorSigma: 5,
  targetAnnualVol: 0.1,
};

function mean(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function sampleStd(values: number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values);
  const variance = values.reduce((s, v) => s + (v - mu) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function rollingHistory(series: (number | null)[], t: number, window: number): number[] {
  const start = Math.max(0, t - window);
  const out: number[] = [];
  for (let i = start; i < t; i++) {
    const v = series[i];
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  return out;
}

function transformValue(
  rawSeries: number[],
  t: number,
  inputType: FactorInputType,
): number | null {
  const cur = rawSeries[t];
  if (!Number.isFinite(cur)) return null;
  if (inputType === "RETURN") return cur;
  if (inputType === "FIRST_DIFFERENCE") {
    if (t === 0) return null;
    const prev = rawSeries[t - 1];
    if (!Number.isFinite(prev)) return null;
    return cur - prev;
  }
  return null;
}

export function normalizeFactorRows(
  factorRows: number[][],
  factorMeta: FactorNormalizationMeta[],
  cfg?: Partial<FactorNormalizationConfig>,
): FactorNormalizationResult {
  const config: FactorNormalizationConfig = { ...DEFAULT_CONFIG, ...(cfg ?? {}) };
  const n = factorRows.length;
  const k = factorMeta.length;
  const targetDailyVol =
    config.targetAnnualVol != null ? config.targetAnnualVol / Math.sqrt(252) : null;

  const transformedRows: (number | null)[][] = Array.from({ length: n }, () =>
    new Array(k).fill(null),
  );
  const winsorizedRows: (number | null)[][] = Array.from({ length: n }, () =>
    new Array(k).fill(null),
  );
  const normalizedRows: (number | null)[][] = Array.from({ length: n }, () =>
    new Array(k).fill(null),
  );

  const ambiguousFactors: FactorCode[] = [];
  const insufficientObservationsByFactor: Record<string, number> = {};
  let totalRowsDroppedForNormalization = 0;

  for (let fi = 0; fi < k; fi++) {
    const meta = factorMeta[fi]!;
    if (meta.inputType === "AMBIGUOUS") ambiguousFactors.push(meta.code);
    insufficientObservationsByFactor[meta.code] = 0;
    const rawSeries = factorRows.map((row) => row[fi] ?? NaN);
    const transformedSeries: (number | null)[] = rawSeries.map((_, t) =>
      transformValue(rawSeries, t, meta.inputType),
    );

    for (let t = 0; t < n; t++) {
      const x = transformedSeries[t];
      transformedRows[t]![fi] = x;
      if (x == null) {
        insufficientObservationsByFactor[meta.code]! += 1;
        continue;
      }
      const hist = rollingHistory(transformedSeries, t, config.rollingWindow);
      if (hist.length < config.minObservations) {
        insufficientObservationsByFactor[meta.code]! += 1;
        continue;
      }
      const mu = mean(hist);
      const sigma = sampleStd(hist);
      if (!(sigma > 0) || !Number.isFinite(sigma)) {
        insufficientObservationsByFactor[meta.code]! += 1;
        continue;
      }
      const lower = mu - config.winsorSigma * sigma;
      const upper = mu + config.winsorSigma * sigma;
      const winsorized = Math.max(lower, Math.min(upper, x));
      winsorizedRows[t]![fi] = winsorized;
      let normalized = winsorized / sigma;
      if (targetDailyVol != null) normalized *= targetDailyVol;
      normalizedRows[t]![fi] = normalized;
    }
  }

  for (let t = 0; t < n; t++) {
    const rowHasMissing = normalizedRows[t]!.some((v) => v == null || !Number.isFinite(v));
    if (rowHasMissing) totalRowsDroppedForNormalization++;
  }

  return {
    normalizedRows,
    transformedRows,
    winsorizedRows,
    diagnostics: {
      config,
      ambiguousFactors,
      insufficientObservationsByFactor,
      totalRowsDroppedForNormalization,
    },
  };
}
