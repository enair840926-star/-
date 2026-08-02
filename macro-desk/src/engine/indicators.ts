import type { Candle, CandleRow } from "./types";

export const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export const round = (value: number, digits = 2) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function normalizeCandles(rows: CandleRow[] | Candle[] | undefined): Candle[] {
  if (!Array.isArray(rows)) return [];
  const out: Candle[] = [];
  for (const row of rows) {
    if (Array.isArray(row)) {
      const [t, o, h, l, c, v] = row;
      if (![o, h, l, c].every((x) => Number.isFinite(x))) continue;
      out.push({ t: String(t), o, h, l, c, ...(Number.isFinite(v as number) ? { v } : {}) });
      continue;
    }
    if (!row || typeof row !== "object") continue;
    const { t, o, h, l, c, v } = row as Candle;
    if (![o, h, l, c].every((x) => Number.isFinite(x))) continue;
    out.push({ t: String(t), o, h, l, c, ...(Number.isFinite(v as number) ? { v } : {}) });
  }
  // 오름차순(과거 → 최신) 정렬. 입력이 최신순으로 와도 안전하게 처리한다.
  const times = out.map((candle) => Date.parse(candle.t));
  if (times.every((x) => Number.isFinite(x))) {
    return out
      .map((candle, index) => ({ candle, ts: times[index] }))
      .sort((a, b) => a.ts - b.ts)
      .map((x) => x.candle);
  }
  return out;
}

/** 지수이동평균 시계열. 초기값은 첫 period 단순평균. */
export function ema(values: number[], period: number): number[] {
  if (values.length < period || period <= 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder ATR 시계열 */
export function atr(candles: Candle[], period = 14): number[] {
  if (candles.length < period + 1) return [];
  const tr: number[] = [0];
  for (let i = 1; i < candles.length; i += 1) {
    const current = candles[i];
    const prevClose = candles[i - 1].c;
    tr[i] = Math.max(
      current.h - current.l,
      Math.abs(current.h - prevClose),
      Math.abs(current.l - prevClose),
    );
  }
  const out: number[] = [];
  let prev = tr.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i += 1) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

/** Wilder RSI 시계열 */
export function rsi(values: number[], period = 14): number[] {
  if (values.length < period + 1) return [];
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gain += change;
    else loss -= change;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  const out: number[] = [];
  const toRsi = (g: number, l: number) => (l === 0 ? 100 : 100 - 100 / (1 + g / l));
  out[period] = toRsi(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const up = change > 0 ? change : 0;
    const down = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + up) / period;
    avgLoss = (avgLoss * (period - 1) + down) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

export interface Swing {
  index: number;
  price: number;
  kind: "high" | "low";
}

/**
 * 프랙탈 스윙 포인트. left/right 봉보다 극단인 지점만 채택한다.
 * 마지막 right개 봉은 아직 확정되지 않았으므로 제외된다.
 */
export function swings(candles: Candle[], left = 2, right = 2): Swing[] {
  const out: Swing[] = [];
  for (let i = left; i < candles.length - right; i += 1) {
    const { h, l } = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = i - left; j <= i + right; j += 1) {
      if (j === i) continue;
      if (candles[j].h >= h) isHigh = false;
      if (candles[j].l <= l) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: h, kind: "high" });
    if (isLow) out.push({ index: i, price: l, kind: "low" });
  }
  return out;
}

export function lastN<T>(items: T[], count: number): T[] {
  return count <= 0 ? [] : items.slice(Math.max(0, items.length - count));
}

export function percentileRank(series: number[], value: number): number {
  const valid = series.filter((x) => Number.isFinite(x));
  if (!valid.length) return 0.5;
  const below = valid.filter((x) => x <= value).length;
  return below / valid.length;
}

export function weightedMean(pairs: Array<{ value: number; weight: number }>): number {
  const den = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (den <= 0) return 0;
  return pairs.reduce((sum, pair) => sum + pair.value * pair.weight, 0) / den;
}

export function weightedStdev(
  pairs: Array<{ value: number; weight: number }>,
  mean: number,
): number {
  const den = pairs.reduce((sum, pair) => sum + pair.weight, 0);
  if (den <= 0) return 0;
  const variance =
    pairs.reduce((sum, pair) => sum + pair.weight * (pair.value - mean) ** 2, 0) / den;
  return Math.sqrt(variance);
}

/** x/scale를 [-limit, limit]로 부드럽게 압축 (tanh 유사, 미분 불필요한 근사) */
export function squash(x: number, scale: number, limit = 1): number {
  if (!Number.isFinite(x) || !Number.isFinite(scale) || scale <= 0) return 0;
  const ratio = x / scale;
  return limit * Math.tanh(ratio);
}
