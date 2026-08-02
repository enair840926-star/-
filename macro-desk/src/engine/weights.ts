import params from "./params.json";
import type { AssetId, EventTier, Stance, Timeframe } from "./types";

/** 팩터가 속한 진영. 같은 블록은 "같은 이야기"로 본다. */
export type BlockId =
  | "rates"
  | "tape"
  | "geo"
  | "infl"
  | "flows"
  | "supply"
  | "policy"
  | "inv"
  | "demand"
  | "fx"
  | "ecb"
  | "usdata"
  | "ezdata";

/** 수치 → stance 변환 밴드. 위에서부터 `value <= max`인 첫 구간을 쓴다. */
export interface Band {
  max: number;
  stance: Stance;
}

export interface FactorSpec {
  label: string;
  weight: number;
  block: BlockId;
  /**
   * numeric  — 입력이 `value`(지표 실측치)이고 stance는 밴드에서 파생된다.
   * ordinal  — 입력이 `stance`이며 앵커 문구에 대응시킨다.
   */
  kind: "numeric" | "ordinal";
  /** numeric일 때 측정 대상. 반드시 "변화·서프라이즈"여야 한다(수준 금지). */
  metric?: string;
  bands?: Band[];
  /** ordinal일 때 stance별 앵커 */
  anchors?: Record<string, string>;
  /** 다음 회의·발표까지 유효한 정책 스탠스 → 감쇠 반감기를 길게 잡는다 */
  persistent?: boolean;
  /** 수집 시 부호 방향 설명 */
  hint: string;
}

/** 금리 변화(bp) → 위험자산 압력. 금리 상승 = 음수 */
const YIELD_BANDS: Band[] = [
  { max: -8, stance: 2 },
  { max: -3, stance: 1 },
  { max: 3, stance: 0 },
  { max: 8, stance: -1 },
  { max: Infinity, stance: -2 },
];

/** DXY 일간 변화(%) → 달러 강세 = 음수 */
const DXY_BANDS: Band[] = [
  { max: -0.5, stance: 2 },
  { max: -0.15, stance: 1 },
  { max: 0.15, stance: 0 },
  { max: 0.5, stance: -1 },
  { max: Infinity, stance: -2 },
];

/** VIX 일간 변화(pt) → VIX 상승 = 음수 */
const VIX_BANDS: Band[] = [
  { max: -1.5, stance: 2 },
  { max: -0.5, stance: 1 },
  { max: 0.5, stance: 0 },
  { max: 1.5, stance: -1 },
  { max: Infinity, stance: -2 },
];

const FED_ANCHORS: Record<string, string> = {
  "2": "인하 시사·완화 서프라이즈",
  "1": "비둘기 발언 우세·완화 기대 확대",
  "0": "변화 없음",
  "-1": "매파 발언·인상 소수의견",
  "-2": "인상 시사·긴축 서프라이즈",
};

const HAVEN_ANCHORS: Record<string, string> = {
  "2": "무력충돌·항로 차단 등 실제 사건 발생",
  "1": "긴장 고조 보도·위협 단계",
  "0": "변화 없음",
  "-1": "완화·휴전 진전",
  "-2": "합의 타결·구조적 해소",
};

/**
 * 자산별 매크로 팩터. 각 자산의 weight 합은 1.0이다.
 * stance는 언제나 "직전 세션 대비 변화·컨센서스 대비 서프라이즈"이며, 수준(level)이 아니다.
 */
export const MACRO_WEIGHTS: Record<AssetId, Record<string, FactorSpec>> = {
  NAS100: {
    usRates: {
      label: "미 국채금리",
      weight: 0.24,
      block: "rates",
      kind: "numeric",
      metric: "미 10년물 수익률 일간 변화(bp)",
      bands: YIELD_BANDS,
      hint: "금리 상승 = 음수. 수준이 아니라 전일 대비 변화폭을 넣는다",
    },
    fedPolicy: {
      label: "연준 스탠스",
      weight: 0.2,
      block: "rates",
      kind: "ordinal",
      anchors: FED_ANCHORS,
      persistent: true,
      hint: "완화 = 양수, 매파 = 음수",
    },
    riskAppetite: {
      label: "위험선호",
      weight: 0.18,
      block: "tape",
      kind: "numeric",
      metric: "VIX 일간 변화(pt)",
      bands: VIX_BANDS,
      hint: "VIX 하락 = 양수",
    },
    megacapEarnings: {
      label: "빅테크·실적",
      weight: 0.16,
      block: "tape",
      kind: "ordinal",
      anchors: {
        "2": "대형 실적 서프라이즈·가이던스 상향",
        "1": "우호적 개별 뉴스",
        "0": "새 재료 없음",
        "-1": "실적 부진·개별 악재",
        "-2": "대형 미스·가이던스 하향",
      },
      hint: "빅테크·반도체 재료가 우호적이면 양수",
    },
    breadth: {
      label: "시장 폭",
      weight: 0.12,
      block: "tape",
      kind: "numeric",
      metric: "상승종목 비율(%)",
      bands: [
        { max: 35, stance: -2 },
        { max: 45, stance: -1 },
        { max: 60, stance: 0 },
        { max: 70, stance: 1 },
        { max: Infinity, stance: 2 },
      ],
      hint: "상승종목 비율이 높을수록 양수",
    },
    dollar: {
      label: "달러",
      weight: 0.1,
      block: "rates",
      kind: "numeric",
      metric: "DXY 일간 변화(%)",
      bands: DXY_BANDS,
      hint: "DXY 상승 = 음수",
    },
  },

  XAUUSD: {
    realYield: {
      label: "실질금리",
      weight: 0.26,
      block: "rates",
      kind: "numeric",
      metric: "미 10년 TIPS 실질금리 일간 변화(bp) · 없으면 명목 10년 변화 대용",
      bands: [
        { max: -6, stance: 2 },
        { max: -2, stance: 1 },
        { max: 2, stance: 0 },
        { max: 6, stance: -1 },
        { max: Infinity, stance: -2 },
      ],
      hint: "실질금리 상승 = 음수. 대용치를 쓰면 confidence를 0.6 이하로 둔다",
    },
    dollar: {
      label: "달러",
      weight: 0.22,
      block: "rates",
      kind: "numeric",
      metric: "DXY 일간 변화(%)",
      bands: DXY_BANDS,
      hint: "DXY 상승 = 음수",
    },
    fedPolicy: {
      label: "연준 스탠스",
      weight: 0.18,
      block: "rates",
      kind: "ordinal",
      anchors: FED_ANCHORS,
      persistent: true,
      hint: "완화 = 양수, 매파 = 음수",
    },
    safeHaven: {
      label: "안전자산·지정학",
      weight: 0.16,
      block: "geo",
      kind: "ordinal",
      anchors: HAVEN_ANCHORS,
      hint: "긴장 고조 = 양수",
    },
    inflation: {
      label: "물가",
      weight: 0.1,
      block: "infl",
      kind: "numeric",
      metric: "10년 기대인플레(BEI) 일간 변화(bp)",
      bands: [
        { max: -5, stance: -2 },
        { max: -2, stance: -1 },
        { max: 2, stance: 0 },
        { max: 5, stance: 1 },
        { max: Infinity, stance: 2 },
      ],
      hint: "기대인플레 상승 = 양수",
    },
    flows: {
      label: "수급·포지셔닝",
      weight: 0.08,
      block: "flows",
      kind: "ordinal",
      anchors: {
        "2": "대규모 ETF 순유입·중앙은행 매입 확인",
        "1": "순유입",
        "0": "중립",
        "-1": "순유출",
        "-2": "대규모 순유출·롱 포지션 청산",
      },
      hint: "유입 = 양수",
    },
  },

  USOIL: {
    supplyRisk: {
      label: "공급 차질",
      weight: 0.24,
      block: "supply",
      kind: "ordinal",
      anchors: {
        "2": "실제 공급 중단·항로 폐쇄",
        "1": "중단 위협·부분 차질 보도",
        "0": "변화 없음",
        "-1": "차질 해소·수송 재개",
        "-2": "공급 정상화·증산 개시",
      },
      hint: "차질 = 양수",
    },
    inventory: {
      label: "재고",
      weight: 0.22,
      block: "inv",
      kind: "numeric",
      metric: "EIA 원유재고 컨센서스 대비 서프라이즈(백만 배럴)",
      bands: [
        { max: -3, stance: 2 },
        { max: -1, stance: 1 },
        { max: 1, stance: 0 },
        { max: 3, stance: -1 },
        { max: Infinity, stance: -2 },
      ],
      hint: "예상보다 큰 감소 = 양수. 절대 재고량이 아니라 서프라이즈를 넣는다",
    },
    opec: {
      label: "OPEC+",
      weight: 0.18,
      block: "policy",
      kind: "ordinal",
      anchors: {
        "2": "추가 감산 결정",
        "1": "감산 유지·연장",
        "0": "변화 없음",
        "-1": "증산 시사",
        "-2": "증산 결정·쿼터 이탈 확산",
      },
      persistent: true,
      hint: "감산 = 양수",
    },
    demand: {
      label: "수요",
      weight: 0.16,
      block: "demand",
      kind: "ordinal",
      anchors: {
        "2": "수요 지표 큰 서프라이즈",
        "1": "정제마진·주행수요 개선",
        "0": "변화 없음",
        "-1": "수요 둔화 신호",
        "-2": "수요 급감·경기 충격",
      },
      hint: "수요 개선 = 양수",
    },
    geopolitics: {
      label: "지정학",
      weight: 0.1,
      block: "supply",
      kind: "ordinal",
      anchors: HAVEN_ANCHORS,
      hint: "공급 차질과 같은 사건이면 fact를 공유해 중복을 막는다",
    },
    dollar: {
      label: "달러",
      weight: 0.1,
      block: "fx",
      kind: "numeric",
      metric: "DXY 일간 변화(%)",
      bands: DXY_BANDS,
      hint: "DXY 상승 = 음수",
    },
  },

  EURUSD: {
    rateDiff: {
      label: "미-유로존 금리차",
      weight: 0.26,
      block: "rates",
      kind: "numeric",
      metric: "(미 10년 − 독일 10년) 스프레드 일간 변화(bp)",
      bands: [
        { max: -5, stance: 2 },
        { max: -2, stance: 1 },
        { max: 2, stance: 0 },
        { max: 5, stance: -1 },
        { max: Infinity, stance: -2 },
      ],
      hint: "미국 우위 확대(스프레드 확대) = 음수",
    },
    fedPolicy: {
      label: "연준 스탠스",
      weight: 0.18,
      block: "rates",
      kind: "ordinal",
      anchors: FED_ANCHORS,
      persistent: true,
      hint: "연준 매파 = 달러 강세 = 음수",
    },
    ecbPolicy: {
      label: "ECB 스탠스",
      weight: 0.18,
      block: "ecb",
      kind: "ordinal",
      anchors: {
        "2": "인상 시사·긴축 서프라이즈",
        "1": "매파 발언 우세",
        "0": "변화 없음",
        "-1": "비둘기 발언 우세",
        "-2": "인하 시사·완화 서프라이즈",
      },
      persistent: true,
      hint: "ECB 매파 = 양수",
    },
    usData: {
      label: "미국 지표",
      weight: 0.14,
      block: "usdata",
      kind: "ordinal",
      anchors: {
        "2": "큰 미스(달러 약세 요인)",
        "1": "예상 하회",
        "0": "예상 부합·발표 없음",
        "-1": "예상 상회",
        "-2": "큰 서프라이즈(달러 강세 요인)",
      },
      hint: "미국 지표 호조 = 음수",
    },
    ezData: {
      label: "유로존 지표",
      weight: 0.14,
      block: "ezdata",
      kind: "ordinal",
      anchors: {
        "2": "큰 서프라이즈",
        "1": "예상 상회",
        "0": "예상 부합·발표 없음",
        "-1": "예상 하회",
        "-2": "큰 미스",
      },
      hint: "유로존 지표 호조 = 양수",
    },
    riskAppetite: {
      label: "위험선호",
      weight: 0.1,
      block: "tape",
      kind: "numeric",
      metric: "VIX 일간 변화(pt)",
      bands: VIX_BANDS,
      hint: "VIX 하락 = 양수(안전자산 달러 수요 감소)",
    },
  },
};

/** 한 블록이 차지할 수 있는 유효 가중치 상한 (전체 대비) */
export const BLOCK_CAP = 0.6;
/** 같은 블록에서 같은 fact를 공유할 때 2순위 이하에 곱하는 계수 */
export const DUPLICATE_FACT_WEIGHT = 0.4;

/** 팩터 신선도 반감기(시간) */
export const DECAY_HALF_LIFE_HOURS = 18;
export const DECAY_HALF_LIFE_PERSISTENT_HOURS = 72;
/** 이 시간을 넘긴 비지속 팩터는 계산에서 제외한다 */
export const FACTOR_MAX_AGE_HOURS = 48;

/**
 * 8시간 구간에서 "움직이지 않았다"로 볼 변화율(%).
 *
 * 주간 보정 루틴이 실현 변화율 분포의 p30으로 갱신하므로 코드가 아니라
 * `params.json`에 둔다. 스크립트는 그 JSON만 건드리고 엔진 코드는 손대지 않는다.
 */
export const NEUTRAL_BAND_PCT: Record<AssetId, number> = params.neutralBandPct;

/** 보정 파라미터 메타 (마지막 갱신 시각·출처) */
export const PARAMS_META = {
  version: params.version,
  updatedAt: params.updatedAt,
  source: params.source,
};

/** 타임프레임 가중치: 구조(상위 TF)를 모멘텀(하위 TF)보다 무겁게 둔다. */
export const TF_WEIGHTS: Record<Timeframe, number> = {
  D1: 0.3,
  H4: 0.3,
  H1: 0.22,
  M15: 0.18,
};

/** 각 TF 내부에서 추세/구조/모멘텀 배분 */
export const TF_COMPONENT_MIX: Record<
  Timeframe,
  { trend: number; structure: number; momentum: number }
> = {
  D1: { trend: 0.6, structure: 0.4, momentum: 0 },
  H4: { trend: 0.5, structure: 0.5, momentum: 0 },
  H1: { trend: 0.5, structure: 0.2, momentum: 0.3 },
  M15: { trend: 0.2, structure: 0, momentum: 0.8 },
};

/** 각 TF 계산에 필요한 최소 캔들 수 */
export const TF_MIN_BARS: Record<Timeframe, number> = {
  D1: 60,
  H4: 60,
  H1: 60,
  M15: 40,
};

/** 이벤트 티어별 블랙아웃(분)과 컨피던스 상한 */
export const EVENT_TIERS: Record<
  EventTier,
  { before: number; after: number; cap: number; label: string }
> = {
  3: { before: 45, after: 60, cap: 45, label: "1급" },
  2: { before: 20, after: 30, cap: 65, label: "2급" },
  1: { before: 10, after: 15, cap: 80, label: "3급" },
};

/** 융합 기본 레이어 가중치 (이벤트 티어에 따라 재조정) */
export const BASE_FUSION_WEIGHTS: Record<0 | EventTier, { technical: number; macro: number }> = {
  0: { technical: 0.6, macro: 0.4 },
  1: { technical: 0.6, macro: 0.4 },
  2: { technical: 0.55, macro: 0.45 },
  3: { technical: 0.5, macro: 0.5 },
};

/** 유효기간 상한(시간) — 예측 평가 구간과 같다 */
export const MAX_VALID_HOURS = 8;

/** 밴드에서 stance를 파생한다. */
export function stanceFromValue(bands: Band[], value: number): Stance {
  for (const band of bands) {
    if (value <= band.max) return band.stance;
  }
  return bands[bands.length - 1].stance;
}
