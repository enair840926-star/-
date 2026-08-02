import { clamp, round } from "./indicators";
import { computePosition, positionRelation } from "./position";
import { nextSessionBoundary } from "./sessions";
import type {
  AnalysisMode,
  AssetId,
  ConfidenceLabel,
  Direction,
  EventLayer,
  FusionResult,
  LevelInput,
  MacroFactorResult,
  MacroLayer,
  PositionLayer,
  Regime,
  TechnicalLayer,
} from "./types";
import { BASE_FUSION_WEIGHTS, MAX_VALID_HOURS } from "./weights";

/** 레이어가 "방향성 있음"으로 인정되는 최소 절대 점수 */
const SIGNAL_THRESHOLD = 0.5;
/** 이 확신도 미만이면 방향을 중립으로 강등한다 */
const DIRECTION_GATE = 35;

/** 매크로 전용 모드 파라미터 */
const MACRO_ONLY = {
  /** 차트 확인이 없으므로 방향 게이트를 낮추되 확신도 상한을 건다 */
  gate: 25,
  cap: 70,
  /** 차트 미확인 할인 */
  discount: 0.9,
  /** 이 점수에서 확신도 100% 스케일에 도달 */
  fullScale: 1.5,
};

const REGIME_MULTIPLIER: Record<Regime, number> = {
  ALIGNED: 1.15,
  PARTIAL: 0.9,
  CONFLICT: 0.5,
  RANGE: 0.6,
};

const REGIME_LABEL: Record<AnalysisMode, Record<Regime, string>> = {
  fusion: {
    ALIGNED: "동조",
    PARTIAL: "부분 동조",
    CONFLICT: "상충",
    RANGE: "양측 중립",
  },
  "macro-only": {
    ALIGNED: "요인 일치",
    PARTIAL: "우세·일부 상충",
    CONFLICT: "요인 상충",
    RANGE: "요인 중립",
  },
};

export function regimeLabel(regime: Regime, mode: AnalysisMode = "fusion"): string {
  return REGIME_LABEL[mode][regime];
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

/**
 * 매크로 전용 레짐: 편향 세기(|score|)와 팩터 분산으로 4분면을 만든다.
 * 차트가 없으므로 "동조/상충"이 아니라 "매크로 팩터끼리 일치하는가"를 본다.
 */
function classifyMacroRegime(macro: MacroLayer): Regime {
  const strong = Math.abs(macro.score) >= SIGNAL_THRESHOLD;
  const mixed = macro.dispersion > 0.5;
  if (strong) return mixed ? "PARTIAL" : "ALIGNED";
  return mixed ? "CONFLICT" : "RANGE";
}

function discretize(score: number, conviction: number, gate = DIRECTION_GATE): Direction {
  if (conviction < gate) return 0;
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

const sign = (factor: MacroFactorResult) =>
  factor.stance > 0 ? "＋" : factor.stance < 0 ? "－" : "0";

function dominantFactors(macro: MacroLayer) {
  const positive = macro.factors.filter((factor) => factor.contribution > 0);
  const negative = macro.factors.filter((factor) => factor.contribution < 0);
  return {
    up: positive.sort((a, b) => b.contribution - a.contribution)[0] ?? null,
    down: negative.sort((a, b) => a.contribution - b.contribution)[0] ?? null,
  };
}

/**
 * 매크로 전용 플레이북. 진입·손절 지시가 아니라 "무엇이 편향을 만들고 무엇이 반대하는가"를
 * 한 줄로 말해주는 것이 목적이다.
 */
function buildMacroPlaybook(
  regime: Regime,
  direction: Direction,
  macro: MacroLayer,
  events: EventLayer,
  levels: LevelInput | undefined,
  position: PositionLayer,
): string {
  if (events.activeBlackout) {
    const until = fmtKST(Date.parse(events.activeBlackout.blackoutEnd));
    return `${events.activeBlackout.label} 발표 영향권 — ${until}까지 방향 판단 보류`;
  }

  const { up, down } = dominantFactors(macro);
  const lean = directionWord(direction);
  const confirm = levelHint(direction, levels);
  const priceNote =
    position.relation === "확인"
      ? ` · 가격도 확인(${position.note})`
      : position.relation === "반증"
        ? ` · 가격은 반대(${position.note})`
        : "";

  if (regime === "CONFLICT") {
    const pair =
      up && down ? `${up.label}(＋) vs ${down.label}(－)` : "상반된 요인이 맞물림";
    return `요인 상충: ${pair} — 한쪽이 꺾이기 전까지 방향 없음${confirm ? ` · ${confirm}` : ""}`;
  }
  if (direction === 0) {
    return `뚜렷한 주도 요인 없음 — 다음 지표까지 방향 대기${confirm ? ` · ${confirm}` : ""}`;
  }

  const driver = up && direction > 0 ? up : down && direction < 0 ? down : null;
  const against = direction > 0 ? down : up;
  const head = driver ? `${lean} 편향 · ${driver.label} 주도` : `${lean} 편향`;
  const counter = against ? ` · 반대 요인 ${against.label}` : "";
  return `${head}${counter}${priceNote}${confirm ? ` · ${confirm}` : ""}`;
}

/** 관측 레벨을 "이 선을 넘으면 편향 확인 / 이탈하면 무효" 문장으로 만든다. */
function levelHint(direction: Direction, levels: LevelInput | undefined): string {
  if (!levels) return "";
  const resistance = levels.resistance?.[0];
  const support = levels.support?.[0];
  if (direction > 0 && resistance !== undefined) {
    return support !== undefined
      ? `${resistance} 상향 돌파 시 편향 확인, ${support} 이탈 시 무효`
      : `${resistance} 상향 돌파 시 편향 확인`;
  }
  if (direction < 0 && support !== undefined) {
    return resistance !== undefined
      ? `${support} 하향 이탈 시 편향 확인, ${resistance} 회복 시 무효`
      : `${support} 하향 이탈 시 편향 확인`;
  }
  if (support !== undefined && resistance !== undefined) {
    return `관측 범위 ${support} ~ ${resistance}`;
  }
  return "";
}

function buildMacroTriggers(
  macro: MacroLayer,
  events: EventLayer,
  levels: LevelInput | undefined,
  validUntil: number | null,
  position: PositionLayer,
): string[] {
  const triggers: string[] = [];
  if (position.relation === "반증") {
    triggers.push("가격이 매크로 편향과 반대 — 둘 중 하나가 꺾이는 시점");
  }
  if (levels?.support?.length) triggers.push(`지지 ${levels.support.join(" / ")} 이탈 시 재평가`);
  if (levels?.resistance?.length) {
    triggers.push(`저항 ${levels.resistance.join(" / ")} 돌파 시 재평가`);
  }
  const headline = events.headline;
  if (headline) {
    triggers.push(`${headline.label} ${fmtKST(Date.parse(headline.time))} 발표 결과`);
  }
  const top = macro.factors[0];
  if (top) triggers.push(`${top.label} 방향 전환 시 즉시 재수집`);
  if (validUntil) triggers.push(`${fmtKST(validUntil)} 스냅샷 만료`);
  return triggers;
}

function buildMacroRationale(
  regime: Regime,
  direction: Direction,
  macro: MacroLayer,
  mode: AnalysisMode,
): string {
  const top = macro.factors
    .slice(0, 3)
    .map((factor) => `${factor.label} ${sign(factor)}`)
    .join("·");
  return `${REGIME_LABEL[mode][regime]} · ${top || "근거 부족"} → ${directionWord(direction)}`;
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
  return `${REGIME_LABEL.fusion[regime]} · ${macroText} / ${techText} → ${directionWord(direction)}`;
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
  options: { mode?: AnalysisMode; levels?: LevelInput } = {},
): FusionResult {
  const mode = options.mode ?? "fusion";
  if (mode === "macro-only") {
    return fuseMacroOnly(asset, macro, technical, events, now, options.levels);
  }
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

  // 블랙아웃 중에는 확신도와 무관하게 방향을 비운다(발표 대기 상태).
  const direction = events.activeBlackout ? 0 : discretize(score, conviction);
  const validUntil = resolveValidUntil(now, events);
  const flags = [...macro.flags, ...technical.flags, ...events.flags];
  if (den <= 0) flags.push("FUSION_NO_CONFIDENCE");

  return {
    asset,
    mode: "fusion",
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

/**
 * 매크로 전용 판단. 차트 확인이 없으므로
 *  - 확신도 = 100 × min(1, |매크로점수|/1.5) × (0.5 + 0.5×매크로컨피던스) × 0.9
 *  - 상한 70 (차트 확인 없이 "높음" 상단은 주지 않는다)
 *  - 방향 게이트 25 (융합보다 낮지만, 그만큼 확신도 라벨이 낮게 붙는다)
 * 무효화 "가격"은 계산하지 않고, 리서치 관측 레벨만 확인 포인트로 제시한다.
 */
function fuseMacroOnly(
  asset: AssetId,
  macro: MacroLayer,
  technical: TechnicalLayer,
  events: EventLayer,
  now: Date,
  levels: LevelInput | undefined,
): FusionResult {
  const regime = classifyMacroRegime(macro);
  const position = computePosition(asset, levels);
  const { relation, multiplier } = positionRelation(position, macro.score);
  position.relation = relation;
  position.multiplier = multiplier;

  const scale = Math.min(1, Math.abs(macro.score) / MACRO_ONLY.fullScale);
  let conviction =
    100 * scale * (0.5 + 0.5 * macro.confidence) * MACRO_ONLY.discount * multiplier;
  conviction = Math.min(conviction, MACRO_ONLY.cap, events.convictionCap);
  if (events.activeBlackout) conviction = Math.min(conviction, 30);
  conviction = Math.round(clamp(conviction, 0, 100));

  const direction = events.activeBlackout
    ? 0
    : discretize(macro.score, conviction, MACRO_ONLY.gate);
  const validUntil = resolveValidUntil(now, events);
  const flags = ["MACRO_ONLY", ...macro.flags, ...position.flags, ...events.flags];

  return {
    asset,
    mode: "macro-only",
    ...(levels ? { levels } : {}),
    position,
    direction,
    conviction,
    confidence: confidenceLabel(conviction),
    score: round(macro.score, 3),
    regime,
    weights: { technical: 0, macro: 1 },
    playbook: buildMacroPlaybook(regime, direction, macro, events, levels, position),
    rationale: buildMacroRationale(regime, direction, macro, "macro-only"),
    reanalyzeTriggers: buildMacroTriggers(macro, events, levels, validUntil, position),
    validUntil: validUntil ? new Date(validUntil).toISOString() : null,
    macro,
    technical,
    events,
    flags,
  };
}
