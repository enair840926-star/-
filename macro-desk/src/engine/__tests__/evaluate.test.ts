import { describe, expect, it } from "vitest";
import {
  DEFAULT_COST_PCT,
  compareBenchmarks,
  dataQuality,
  evaluate,
  evaluateStrategy,
  informationCoefficient,
  payoffAsymmetry,
  pearson,
  policySweep,
  ranks,
  sampleAtHorizon,
  spearman,
  strategyDirection,
} from "../evaluate";
import type { AssetId, Direction, PredictionRecord } from "../types";
import type { HorizonSample as Sample } from "../evaluate";

const BANDS: Record<AssetId, number> = {
  NAS100: 0.35,
  XAUUSD: 0.35,
  USOIL: 0.8,
  EURUSD: 0.2,
};
const NOW = new Date("2026-09-01T00:00:00Z");
const START = Date.UTC(2026, 7, 3);

/** 8시간 간격으로 이어지는 기록을 만든다 */
function series(
  asset: AssetId,
  prices: number[],
  opts: {
    directions?: Direction[];
    convictions?: number[];
    scores?: number[];
    priorMoves?: (number | null)[];
    coverage?: number;
    stepHours?: number;
  } = {},
): PredictionRecord[] {
  const step = (opts.stepHours ?? 8) * 3_600_000;
  return prices.map((price, i) => ({
    ts: new Date(START + i * step).toISOString(),
    ruleset: "fusion-v1.1",
    asset,
    mode: "macro-only" as const,
    direction: opts.directions?.[i] ?? 1,
    conviction: opts.convictions?.[i] ?? 40,
    score: opts.scores?.[i] ?? 0.8,
    regime: "PARTIAL" as const,
    coverage: opts.coverage ?? 0.7,
    dispersion: 0.3,
    factors: [],
    positionRelation: null,
    eventTier: 0,
    blockCapped: false,
    priorMovePct: opts.priorMoves?.[i] ?? null,
    refPrice: price,
    horizonEnd: new Date(START + (i + 1) * step).toISOString(),
    outcome: null,
  }));
}

const sample = (over: Partial<Sample> = {}): Sample => ({
  asset: "USOIL",
  ts: NOW.toISOString(),
  direction: 1,
  conviction: 40,
  score: 0.8,
  priorMovePct: null,
  coverage: 0.7,
  movePct: 2,
  realized: 1,
  ...over,
});

describe("상관", () => {
  it("완전 상관과 역상관", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])!).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3, 4], [8, 6, 4, 2])!).toBeCloseTo(-1, 6);
  });

  it("분산이 0이거나 표본이 적으면 null", () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(pearson([1, 2], [1, 2])).toBeNull();
  });

  it("동순위는 평균 순위로 처리한다", () => {
    expect(ranks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
  });

  it("스피어만은 단조 관계를 잡아낸다", () => {
    // 비선형이지만 단조 증가 → 랭크 상관은 1
    expect(spearman([1, 2, 3, 4], [1, 4, 9, 16])!).toBeCloseTo(1, 6);
    expect(pearson([1, 2, 3, 4], [1, 4, 9, 16])!).toBeLessThan(1);
  });
});

describe("지평 표본 만들기", () => {
  it("8시간 뒤 기록의 가격으로 변화율을 만든다", () => {
    const records = series("USOIL", [100, 102, 101]);
    const samples = sampleAtHorizon(records, 8, BANDS);
    expect(samples).toHaveLength(2);
    expect(samples[0].movePct).toBeCloseTo(2, 4);
    expect(samples[0].realized).toBe(1);
    expect(samples[1].movePct).toBeCloseTo(-0.98, 2);
    expect(samples[1].realized).toBe(-1);
  });

  it("중립밴드 안이면 실현 방향이 0이다", () => {
    const samples = sampleAtHorizon(series("USOIL", [100, 100.5]), 8, BANDS);
    expect(samples[0].realized).toBe(0);
  });

  it("같은 기록으로 24시간 지평도 만든다", () => {
    const records = series("USOIL", [100, 101, 102, 103]);
    const h24 = sampleAtHorizon(records, 24, BANDS);
    expect(h24).toHaveLength(1);
    expect(h24[0].movePct).toBeCloseTo(3, 4);
  });

  it("허용 범위를 벗어난 간격은 짝을 짓지 않는다", () => {
    // 48시간 간격이면 8시간 지평의 짝이 없다
    const records = series("USOIL", [100, 105], { stepHours: 48 });
    expect(sampleAtHorizon(records, 8, BANDS)).toHaveLength(0);
  });

  it("자산이 섞여 있어도 자산별로만 짝짓는다", () => {
    const records = [...series("USOIL", [100, 102]), ...series("NAS100", [28000, 28100])];
    const samples = sampleAtHorizon(records, 8, BANDS);
    expect(samples).toHaveLength(2);
    expect(new Set(samples.map((s) => s.asset))).toEqual(new Set(["USOIL", "NAS100"]));
  });

  it("기준가가 없는 기록은 건너뛴다", () => {
    const records = series("USOIL", [100, 102]);
    records[0].refPrice = null;
    expect(sampleAtHorizon(records, 8, BANDS)).toHaveLength(0);
  });
});

describe("IC", () => {
  it("편향이 실현 변화율과 함께 움직이면 유의하게 잡는다", () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      sample({ score: (i % 5) - 2, movePct: ((i % 5) - 2) * 0.8 }),
    );
    const result = informationCoefficient(samples);
    expect(result.ic!).toBeGreaterThan(0.9);
    expect(result.significant).toBe(true);
    expect(result.note).toContain("양의 상관");
  });

  it("부호가 반대로 작동하면 그렇게 보고한다", () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      sample({ score: (i % 5) - 2, movePct: -((i % 5) - 2) * 0.8 }),
    );
    const result = informationCoefficient(samples);
    expect(result.ic!).toBeLessThan(0);
    expect(result.note).toContain("반대로");
  });

  it("표본이 적으면 판정하지 않는다", () => {
    expect(informationCoefficient([sample(), sample()]).note).toContain("표본 부족");
  });

  it("중립 예측도 표본에 포함된다", () => {
    const samples = Array.from({ length: 20 }, (_, i) =>
      sample({ direction: 0, score: i * 0.05, movePct: i * 0.04 }),
    );
    expect(informationCoefficient(samples).n).toBe(20);
  });
});

describe("벤치마크", () => {
  it("모멘텀은 직전 변화율의 부호를 따른다", () => {
    expect(strategyDirection("momentum", sample({ priorMovePct: 1.2 }))).toBe(1);
    expect(strategyDirection("momentum", sample({ priorMovePct: -1.2 }))).toBe(-1);
    expect(strategyDirection("momentum", sample({ priorMovePct: null }))).toBe(0);
    expect(strategyDirection("contrarian", sample({ priorMovePct: 1.2 }))).toBe(-1);
  });

  it("무작위 전략은 같은 입력에 같은 방향을 준다(재현성)", () => {
    const one = sample({ ts: "2026-08-03T00:00:00Z" });
    expect(strategyDirection("random", one)).toBe(strategyDirection("random", one));
  });

  it("비용을 진입 횟수만큼 차감한다", () => {
    const samples = [sample({ movePct: 1 }), sample({ movePct: 1 })];
    const result = evaluateStrategy(samples, "system", 0.03);
    expect(result.trades).toBe(2);
    expect(result.grossPct).toBeCloseTo(2, 4);
    expect(result.netPct).toBeCloseTo(2 - 0.06, 4);
  });

  it("중립 예측은 진입으로 세지 않는다", () => {
    const result = evaluateStrategy([sample({ direction: 0 })], "system");
    expect(result.trades).toBe(0);
    expect(result.hitRate).toBeNull();
  });

  it("다섯 전략을 모두 비교한다", () => {
    const samples = Array.from({ length: 10 }, (_, i) =>
      sample({ movePct: i % 2 ? 1 : -1, realized: i % 2 ? 1 : -1, priorMovePct: 0.5 }),
    );
    const results = compareBenchmarks(samples);
    expect(results.map((r) => r.id)).toEqual([
      "system",
      "momentum",
      "contrarian",
      "random",
      "always-long",
    ]);
    const momentum = results.find((r) => r.id === "momentum")!;
    const contrarian = results.find((r) => r.id === "contrarian")!;
    expect(momentum.grossPct).toBeCloseTo(-contrarian.grossPct, 6);
  });
});

describe("정책 시뮬레이션", () => {
  it("임계를 올리면 진입이 줄어든다", () => {
    const samples = [
      sample({ conviction: 10, movePct: -2, realized: -1 }),
      sample({ conviction: 30, movePct: 2, realized: 1 }),
      sample({ conviction: 55, movePct: 3, realized: 1 }),
    ];
    const sweep = policySweep(samples, [0, 25, 50]);
    expect(sweep.map((p) => p.trades)).toEqual([3, 2, 1]);
    expect(sweep[0].netPct).toBeCloseTo(3 - 3 * DEFAULT_COST_PCT, 4);
    expect(sweep[2].netPct).toBeCloseTo(3 - DEFAULT_COST_PCT, 4);
  });

  it("나쁜 예측을 걸러내면 수익이 개선되는 것이 보인다", () => {
    const samples = [
      ...Array.from({ length: 5 }, () => sample({ conviction: 10, movePct: -1, realized: -1 })),
      ...Array.from({ length: 5 }, () => sample({ conviction: 50, movePct: 1.5, realized: 1 })),
    ];
    const sweep = policySweep(samples, [0, 40]);
    expect(sweep[1].netPct).toBeGreaterThan(sweep[0].netPct);
    expect(sweep[1].hitRate).toBe(1);
  });

  it("진입이 없으면 null로 떨어진다", () => {
    const sweep = policySweep([sample({ conviction: 10 })], [50]);
    expect(sweep[0].trades).toBe(0);
    expect(sweep[0].avgPct).toBeNull();
  });
});

describe("손익 비대칭", () => {
  it("맞을 때 크게 움직이면 기대값이 양수로 나온다", () => {
    const samples = [
      sample({ movePct: 3, realized: 1 }),
      sample({ movePct: -0.5, realized: -1 }),
      sample({ movePct: -0.5, realized: -1 }),
    ];
    const payoff = payoffAsymmetry(samples);
    expect(payoff.hits).toBe(1);
    expect(payoff.misses).toBe(2);
    expect(payoff.avgWin).toBeCloseTo(3, 4);
    expect(payoff.avgLoss).toBeCloseTo(0.5, 4);
    expect(payoff.expectancy!).toBeGreaterThan(0);
    expect(payoff.note).toContain("양수");
  });

  it("적중률이 높아도 손실이 크면 기대값이 음수가 된다", () => {
    const samples = [
      sample({ movePct: 0.3, realized: 1 }),
      sample({ movePct: 0.3, realized: 1 }),
      sample({ movePct: -5, realized: -1 }),
    ];
    expect(payoffAsymmetry(samples).expectancy!).toBeLessThan(0);
  });

  it("중립 예측만 있으면 판정 불가", () => {
    expect(payoffAsymmetry([sample({ direction: 0 })]).note).toContain("표본 없음");
  });
});

describe("데이터 품질", () => {
  it("커버리지 구간별로 적중률을 나눈다", () => {
    const samples = [
      sample({ coverage: 0.3, movePct: -1, realized: -1 }),
      sample({ coverage: 0.8, movePct: 1, realized: 1 }),
    ];
    const quality = dataQuality(samples, []);
    expect(quality.byCoverage.find((b) => b.id.startsWith("낮음"))!.hitRate).toBe(0);
    expect(quality.byCoverage.find((b) => b.id.startsWith("높음"))!.hitRate).toBe(1);
  });

  it("실행 간격이 크게 벌어지면 누락으로 센다", () => {
    const records = series("USOIL", [100, 101], { stepHours: 30 });
    expect(dataQuality([], records).gaps).toBe(1);
    expect(dataQuality([], records).note).toContain("실행 누락");
  });

  it("정상 간격이면 누락 0", () => {
    expect(dataQuality([], series("USOIL", [100, 101, 102])).gaps).toBe(0);
  });
});

describe("종합 평가", () => {
  it("기록이 없으면 판정을 보류한다", () => {
    const result = evaluate([], BANDS, NOW);
    expect(result.verdict).toContain("표본 부족");
    expect(result.horizons.map((h) => h.hours)).toEqual([8, 24]);
  });

  it("나이브 전략에 밀리면 그렇게 보고한다", () => {
    // 가격은 계속 오르는데 시스템은 계속 하락을 외친다 → always-long이 이긴다
    const prices = Array.from({ length: 30 }, (_, i) => 100 + i);
    const records = series("USOIL", prices, {
      directions: Array.from({ length: 30 }, () => -1 as Direction),
    });
    const result = evaluate(records, BANDS, NOW);
    expect(result.horizons[0].samples).toBeGreaterThan(20);
    expect(result.verdict).toContain("밀린다");
  });

  it("편향에 정보가 있으면 그렇게 보고한다", () => {
    // score와 이후 변화율이 같은 부호로 움직이도록 만든다
    const prices: number[] = [100];
    const scores: number[] = [];
    for (let i = 0; i < 30; i += 1) {
      const up = i % 2 === 0;
      scores.push(up ? 1.5 : -1.5);
      prices.push(prices[i] * (up ? 1.02 : 0.98));
    }
    scores.push(0);
    const records = series("USOIL", prices, {
      scores,
      directions: scores.map((s) => (s > 0 ? 1 : s < 0 ? -1 : 0) as Direction),
    });
    const result = evaluate(records, BANDS, NOW);
    expect(result.horizons[0].ic.significant).toBe(true);
    expect(result.verdict).toContain("정보가 있다");
  });

  it("8시간과 24시간을 각각 평가한다", () => {
    const records = series("USOIL", [100, 101, 102, 103, 104, 105]);
    const result = evaluate(records, BANDS, NOW);
    const [h8, h24] = result.horizons;
    expect(h8.samples).toBeGreaterThan(h24.samples);
    expect(h24.samples).toBeGreaterThan(0);
  });
});
