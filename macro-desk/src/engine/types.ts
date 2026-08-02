/**
 * Fusion Desk 엔진 타입 정의 (ruleset fusion-v1.0)
 *
 * 레이어 분리 원칙:
 *  - 기술(technical) 레이어는 차트 원시값만으로 계산되고 매크로가 이를 수정하지 않는다.
 *  - 매크로(macro) 레이어는 외부 컨텍스트만으로 계산된다.
 *  - 융합(fusion) 레이어는 두 레이어를 읽기만 하며, 각 레이어 원값을 그대로 보존해 출력한다.
 */

export const RULESET_VERSION = "fusion-v1.0";

export const ASSET_IDS = ["NAS100", "XAUUSD", "USOIL", "EURUSD"] as const;
export type AssetId = (typeof ASSET_IDS)[number];

/** 화면 표시용 이산 방향 등급 */
export type Direction = -2 | -1 | 0 | 1 | 2;

export type Timeframe = "D1" | "H4" | "H1" | "M15";
export const TIMEFRAMES: Timeframe[] = ["D1", "H4", "H1", "M15"];

/** 합의 매트릭스 상태 */
export type Regime = "ALIGNED" | "PARTIAL" | "CONFLICT" | "RANGE";

/** 변동성 국면 */
export type VolRegime = "SQUEEZE" | "NORMAL" | "EXPANSION";

export type ConfidenceLabel = "높음" | "중간" | "낮음";

// ---------------------------------------------------------------------------
// 입력
// ---------------------------------------------------------------------------

/** 압축 캔들 행: [시각ISO, 시가, 고가, 저가, 종가, (거래량)] */
export type CandleRow =
  | [string, number, number, number, number]
  | [string, number, number, number, number, number];

export interface Candle {
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v?: number;
}

export type CandleSeries = Partial<Record<Timeframe, CandleRow[] | Candle[]>>;

/** 매크로 팩터 1건. stance 부호는 "이 자산 가격에 대한 영향" 기준으로 이미 정렬되어 있어야 한다. */
export interface MacroFactorInput {
  /** 자산별 가중치 표(weights.ts)에 정의된 키 */
  key: string;
  /** -2(강한 하락 압력) ~ +2(강한 상승 압력) */
  stance: number;
  /** 0~1. 데이터 신선도·출처 신뢰도. 생략 시 0.7 */
  confidence?: number;
  /** 근거 한 줄 (숫자 포함 권장) */
  note: string;
  source?: string;
  asof?: string;
}

export type EventTier = 1 | 2 | 3;

export interface MacroEventInput {
  /** 예: "FOMC 성명" */
  label: string;
  /** ISO8601, 오프셋 포함 권장 */
  time: string;
  /** 3=1급(FOMC/CPI/NFP), 2=2급(PMI/EIA/ECB회견), 1=3급(2차 지표) */
  tier: EventTier;
  /** 영향 자산. 생략 시 전 자산 */
  assets?: AssetId[];
  note?: string;
}

export interface AssetInput {
  factors: MacroFactorInput[];
  candles: CandleSeries;
  /** 차트 번들을 아직 붙이지 않은 매크로 선행 수집 모드 */
  technicalPending?: boolean;
  /** 캔들 출처 메모 (예: v4 통합 번들 2026-08-03 08:00) */
  dataSource?: string;
}

export interface SnapshotInput {
  /** 스냅샷 기준 시각 (ISO). 생략 시 실행 시각 */
  generatedAt?: string;
  /** 갱신 케이던스 표기 */
  schedule?: string;
  events: MacroEventInput[];
  assets: Partial<Record<AssetId, AssetInput>>;
  /** 수집 노트 (선택) */
  note?: string;
}

// ---------------------------------------------------------------------------
// 매크로 레이어 출력
// ---------------------------------------------------------------------------

export interface MacroFactorResult extends MacroFactorInput {
  label: string;
  weight: number;
  confidence: number;
  /** weight * confidence * stance — 최종 점수 기여분 */
  contribution: number;
}

export interface MacroLayer {
  /** -2 ~ +2 */
  score: number;
  /** 0~1 */
  confidence: number;
  /** 가중치 표 대비 실제 채워진 비율 0~1 */
  coverage: number;
  /** 팩터 간 의견 분산 0~1 (1에 가까울수록 상충) */
  dispersion: number;
  factors: MacroFactorResult[];
  flags: string[];
}

// ---------------------------------------------------------------------------
// 기술 레이어 출력
// ---------------------------------------------------------------------------

export interface TimeframeRead {
  tf: Timeframe;
  /** -2 ~ +2 */
  score: number;
  weight: number;
  trend: number | null;
  structure: number | null;
  momentum: number | null;
  /** 사람이 읽는 한 줄 요약 */
  note: string;
  bars: number;
}

export interface TechnicalLayer {
  /** -2 ~ +2 */
  score: number;
  /** 0~1 */
  confidence: number;
  /** 타임프레임 부호 일치도 0~1 */
  alignment: number;
  volRegime: VolRegime;
  /** ATR(14) H1 기준 절대값 */
  atrH1: number | null;
  /** 당일 레인지 / ADR20 */
  rangeUsage: number | null;
  /** 직전 일봉 고·저 */
  prevDayHigh: number | null;
  prevDayLow: number | null;
  lastPrice: number | null;
  /** 롱/숏 각각의 구조적 무효화 가격 */
  invalidation: { long: number | null; short: number | null };
  timeframes: TimeframeRead[];
  flags: string[];
}

// ---------------------------------------------------------------------------
// 이벤트 레이어 출력
// ---------------------------------------------------------------------------

export interface EventWindow {
  label: string;
  time: string;
  tier: EventTier;
  note?: string;
  /** 신규 진입 보류 구간 */
  blackoutStart: string;
  blackoutEnd: string;
  /** 스냅샷 시각 기준 잔여 분 (음수면 이미 지남) */
  minutesUntil: number;
  active: boolean;
}

export interface EventLayer {
  /** 이 자산에 영향 있는 이벤트만 (표기용 36시간 창) */
  windows: EventWindow[];
  /** 화면 상단에 띄울 가장 가까운 이벤트 */
  headline: EventWindow | null;
  /** 유효구간 내 최고 티어 (없으면 0) */
  maxTier: 0 | EventTier;
  /** 현재 블랙아웃 중인 이벤트 */
  activeBlackout: EventWindow | null;
  /** 다음 블랙아웃 시작 시각 */
  nextBlackoutStart: string | null;
  /** 컨피던스 상한 0~100 */
  convictionCap: number;
  flags: string[];
}

// ---------------------------------------------------------------------------
// 융합 출력
// ---------------------------------------------------------------------------

export interface FusionResult {
  asset: AssetId;
  /** 최종 이산 방향 */
  direction: Direction;
  /** 0~100 */
  conviction: number;
  confidence: ConfidenceLabel;
  /** -2 ~ +2 연속값 */
  score: number;
  regime: Regime;
  /** 융합에 실제 적용된 레이어 가중치 */
  weights: { technical: number; macro: number };
  playbook: string;
  rationale: string;
  /** 재분석 트리거 문장들 */
  reanalyzeTriggers: string[];
  validUntil: string | null;
  macro: MacroLayer;
  technical: TechnicalLayer;
  events: EventLayer;
  flags: string[];
}

export interface SnapshotDriver {
  name: string;
  read: "상승" | "하락" | "중립";
  note: string;
}

/** public/macro.json v2 — v1 필드를 그대로 유지해 구형 화면과 호환된다. */
export interface SnapshotAsset {
  direction: Direction | null;
  confidence: ConfidenceLabel | null;
  rationale: string;
  drivers: SnapshotDriver[];
  event: string;
  asof: string | null;
  setAt: string | null;
  source: "scheduled" | "manual" | null;
  fusion?: FusionResult;
}

export interface Snapshot {
  version: number;
  ruleset: string;
  generatedAt: string;
  schedule: string;
  note?: string;
  assets: Partial<Record<AssetId, SnapshotAsset>>;
}
