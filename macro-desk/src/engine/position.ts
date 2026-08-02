/**
 * 위치 레이어 (macro-only 전용).
 *
 * 번들이 없어도 얻을 수 있는 "현재가가 전일 종가·주요 레벨 대비 어디인가"를 읽는다.
 * **방향은 바꾸지 않는다.** 매크로 편향을 가격이 확인해 주는지만 보고 확신도와 문장을 조정한다.
 */
import { clamp, round } from "./indicators";
import type { AssetId, LevelInput, PositionLayer } from "./types";
import { NEUTRAL_BAND_PCT } from "./weights";

/** 이 값 미만이면 "가격이 아직 말이 없다"로 본다 */
export const POSITION_SIGNAL_THRESHOLD = 0.3;
/** 레벨 돌파·이탈 가산치 */
const LEVEL_BONUS = 0.3;

export function computePosition(asset: AssetId, levels: LevelInput | undefined): PositionLayer {
  const flags: string[] = [];
  const last = levels?.last;
  const prevClose = levels?.prevClose;

  if (!Number.isFinite(last as number) || !Number.isFinite(prevClose as number) || !prevClose) {
    return {
      score: 0,
      movePct: null,
      brokeResistance: false,
      lostSupport: false,
      note: "관측 레벨 미수집",
      flags: ["POSITION_UNAVAILABLE"],
    };
  }

  const band = NEUTRAL_BAND_PCT[asset];
  const movePct = ((last as number) - prevClose) / prevClose * 100;
  let score = Math.tanh(movePct / band);

  const nearestResistance = levels?.resistance?.length ? Math.min(...levels.resistance) : null;
  const nearestSupport = levels?.support?.length ? Math.max(...levels.support) : null;
  const brokeResistance = nearestResistance !== null && (last as number) > nearestResistance;
  const lostSupport = nearestSupport !== null && (last as number) < nearestSupport;
  if (brokeResistance) score += LEVEL_BONUS;
  if (lostSupport) score -= LEVEL_BONUS;
  score = clamp(score, -1, 1);

  const parts = [`전일 종가 ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}%`];
  if (brokeResistance) parts.push(`저항 ${nearestResistance} 상향 돌파`);
  if (lostSupport) parts.push(`지지 ${nearestSupport} 이탈`);

  return {
    score: round(score, 3),
    movePct: round(movePct, 3),
    brokeResistance,
    lostSupport,
    note: parts.join(" · "),
    flags,
  };
}

/** 매크로 편향과 가격 위치의 관계를 판정한다. 매크로 편향이 없으면 확인할 것도 없다. */
export function positionRelation(
  position: PositionLayer,
  macroScore: number,
): { relation: PositionLayer["relation"]; multiplier: number } {
  if (position.flags.includes("POSITION_UNAVAILABLE")) {
    return { relation: "미수집", multiplier: 1 };
  }
  if (Math.abs(position.score) < POSITION_SIGNAL_THRESHOLD || Math.abs(macroScore) < 0.35) {
    return { relation: "중립", multiplier: 1 };
  }
  return Math.sign(position.score) === Math.sign(macroScore)
    ? { relation: "확인", multiplier: 1.15 }
    : { relation: "반증", multiplier: 0.7 };
}
