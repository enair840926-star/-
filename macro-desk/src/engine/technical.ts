import {
  atr,
  clamp,
  ema,
  lastN,
  normalizeCandles,
  percentileRank,
  round,
  rsi,
  squash,
  swings,
} from "./indicators";
import type {
  Candle,
  CandleSeries,
  TechnicalLayer,
  Timeframe,
  TimeframeRead,
  VolRegime,
} from "./types";
import { TIMEFRAMES } from "./types";
import { TF_COMPONENT_MIX, TF_MIN_BARS, TF_WEIGHTS } from "./weights";

const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

function lastFinite(series: number[]): number | null {
  for (let i = series.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(series[i])) return series[i];
  }
  return null;
}

/** EMA 스택·기울기·위치를 ATR로 정규화한 추세 점수 (-2 ~ +2) */
export function trendScore(candles: Candle[]): { score: number; note: string } | null {
  const closes = candles.map((candle) => candle.c);
  const fast = ema(closes, 20);
  const slow = ema(closes, 50);
  const atrSeries = atr(candles, 14);
  const emaFast = lastFinite(fast);
  const emaSlow = lastFinite(slow);
  const range = lastFinite(atrSeries);
  const close = last(closes);
  if (emaFast === null || emaSlow === null || range === null || range <= 0 || close === undefined) {
    return null;
  }
  const fastPrev = fast[fast.length - 6];
  const stack = squash(emaFast - emaSlow, range);
  const slope = Number.isFinite(fastPrev) ? squash(emaFast - fastPrev, range) : 0;
  const location = squash(close - emaSlow, range * 1.5);
  const score = clamp(2 * (0.4 * stack + 0.35 * slope + 0.25 * location), -2, 2);
  const stackNote = emaFast > emaSlow ? "EMA20>EMA50" : "EMA20<EMA50";
  const slopeNote = slope > 0.15 ? "상승기울기" : slope < -0.15 ? "하락기울기" : "평탄";
  return { score, note: `${stackNote}·${slopeNote}` };
}

/** 스윙 고저 시퀀스 + 돌파(BOS) 기반 구조 점수 (-2 ~ +2) */
export function structureScore(candles: Candle[]): { score: number; note: string } | null {
  const points = swings(candles, 2, 2);
  const highs = points.filter((point) => point.kind === "high");
  const lows = points.filter((point) => point.kind === "low");
  if (highs.length < 2 || lows.length < 2) return null;

  const [prevHigh, lastHigh] = lastN(highs, 2);
  const [prevLow, lastLow] = lastN(lows, 2);
  const hh = lastHigh.price > prevHigh.price;
  const hl = lastLow.price > prevLow.price;

  let score: number;
  let note: string;
  if (hh && hl) {
    score = 1.5;
    note = "HH/HL 상승구조";
  } else if (!hh && !hl) {
    score = -1.5;
    note = "LH/LL 하락구조";
  } else if (hh && !hl) {
    score = 0.5;
    note = "HH/LL 확장";
  } else {
    score = 0;
    note = "LH/HL 수축";
  }

  const close = last(candles)?.c;
  if (close !== undefined) {
    if (close > lastHigh.price) {
      score += 0.5;
      note += "·상방 BOS";
    } else if (close < lastLow.price) {
      score -= 0.5;
      note += "·하방 BOS";
    }
  }
  return { score: clamp(score, -2, 2), note };
}

/** RSI + ATR 정규화 ROC 기반 모멘텀 점수 (-2 ~ +2) */
export function momentumScore(candles: Candle[]): { score: number; note: string } | null {
  const closes = candles.map((candle) => candle.c);
  const rsiSeries = rsi(closes, 14);
  const atrSeries = atr(candles, 14);
  const rsiNow = lastFinite(rsiSeries);
  const range = lastFinite(atrSeries);
  const close = last(closes);
  if (rsiNow === null || range === null || range <= 0 || close === undefined) return null;
  const ref = closes[closes.length - 7];
  const rsiPart = squash(rsiNow - 50, 12);
  const rocPart = Number.isFinite(ref) ? squash(close - ref, range * 1.2) : 0;
  const score = clamp(2 * (0.5 * rsiPart + 0.5 * rocPart), -2, 2);
  return { score, note: `RSI ${Math.round(rsiNow)}` };
}

function readTimeframe(tf: Timeframe, candles: Candle[]): TimeframeRead | null {
  if (candles.length < TF_MIN_BARS[tf]) return null;
  const mix = TF_COMPONENT_MIX[tf];
  const trend = mix.trend > 0 ? trendScore(candles) : null;
  const structure = mix.structure > 0 ? structureScore(candles) : null;
  const momentum = mix.momentum > 0 ? momentumScore(candles) : null;

  const parts: Array<{ value: number; weight: number }> = [];
  if (trend) parts.push({ value: trend.score, weight: mix.trend });
  if (structure) parts.push({ value: structure.score, weight: mix.structure });
  if (momentum) parts.push({ value: momentum.score, weight: mix.momentum });
  if (!parts.length) return null;

  const den = parts.reduce((sum, part) => sum + part.weight, 0);
  const score = parts.reduce((sum, part) => sum + part.value * part.weight, 0) / den;
  const note = [trend?.note, structure?.note, momentum?.note].filter(Boolean).join(" · ");

  return {
    tf,
    score: round(score, 3),
    weight: TF_WEIGHTS[tf],
    trend: trend ? round(trend.score, 3) : null,
    structure: structure ? round(structure.score, 3) : null,
    momentum: momentum ? round(momentum.score, 3) : null,
    note,
    bars: candles.length,
  };
}

function volatilityRegime(candles: Candle[]): { regime: VolRegime; atrNow: number | null } {
  const series = atr(candles, 14).filter((x) => Number.isFinite(x));
  const atrNow = series.length ? series[series.length - 1] : null;
  if (atrNow === null || series.length < 30) return { regime: "NORMAL", atrNow };
  const rank = percentileRank(lastN(series, 120), atrNow);
  const regime: VolRegime = rank < 0.3 ? "SQUEEZE" : rank > 0.7 ? "EXPANSION" : "NORMAL";
  return { regime, atrNow };
}

/** 당일 레인지 / 최근 20일 평균 레인지 */
function rangeUsage(daily: Candle[]): number | null {
  if (daily.length < 6) return null;
  const today = last(daily);
  if (!today) return null;
  const history = lastN(daily.slice(0, -1), 20).map((candle) => candle.h - candle.l);
  if (!history.length) return null;
  const adr = history.reduce((a, b) => a + b, 0) / history.length;
  if (adr <= 0) return null;
  return (today.h - today.l) / adr;
}

function invalidationLevels(
  operational: Candle[],
  atrValue: number | null,
  fallback: { high: number | null; low: number | null },
): { long: number | null; short: number | null } {
  const buffer = atrValue && atrValue > 0 ? atrValue * 0.25 : 0;
  const points = swings(operational, 2, 2);
  const lows = points.filter((point) => point.kind === "low");
  const highs = points.filter((point) => point.kind === "high");
  const swingLow = lows.length ? lows[lows.length - 1].price : fallback.low;
  const swingHigh = highs.length ? highs[highs.length - 1].price : fallback.high;
  return {
    long: swingLow === null ? null : round(swingLow - buffer, 5),
    short: swingHigh === null ? null : round(swingHigh + buffer, 5),
  };
}

/**
 * 기술 레이어 계산. 매크로 입력을 일절 참조하지 않는다(레이어 잠금 원칙).
 */
export function computeTechnical(series: CandleSeries): TechnicalLayer {
  const flags: string[] = [];
  const bySeries: Partial<Record<Timeframe, Candle[]>> = {};
  for (const tf of TIMEFRAMES) {
    bySeries[tf] = normalizeCandles(series[tf]);
  }

  const reads: TimeframeRead[] = [];
  for (const tf of TIMEFRAMES) {
    const candles = bySeries[tf] ?? [];
    if (!candles.length) {
      flags.push(`TF_${tf}_MISSING`);
      continue;
    }
    const read = readTimeframe(tf, candles);
    if (!read) {
      flags.push(`TF_${tf}_WARMUP`);
      continue;
    }
    reads.push(read);
  }

  const daily = bySeries.D1 ?? [];
  const operational = (bySeries.H1?.length ? bySeries.H1 : bySeries.H4) ?? [];
  const { regime, atrNow } = volatilityRegime(operational);
  const usage = rangeUsage(daily);
  const prevDay = daily.length >= 2 ? daily[daily.length - 2] : null;
  const lastPrice =
    last(bySeries.M15 ?? [])?.c ??
    last(bySeries.H1 ?? [])?.c ??
    last(bySeries.H4 ?? [])?.c ??
    last(daily)?.c ??
    null;

  const coverage = reads.reduce((sum, read) => sum + read.weight, 0);
  const score = coverage > 0
    ? reads.reduce((sum, read) => sum + read.score * read.weight, 0) / coverage
    : 0;

  const magnitude = reads.reduce((sum, read) => sum + Math.abs(read.score) * read.weight, 0);
  const directional = Math.abs(reads.reduce((sum, read) => sum + read.score * read.weight, 0));
  const alignment = magnitude > 0.15 ? clamp(directional / magnitude, 0, 1) : 0;

  let confidence = clamp(0.2 + 0.55 * alignment + 0.25 * coverage, 0, 1);
  if (usage !== null && usage > 1.2) {
    confidence *= 0.85;
    flags.push("RANGE_EXHAUSTED");
  }
  if (regime === "SQUEEZE") {
    confidence *= 0.9;
    flags.push("VOL_SQUEEZE");
  }
  if (coverage < 0.5) flags.push("TF_COVERAGE_LOW");

  return {
    score: round(score, 3),
    confidence: round(clamp(confidence, 0, 1), 3),
    alignment: round(alignment, 3),
    volRegime: regime,
    atrH1: atrNow === null ? null : round(atrNow, 5),
    rangeUsage: usage === null ? null : round(usage, 2),
    prevDayHigh: prevDay ? round(prevDay.h, 5) : null,
    prevDayLow: prevDay ? round(prevDay.l, 5) : null,
    lastPrice: lastPrice === null ? null : round(lastPrice, 5),
    invalidation: invalidationLevels(operational, atrNow, {
      high: prevDay ? prevDay.h : null,
      low: prevDay ? prevDay.l : null,
    }),
    timeframes: reads,
    flags,
  };
}
