/**
 * Forecasting — pure functions on a numeric time series (one value per
 * complete day / week / month). No database, no randomness: the same history
 * always gives the same projection, so every number on a forecast widget can
 * be reproduced and explained.
 *
 * Methods (picked automatically by holdout error, simplest wins ties):
 *  - linear: ordinary least-squares trend y = a + b·t;
 *  - holt:   Holt's double exponential smoothing (level + trend), α/β chosen
 *            by grid search on one-step-ahead squared error;
 *  - either one with a weekly (day-of-week) pattern when the series is daily,
 *    has ≥ 8 weeks of history and the pattern explains enough variance.
 * Model selection: the last ~20% of history (≤ horizon, ≤ 28 points) is held
 * out, each candidate is fitted on the rest and scored by mean absolute error
 * on the held-out part; the winner is refitted on everything.
 *
 * Intervals are 95% prediction intervals: ±1.96·σ (σ = in-sample residual
 * standard deviation) scaled by the method's horizon-variance formula, so
 * they always widen with the horizon. Totals over the horizon assume
 * independent errors (√Σσ²) — stated in the assumptions.
 *
 * History rules: fewer than MIN_POINTS → no projection (refused, with the
 * reason); fewer than WARN_POINTS → linear only, with a warning.
 */
import type { Bucket } from './types';

export const MIN_POINTS = 8;
export const WARN_POINTS = 14;
const Z95 = 1.96;
const SEASON = 7;

export type ForecastMethod = 'linear' | 'holt' | 'linear+weekly' | 'holt+weekly' | 'none';

export interface ForecastOptions {
  horizon: number;
  unit: Bucket;
  seasonality?: 'auto' | 'none';
  /** What-if: extra growth in % per month applied on top of the trend. */
  growthPctPerMonth?: number | null;
  cumulative?: boolean;
  /** Clamp projections/bands at 0 (counts, amounts). Defaults to true when history has no negatives. */
  nonNegative?: boolean;
  /** Weekday (0 = Monday) of the first history point — aligns the weekly pattern in explanations. */
  firstWeekday?: number;
}

export interface ProjectionPoint {
  step: number;
  value: number;
  lower: number;
  upper: number;
  /** Without the what-if scenario (only when a scenario is set). */
  baseline?: number;
  cumulative?: number;
  cumulativeLower?: number;
  cumulativeUpper?: number;
}

export interface ForecastResult {
  method: ForecastMethod;
  points: number;
  projection: ProjectionPoint[];
  totals: { history: number; projected: number; lower: number; upper: number; baselineProjected?: number } | null;
  params: Record<string, number>;
  holdout: { size: number; mae: Partial<Record<ForecastMethod, number>> } | null;
  seasonality: { detected: boolean; strength: number; indices?: number[] };
  sigma: number;
  assumptions: string[];
  warnings: string[];
}

// ─── Basic statistics ───────────────────────────────────────────────────────

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
function variance(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1);
}
export const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;

// ─── Linear trend ───────────────────────────────────────────────────────────

export interface LinearFit { a: number; b: number; sigma: number; n: number; xbar: number; sxx: number }

export function linearFit(y: number[]): LinearFit {
  const n = y.length;
  const xs = y.map((_, i) => i);
  const xbar = mean(xs), ybar = mean(y);
  const sxx = sum(xs.map(x => (x - xbar) ** 2));
  const b = sxx === 0 ? 0 : sum(xs.map((x, i) => (x - xbar) * (y[i] - ybar))) / sxx;
  const a = ybar - b * xbar;
  const resid = y.map((v, i) => v - (a + b * i));
  // n − 2 degrees of freedom (two fitted parameters).
  const sigma = n > 2 ? Math.sqrt(sum(resid.map(r => r * r)) / (n - 2)) : 0;
  return { a, b, sigma, n, xbar, sxx };
}

export function linearForecast(fit: LinearFit, h: number): number {
  return fit.a + fit.b * (fit.n - 1 + h);
}

/** Half-width multiplier (×σ) of the OLS prediction interval h steps ahead. */
export function linearSpread(fit: LinearFit, h: number): number {
  const x0 = fit.n - 1 + h;
  return Math.sqrt(1 + 1 / fit.n + (fit.sxx ? (x0 - fit.xbar) ** 2 / fit.sxx : 0));
}

// ─── Holt's linear (double exponential) smoothing ───────────────────────────

export interface HoltFit { alpha: number; beta: number; level: number; trend: number; sigma: number; sse: number }

export function holtRun(y: number[], alpha: number, beta: number): HoltFit {
  let level = y[0];
  // Initial trend: mean of the first (up to 4) differences — less noisy than y1 − y0.
  const k = Math.min(4, y.length - 1);
  let trend = k > 0 ? (y[k] - y[0]) / k : 0;
  let sse = 0;
  const errs: number[] = [];
  for (let t = 1; t < y.length; t++) {
    const f = level + trend;
    const e = y[t] - f;
    errs.push(e);
    sse += e * e;
    const prev = level;
    level = alpha * y[t] + (1 - alpha) * (level + trend);
    trend = beta * (level - prev) + (1 - beta) * trend;
  }
  const sigma = errs.length > 2 ? Math.sqrt(sse / (errs.length - 2)) : 0;
  return { alpha, beta, level, trend, sigma, sse };
}

export function holtFit(y: number[]): HoltFit {
  let best: HoltFit | null = null;
  for (let a = 0.05; a <= 0.951; a += 0.05) {
    for (let b = 0.01; b <= 0.501; b += b < 0.05 ? 0.04 : 0.05) {
      const r = holtRun(y, round(a, 2), round(b, 2));
      if (!best || r.sse < best.sse - 1e-9) best = r;
    }
  }
  return best!;
}

export function holtForecast(fit: HoltFit, h: number): number {
  return fit.level + h * fit.trend;
}

/** ETS(A,A,N) forecast-variance multiplier: Var(h) = σ²[1 + (h−1){α² + αβh + β²h(2h−1)/6}]. */
export function holtSpread(fit: HoltFit, h: number): number {
  const { alpha: a, beta: b } = fit;
  return Math.sqrt(1 + (h - 1) * (a * a + a * b * h + (b * b * h * (2 * h - 1)) / 6));
}

// ─── Weekly seasonality ─────────────────────────────────────────────────────

/** Additive day-of-week indices (sum 0) of the de-trended series, and how much variance they explain. */
export function weeklySeasonality(y: number[]): { indices: number[]; strength: number } {
  const fit = linearFit(y);
  const r = y.map((v, i) => v - (fit.a + fit.b * i));
  const idx = Array.from({ length: SEASON }, (_, k) => mean(r.filter((_, i) => i % SEASON === k)));
  const m = mean(idx);
  const indices = idx.map(v => v - m);
  const rest = r.map((v, i) => v - indices[i % SEASON]);
  const vr = variance(r);
  const strength = vr > 0 ? Math.max(0, 1 - variance(rest) / vr) : 0;
  return { indices, strength };
}

/** A weekly pattern counts when there are ≥ 8 full weeks and it explains ≥ 20% of the de-trended variance. */
export function detectWeekly(y: number[], unit: Bucket): { detected: boolean; strength: number; indices: number[] } {
  if (unit !== 'day' || y.length < SEASON * 8) return { detected: false, strength: 0, indices: [] };
  const s = weeklySeasonality(y);
  return { detected: s.strength >= 0.2, strength: s.strength, indices: s.indices };
}

// ─── Model fitting + selection ──────────────────────────────────────────────

interface Model {
  method: ForecastMethod;
  forecast: (h: number) => number;
  spread: (h: number) => number;
  sigma: number;
  params: Record<string, number>;
}

function fitModel(y: number[], method: ForecastMethod, season: number[] | null): Model {
  const seasonal = method.endsWith('+weekly') && season;
  const s = (i: number) => (seasonal ? season![i % SEASON] : 0);
  const base = seasonal ? y.map((v, i) => v - s(i)) : y;
  const n = y.length;
  if (method.startsWith('holt')) {
    const f = holtFit(base);
    return {
      method, sigma: f.sigma,
      forecast: h => holtForecast(f, h) + s(n - 1 + h),
      spread: h => holtSpread(f, h),
      params: { alpha: f.alpha, beta: f.beta, level: round(f.level, 4), trend: round(f.trend, 4) },
    };
  }
  const f = linearFit(base);
  return {
    method, sigma: f.sigma,
    forecast: h => linearForecast(f, h) + s(n - 1 + h),
    spread: h => linearSpread(f, h),
    params: { intercept: round(f.a, 4), slope: round(f.b, 4) },
  };
}

function holdoutSize(n: number, horizon: number): number {
  const h = Math.min(Math.max(2, Math.round(n * 0.2)), horizon, 28);
  return n - h >= MIN_POINTS ? h : 0;
}

/** Calendar months one bucket spans (for % per month scenarios). */
export function monthsPerBucket(unit: Bucket): number {
  switch (unit) {
    case 'day': return 1 / 30.4375;
    case 'week': return 7 / 30.4375;
    case 'month': return 1;
    case 'quarter': return 3;
    case 'year': return 12;
  }
}

const METHOD_TEXT: Record<ForecastMethod, string> = {
  linear: 'a straight-line trend (least squares)',
  holt: "Holt's double exponential smoothing (level + trend)",
  'linear+weekly': 'a straight-line trend plus the weekly (day-of-week) pattern',
  'holt+weekly': "Holt's double exponential smoothing plus the weekly (day-of-week) pattern",
  none: 'no model',
};

export function forecast(history: number[], opts: ForecastOptions): ForecastResult {
  const n = history.length;
  const unit = opts.unit;
  const assumptions: string[] = [];
  const warnings: string[] = [];
  const nonNegative = opts.nonNegative ?? history.every(v => v >= 0);
  const historyTotal = round(sum(history));

  if (n < MIN_POINTS) {
    warnings.push(`Not enough history to project: ${n} ${unit}${n === 1 ? '' : 's'} of data, at least ${MIN_POINTS} are needed. No projection was made.`);
    return { method: 'none', points: n, projection: [], totals: null, params: {}, holdout: null, seasonality: { detected: false, strength: 0 }, sigma: 0, assumptions, warnings };
  }

  const season = opts.seasonality === 'none' ? { detected: false, strength: 0, indices: [] as number[] } : detectWeekly(history, unit);
  const candidates: ForecastMethod[] = n < WARN_POINTS ? ['linear'] : ['linear', 'holt'];
  if (season.detected) candidates.push(...candidates.map(c => `${c}+weekly` as ForecastMethod));
  if (n < WARN_POINTS) warnings.push(`Only ${n} ${unit}s of history (fewer than ${WARN_POINTS}) — treat this projection as a rough guide; a simple straight-line trend was used.`);

  // Holdout model selection.
  const hold = candidates.length > 1 ? holdoutSize(n, opts.horizon) : 0;
  let chosen: ForecastMethod = candidates[0];
  const mae: Partial<Record<ForecastMethod, number>> = {};
  if (hold) {
    const train = history.slice(0, n - hold), test = history.slice(n - hold);
    const trainSeason = season.detected ? weeklySeasonality(train).indices : null;
    for (const c of candidates) {
      const m = fitModel(train, c, trainSeason);
      mae[c] = round(mean(test.map((v, i) => Math.abs(v - (nonNegative ? Math.max(0, m.forecast(i + 1)) : m.forecast(i + 1))))), 4);
    }
    // Lowest error wins; a candidate must beat the simpler one by > 1% to be preferred.
    for (const c of candidates) if (mae[c]! < mae[chosen]! * 0.99) chosen = c;
  }
  const model = fitModel(history, chosen, season.detected ? season.indices : null);

  // Projection + intervals.
  const g = opts.growthPctPerMonth ? opts.growthPctPerMonth / 100 : 0;
  const mpb = monthsPerBucket(unit);
  let clamped = false;
  const projection: ProjectionPoint[] = [];
  let cum = 0, cumVar = 0, baseCum = 0;
  for (let h = 1; h <= opts.horizon; h++) {
    let base = model.forecast(h);
    const half = Z95 * model.sigma * model.spread(h);
    let lo = base - half, hi = base + half;
    if (nonNegative) {
      if (base < 0) clamped = true;
      base = Math.max(0, base); lo = Math.max(0, lo); hi = Math.max(0, hi);
    }
    const factor = g ? (1 + g) ** (h * mpb) : 1;
    const value = base * factor;
    const pt: ProjectionPoint = { step: h, value: round(value), lower: round(lo * factor), upper: round(hi * factor) };
    if (g) pt.baseline = round(base);
    cum += value; baseCum += base;
    cumVar += ((half * factor) / Z95) ** 2;
    if (opts.cumulative) {
      const ch = Z95 * Math.sqrt(cumVar);
      pt.cumulative = round(cum);
      pt.cumulativeLower = round(nonNegative ? Math.max(0, cum - ch) : cum - ch);
      pt.cumulativeUpper = round(cum + ch);
    }
    projection.push(pt);
  }
  const totHalf = Z95 * Math.sqrt(cumVar);
  const totals = {
    history: historyTotal,
    projected: round(cum),
    lower: round(nonNegative ? Math.max(0, cum - totHalf) : cum - totHalf),
    upper: round(cum + totHalf),
    ...(g ? { baselineProjected: round(baseCum) } : {}),
  };

  // Explanations.
  assumptions.push(`Based on the last ${n} complete ${unit}s of history; assumes the recent trend continues.`);
  assumptions.push(hold
    ? `Method: ${METHOD_TEXT[chosen]} — chosen because it had the lowest error when the last ${hold} ${unit}s were held back and predicted from the earlier data.`
    : `Method: ${METHOD_TEXT[chosen]}.`);
  if (season.detected) {
    assumptions.push(`A weekly (day-of-week) pattern was found (explains ${Math.round(season.strength * 100)}% of the day-to-day variation) and is included.`);
  } else if (unit === 'day' && n < SEASON * 8) {
    assumptions.push('Weekly (day-of-week) effects are not modelled — that needs at least 8 weeks of daily history.');
  }
  assumptions.push('Yearly / holiday seasonality is not modelled (needs at least two years of history).');
  assumptions.push(`The shaded band is a 95% prediction interval (±1.96 × the typical error of ${round(model.sigma)} per ${unit}), widening further ahead.`);
  assumptions.push('The range for the total assumes errors on different ' + unit + 's are independent, so it may be optimistic.');
  if (g) assumptions.push(`What-if scenario: ${opts.growthPctPerMonth! > 0 ? '+' : ''}${opts.growthPctPerMonth}% per month applied on top of the trend (baseline kept for comparison).`);
  if (clamped) warnings.push('The trend is falling fast enough that the projection reaches zero; values below zero were shown as zero.');
  if (model.sigma === 0 && n >= MIN_POINTS) warnings.push('History fits the trend exactly, so the uncertainty band has no width — real data rarely behaves like this.');

  return {
    method: chosen, points: n, projection, totals,
    params: model.params, holdout: hold ? { size: hold, mae } : null,
    seasonality: { detected: season.detected, strength: round(season.strength, 3), ...(season.detected ? { indices: season.indices.map(v => round(v, 3)) } : {}) },
    sigma: round(model.sigma, 4), assumptions, warnings,
  };
}

/** Leading buckets before the first non-zero value (e.g. before the org started using the app). */
export function leadingZeros(history: number[]): number {
  const i = history.findIndex(v => v !== 0);
  return i < 0 ? history.length : i;
}
