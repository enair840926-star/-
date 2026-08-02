import type { AssetId, EventTier, Timeframe } from "./types";

export interface FactorSpec {
  label: string;
  weight: number;
  /** 수집 시 stance 부호를 어떻게 잡아야 하는지에 대한 지시 */
  hint: string;
}

/**
 * 자산별 매크로 팩터 가중치. 각 자산의 weight 합은 1.0이다.
 * stance는 항상 "이 자산 가격에 대한 압력"으로 부호를 맞춰서 넣는다.
 * (예: XAUUSD의 dollar 팩터에서 달러 강세는 stance 음수)
 */
export const MACRO_WEIGHTS: Record<AssetId, Record<string, FactorSpec>> = {
  NAS100: {
    usRates: {
      label: "미 국채금리",
      weight: 0.24,
      hint: "금리 상승 = 음수, 하락 = 양수 (10Y·2Y 수익률 변화)",
    },
    fedPolicy: {
      label: "연준 스탠스",
      weight: 0.2,
      hint: "완화 기대 확대 = 양수, 매파 = 음수 (금리선물·연설·점도표)",
    },
    riskAppetite: {
      label: "위험선호",
      weight: 0.18,
      hint: "VIX 하락·크레딧 스프레드 축소 = 양수",
    },
    megacapEarnings: {
      label: "빅테크·실적",
      weight: 0.16,
      hint: "빅테크 실적·가이던스·반도체 흐름이 우호적이면 양수",
    },
    breadth: {
      label: "시장 폭",
      weight: 0.12,
      hint: "상승종목 우위·등폭지수 개선 = 양수",
    },
    dollar: {
      label: "달러",
      weight: 0.1,
      hint: "DXY 강세 = 음수 (해외매출 비중·유동성 경로)",
    },
  },
  XAUUSD: {
    realYield: {
      label: "실질금리",
      weight: 0.26,
      hint: "실질금리(TIPS) 상승 = 음수, 하락 = 양수",
    },
    dollar: {
      label: "달러",
      weight: 0.22,
      hint: "DXY 강세 = 음수",
    },
    fedPolicy: {
      label: "연준 스탠스",
      weight: 0.18,
      hint: "완화 기대 = 양수, 매파 = 음수",
    },
    safeHaven: {
      label: "안전자산·지정학",
      weight: 0.16,
      hint: "지정학 긴장·주식 급락 = 양수",
    },
    inflation: {
      label: "물가",
      weight: 0.1,
      hint: "인플레 기대 상승 = 양수 (단, 매파 반응이 크면 상쇄 반영)",
    },
    flows: {
      label: "수급·포지셔닝",
      weight: 0.08,
      hint: "ETF 순유입·중앙은행 매입 = 양수, 과열 롱포지션 = 음수",
    },
  },
  USOIL: {
    supplyRisk: {
      label: "공급 차질",
      weight: 0.24,
      hint: "생산 차질·제재·항로 위험 = 양수",
    },
    inventory: {
      label: "재고",
      weight: 0.22,
      hint: "EIA/API 재고 감소 = 양수, 증가 = 음수",
    },
    opec: {
      label: "OPEC+",
      weight: 0.18,
      hint: "감산 유지·추가 감산 = 양수, 증산 = 음수",
    },
    demand: {
      label: "수요",
      weight: 0.16,
      hint: "정제마진·중국 지표·주행수요 개선 = 양수",
    },
    geopolitics: {
      label: "지정학",
      weight: 0.1,
      hint: "긴장 고조 = 양수, 휴전·협상 진전 = 음수",
    },
    dollar: {
      label: "달러",
      weight: 0.1,
      hint: "DXY 강세 = 음수",
    },
  },
  EURUSD: {
    rateDiff: {
      label: "미-유로존 금리차",
      weight: 0.26,
      hint: "미국 금리 우위 확대 = 음수, 축소 = 양수",
    },
    fedPolicy: {
      label: "연준 스탠스",
      weight: 0.18,
      hint: "연준 완화 = 양수(달러 약세), 매파 = 음수",
    },
    ecbPolicy: {
      label: "ECB 스탠스",
      weight: 0.18,
      hint: "ECB 매파 = 양수, 완화 = 음수",
    },
    usData: {
      label: "미국 지표",
      weight: 0.14,
      hint: "미국 지표 서프라이즈 = 음수(달러 강세)",
    },
    ezData: {
      label: "유로존 지표",
      weight: 0.14,
      hint: "유로존 지표 서프라이즈 = 양수",
    },
    riskAppetite: {
      label: "위험선호",
      weight: 0.1,
      hint: "위험선호 개선 = 양수(달러 안전자산 수요 감소)",
    },
  },
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

/** 유효기간 상한(시간) */
export const MAX_VALID_HOURS = 6;
