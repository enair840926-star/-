import type { CandleRow } from "../types";

const HOUR = 3_600_000;

export interface SeriesOptions {
  bars: number;
  start?: number;
  /** 봉당 추세 변화량 */
  drift?: number;
  /** 사인파 진폭 (레인지 생성용) */
  wave?: number;
  /** 봉 하나의 고저 폭 */
  spread?: number;
  stepMs?: number;
  startTime?: number;
}

/** 결정적(난수 없음) 합성 캔들. 테스트 재현성을 위해 사인파만 사용한다. */
export function makeSeries({
  bars,
  start = 100,
  drift = 0,
  wave = 0,
  spread = 1,
  stepMs = HOUR,
  startTime = Date.UTC(2026, 0, 1),
}: SeriesOptions): CandleRow[] {
  const rows: CandleRow[] = [];
  let prevClose = start;
  for (let i = 0; i < bars; i += 1) {
    const base = start + drift * i + wave * Math.sin((i / 6) * Math.PI);
    const open = prevClose;
    const close = base;
    // 꼬리 길이를 봉마다 다르게 줘서 인접 봉의 고·저가 동률로 프랙탈이 사라지는 것을 막는다.
    const upperWick = spread * (0.5 + 0.25 * Math.sin(i * 1.7));
    const lowerWick = spread * (0.5 + 0.25 * Math.cos(i * 1.3));
    const high = Math.max(open, close) + upperWick;
    const low = Math.min(open, close) - lowerWick;
    rows.push([new Date(startTime + i * stepMs).toISOString(), open, high, low, close]);
    prevClose = close;
  }
  return rows;
}

export function trendingUp(bars = 200): CandleRow[] {
  return makeSeries({ bars, drift: 0.5, wave: 0.8, spread: 1.2 });
}

export function trendingDown(bars = 200): CandleRow[] {
  return makeSeries({ bars, start: 200, drift: -0.5, wave: 0.8, spread: 1.2 });
}

export function ranging(bars = 200): CandleRow[] {
  return makeSeries({ bars, drift: 0, wave: 3, spread: 1 });
}

export function fullSeries(kind: "up" | "down" | "range") {
  const make = kind === "up" ? trendingUp : kind === "down" ? trendingDown : ranging;
  return { D1: make(), H4: make(), H1: make(), M15: make() };
}
