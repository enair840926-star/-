import { clamp, round } from "./indicators";
import { nextSessionBoundary } from "./sessions";
import type {
  AssetId,
  ConfidenceLabel,
  Direction,
  EventLayer,
  FusionResult,
  MacroLayer,
  Regime,
  TechnicalLayer,
} from "./types";
import { BASE_FUSION_WEIGHTS, MAX_VALID_HOURS } from "./weights";

/** 레이어가 "방향성 있음"으로 인정되는 최소 절대 점수 */
const SIGNAL_THRESHOLD = 0.5;
/** 이 확신도 미만이면 방향을 중립으로 강등한다 */
const DIRECTION_GATE = 35;

const REGIME_MULTIPLIER: Record<Regime, number> = {
  ALIGNED: 1.15,
  PARTIAL: 0.9,
  CONFLICT: 0.5,
  RANGE: 0.6,
};

const REGIME_LABEL: Record<Regime, string> = {
  ALIGNED: "동조",
  PARTIAL: "부분 동조",
  CONFLICT: "상충",
  RANGE: "양측 중립",
};

export function regimeLabel(regime: Regime): string {
  return REGIME_LABEL[regime];
}

function fmtKST(ts: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function classifyRegime(technicalScore: number, macroScore: number): Regime {
  const tSignal = Math.abs(technicalScore) >= SIGNAL_THRESHOLD;
  const mSignal = Math.abs(macroScore) >= SIGNAL_THRESHOLD;
  if (!tSignal && !mSignal) return "RANGE";
  if (tSignal && mSignal) {
    return Math.sign(technicalScore) === Math.sign(macroScore) ? "ALIGNED" : "CONFLICT";
  }
  return "PARTIAL";
}

function discretize(score: number, conviction: number): Direction {
  if (conviction < DIRECTION_GATE) return 0;
  if (score >= 1) return 2;
  if (score >= 0.35) return 1;
  if (score <= -1) return -2;
  if (score <= -0.35) return -1;
  return 0;
}

function confidenceLabel(conviction: number): ConfidenceLabel {
  if (conviction >= 65) return "높음";
  if (conviction >= 40) return "중간";
  return "낮음";
}

function directionWord(direction: Direction): string {
  return (
    { 2: "강한 상승", 1: "상승", 0: "중립", "-1": "하락", "-2": "강한 하락" } as Record<
      string,
      string
    >
  )[String(direction)];
}

function buildPlaybook(
  regime: Regime,
  direction: Direction,
  technical: TechnicalLayer,
  events: EventLayer,
  macroLean: string,
): string {
  if (events.activeBlackout) {
    const until = fmtKST(Date.parse(events.activeBlackout.blackoutEnd));
    return `블랙아웃: ${events.activeBlackout.label} 영향권 — ${until}까지 신규 진입 보류, 기존 포지션은 리스크 축소`;
  }

  if (technical.flags.includes("TECH_PENDING")) {
    const lean = macroLean;
    return `차트 레이어 대기 · 매크로 편향 ${lean} — v4 통합 번들을 붙여야 방향·무효화 레벨이 확정된다`;
  }

  const side = direction > 0 ? "롱" : direction < 0 ? "숏" : null;
  const exhausted = technical.rangeUsage !== null && technical.rangeUsage > 1.2;
  const squeeze = technical.volRegime === "SQUEEZE";

  if (regime === "CONFLICT") {
    return "관망 우선: 매크로와 차트가 반대 방향 — 세션 레인지 이탈이 확인된 쪽만 소액 대응, 방향 베팅 금지";
  }
  if (regime === "RANGE") {
    return squeeze
      ? "레인지·변동성 수축: 상단 매도·하단 매수 후 짧은 익절, 돌파 발생 시 즉시 중립화하고 재분석"
      : "레인지: 세션 고저 양끝에서만 대응, 중간 구간 진입 금지";
  }
  if (!side) {
    return "방향 미확정: 확신도가 게이트 미만 — 진입 근거가 새로 생기기 전까지 관망";
  }

  const base =
    regime === "ALIGNED"
      ? `${side} 추세 추종: 되돌림 진입 우선`
      : `${side} 제한적 추종: 절반 사이즈·짧은 목표`;
  const caution = exhausted
    ? "당일 레인지 소진 — 신고가/신저가 추격 금지, 되돌림만"
    : squeeze
      ? "변동성 수축 — 돌파 확인 후 진입"
      : "세션 전환마다 재확인";
  const level =
    direction > 0 && technical.invalidation.long !== null
      ? `무효화 ${technical.invalidation.long}`
      : direction < 0 && technical.invalidation.short !== null
        ? `무효화 ${technical.invalidation.short}`
        : "무효화 레벨 미산출";
  return `${base} · ${caution} · ${level}`;
}

function buildRationale(
  regime: Regime,
  direction: Direction,
  macro: MacroLayer,
  technical: TechnicalLayer,
): string {
  const topFactors = macro.factors.slice(0, 2);
  const macroText = topFactors.length
    ? topFactors
        .map((factor) => `${factor.label} ${factor.stance > 0 ? "＋" : factor.stance < 0 ? "－" : "0"}`)
        .join("·")
    : "매크로 근거 부족";
  const higher = technical.timeframes.find((read) => read.tf === "H4" || read.tf === "D1");
  const techText = higher ? `${higher.tf} ${higher.note}` : "기술 근거 부족";
  return `${REGIME_LABEL[regime]} · ${macroText} / ${techText} → ${directionWord(direction)}`;
}

function buildTriggers(
  direction: Direction,
  technical: TechnicalLayer,
  events: EventLayer,
  validUntil: number | null,
): string[] {
  const triggers: string[] = [];
  const level =
    direction > 0
      ? technical.invalidation.long
      : direction < 0
        ? technical.invalidation.short
        : null;
  if (level !== null) {
    triggers.push(
      `${direction > 0 ? "하방" : "상방"} 무효화 ${level} 이탈 시 기술 레이어 재계산`,
    );
  }
  if (technical.prevDayHigh !== null && technical.prevDayLow !== null) {
    triggers.push(`전일 고저 ${technical.prevDayLow} / ${technical.prevDayHigh} 돌파 시 재평가`);
  }
  if (events.nextBlackoutStart) {
    triggers.push(`${fmtKST(Date.parse(events.nextBlackoutStart))} 이벤트 블랙아웃 진입`);
  }
  if (validUntil) triggers.push(`${fmtKST(validUntil)} 세션 경계 — 스냅샷 만료`);
  if (technical.volRegime === "EXPANSION") {
    triggers.push("변동성 확장 국면 — 급변 시 즉시 재수집");
  }
  return triggers;
}

function resolveValidUntil(now: Date, events: EventLayer): number | null {
  const candidates: number[] = [now.getTime() + MAX_VALID_HOURS * 3_600_000];
  const boundary = nextSessionBoundary(now);
  if (boundary) candidates.push(boundary.t);
  if (events.nextBlackoutStart) {
    const start = Date.parse(events.nextBlackoutStart);
    if (Number.isFinite(start)) candidates.push(start);
  }
  const min = Math.min(...candidates);
  return Number.isFinite(min) ? min : null;
}

/**
 * 융합 레이어. 두 레이어의 원값을 수정하지 않고 읽기만 한다.
 *
 * eT = wT × techConf, eM = wM × macroConf
 * score = (eT·tech + eM·macro) / (eT + eM)
 * conviction = 100 × (|score|/2) × 평균컨피던스 × 레짐배수, 이후 이벤트 상한 적용
 */
export function fuse(
  asset: AssetId,
  macro: MacroLayer,
  technical: TechnicalLayer,
  events: EventLayer,
  now: Date,
): FusionResult {
  const weights = BASE_FUSION_WEIGHTS[events.maxTier];
  const eT = weights.technical * technical.confidence;
  const eM = weights.macro * macro.confidence;
  const den = eT + eM;
  const score = den > 0 ? (eT * technical.score + eM * macro.score) / den : 0;

  const regime = classifyRegime(technical.score, macro.score);
  const avgConfidence = 0.5 * technical.confidence + 0.5 * macro.confidence;
  let conviction = 100 * (Math.abs(score) / 2) * avgConfidence * REGIME_MULTIPLIER[regime];
  conviction = Math.min(conviction, events.convictionCap);
  if (events.activeBlackout) conviction = Math.min(conviction, 30);
  conviction = Math.round(clamp(conviction, 0, 100));

  const direction = discretize(score, conviction);
  const validUntil = resolveValidUntil(now, events);
  const flags = [...macro.flags, ...technical.flags, ...events.flags];
  if (den <= 0) flags.push("FUSION_NO_CONFIDENCE");

  return {
    asset,
    direction,
    conviction,
    confidence: confidenceLabel(conviction),
    score: round(score, 3),
    regime,
    weights,
    playbook: buildPlaybook(
      regime,
      direction,
      technical,
      events,
      macro.score > 0.35 ? "상승" : macro.score < -0.35 ? "하락" : "중립",
    ),
    rationale: buildRationale(regime, direction, macro, technical),
    reanalyzeTriggers: buildTriggers(direction, technical, events, validUntil),
    validUntil: validUntil ? new Date(validUntil).toISOString() : null,
    macro,
    technical,
    events,
    flags,
  };
}
