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

import { MACRO_WEIGHTS } from "../weights";
import type { AssetId, MacroFactorInput, Stance } from "../types";

/**
 * 루브릭에 맞는 팩터 입력을 만든다.
 * 수치형은 원하는 stance가 나오는 밴드의 대표값을 역산해 `value`로 넣는다.
 */
export function factorInput(
  asset: AssetId,
  key: string,
  stance: Stance,
  confidence = 0.9,
): MacroFactorInput {
  const spec = MACRO_WEIGHTS[asset][key];
  if (!spec) throw new Error(`알 수 없는 팩터: ${asset}.${key}`);
  const base = { key, confidence, note: `테스트 ${key} ${stance}` };
  if (spec.kind === "ordinal") return { ...base, stance };

  const bands = spec.bands!;
  const index = bands.findIndex((band) => band.stance === stance);
  if (index < 0) throw new Error(`${asset}.${key} 밴드에 stance ${stance}가 없습니다`);
  const upper = bands[index].max;
  const lower = index === 0 ? -Infinity : bands[index - 1].max;
  const value =
    Number.isFinite(upper) && Number.isFinite(lower)
      ? (upper + lower) / 2
      : Number.isFinite(upper)
        ? upper - 1
        : lower + 1;
  return { ...base, value };
}

/** 자산의 모든 팩터를 같은 stance로 채운다 */
export function allFactors(asset: AssetId, stance: Stance, confidence = 0.9): MacroFactorInput[] {
  return Object.keys(MACRO_WEIGHTS[asset]).map((key) =>
    factorInput(asset, key, stance, confidence),
  );
}
