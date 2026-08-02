import { describe, expect, it } from "vitest";
import {
  BAND_MAX_CHANGE,
  BAND_MIN_SAMPLES,
  FACTOR_MIN_SAMPLES,
  GATE_MIN_SAMPLES,
  analyzeBlockCap,
  analyzeConviction,
  analyzeFactors,
  analyzeGate,
  analyzePosition,
  buildCalibrationReport,
  calibrateBands,
  percentile,
  renderCalibrationMarkdown,
  wilsonLowerBound,
} from "../calibrate";
import type { AssetId, Direction, PredictionRecord } from "../types";

const NOW = new Date("2026-08-09T01:00:00Z");
const CURRENT = { NAS100: 0.35, XAUUSD: 0.35, USOIL: 0.8, EURUSD: 0.2 };

let seq = 0;
function scored(
  asset: AssetId,
  opts: {
    direction?: Direction;
    conviction?: number;
    movePct: number;
    realized: Direction;
    hit?: boolean | null;
    positionRelation?: PredictionRecord["positionRelation"];
    blockCapped?: boolean;
    priorMovePct?: number | null;
    factors?: PredictionRecord["factors"];
    ruleset?: string;
  },
): PredictionRecord {
  const direction = opts.direction ?? 1;
  seq += 1;
  return {
    ts: new Date(NOW.getTime() - seq * 3_600_000).toISOString(),
    ruleset: opts.ruleset ?? "fusion-v1.1",
    asset,
    mode: "macro-only",
    direction,
    conviction: opts.conviction ?? 40,
    score: 0.8,
    regime: "PARTIAL",
    coverage: 0.7,
    dispersion: 0.3,
    factors: opts.factors ?? [],
    positionRelation: opts.positionRelation ?? null,
    eventTier: 0,
    blockCapped: opts.blockCapped ?? false,
    priorMovePct: opts.priorMovePct ?? null,
    refPrice: 100,
    horizonEnd: NOW.toISOString(),
    outcome: {
      scoredAt: NOW.toISOString(),
      endPrice: 100,
      movePct: opts.movePct,
      realized: opts.realized,
      hit:
        opts.hit !== undefined
          ? opts.hit
          : direction === 0
            ? null
            : Math.sign(direction) === opts.realized,
    },
  };
}

describe("percentile", () => {
  it("선형 보간으로 분위수를 낸다", () => {
    const values = [1, 2, 3, 4, 5];
    expect(percentile(values, 0)).toBe(1);
    expect(percentile(values, 100)).toBe(5);
    expect(percentile(values, 50)).toBe(3);
    expect(percentile(values, 25)).toBe(2);
    expect(percentile([10, 20], 30)).toBeCloseTo(13, 6);
  });

  it("정렬되지 않은 입력도 처리하고 빈 입력은 null", () => {
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([], 30)).toBeNull();
    expect(percentile([7], 30)).toBe(7);
  });
});

describe("wilsonLowerBound", () => {
  it("표본이 작으면 하한이 크게 내려간다", () => {
    const small = wilsonLowerBound(6, 10)!;
    const large = wilsonLowerBound(600, 1000)!;
    expect(small).toBeLessThan(0.6);
    expect(large).toBeGreaterThan(small);
    expect(large).toBeLessThan(0.6);
  });

  it("경계값", () => {
    expect(wilsonLowerBound(0, 10)).toBe(0);
    expect(wilsonLowerBound(10, 10)!).toBeGreaterThan(0.6);
    expect(wilsonLowerBound(1, 0)).toBeNull();
  });
});

describe("A등급 — 중립밴드", () => {
  const moves = (asset: AssetId, list: number[]) =>
    list.map((movePct) => scored(asset, { movePct, realized: movePct > 0 ? 1 : -1 }));

  it("표본이 모자라면 건드리지 않는다", () => {
    const records = moves("USOIL", Array.from({ length: BAND_MIN_SAMPLES - 1 }, () => 1));
    const band = calibrateBands(records, CURRENT).find((b) => b.asset === "USOIL")!;
    expect(band.applied).toBe(false);
    expect(band.proposed).toBeNull();
    expect(band.note).toContain("표본 부족");
  });

  it("표본이 차면 p30으로 갱신한다", () => {
    // 0.5 ~ 1.5% 균등, p30 ≈ 0.8 부근이지만 현재값 0.8에서 ±30% 한도 안
    const list = Array.from({ length: 30 }, (_, i) => 0.5 + i * 0.02);
    const band = calibrateBands(moves("USOIL", list), CURRENT).find((b) => b.asset === "USOIL")!;
    expect(band.n).toBe(30);
    expect(band.raw).toBeCloseTo(percentile(list, 30)!, 3);
    expect(band.proposed).not.toBeNull();
  });

  it("1회 변화 한도를 넘으면 클램프하고 원값을 남긴다", () => {
    // 전부 아주 작은 변동 → p30이 현재값(0.8)보다 훨씬 낮다
    const list = Array.from({ length: 25 }, () => 0.05);
    const band = calibrateBands(moves("USOIL", list), CURRENT).find((b) => b.asset === "USOIL")!;
    expect(band.proposed).toBeCloseTo(0.8 * (1 - BAND_MAX_CHANGE), 2);
    expect(band.note).toContain("변화 한도");
    expect(band.raw).toBeCloseTo(0.05, 3);
  });

  it("자산별로 따로 계산하고 다른 자산은 표본 부족으로 남는다", () => {
    const bands = calibrateBands(
      moves("USOIL", Array.from({ length: 25 }, () => 0.9)),
      CURRENT,
    );
    expect(bands.find((b) => b.asset === "USOIL")!.n).toBe(25);
    expect(bands.find((b) => b.asset === "NAS100")!.n).toBe(0);
    expect(bands).toHaveLength(4);
  });

  it("채점 안 된 기록은 세지 않는다", () => {
    const open = { ...scored("USOIL", { movePct: 1, realized: 1 }), outcome: null };
    const skipped = scored("USOIL", { movePct: 1, realized: 1 });
    skipped.outcome!.skipped = "stale";
    const bands = calibrateBands([open, skipped], CURRENT);
    expect(bands.find((b) => b.asset === "USOIL")!.n).toBe(0);
  });
});

describe("B등급 — 확신도 단조성", () => {
  const bucket = (conviction: number, hits: number, misses: number) => [
    ...Array.from({ length: hits }, () =>
      scored("USOIL", { conviction, movePct: 2, realized: 1, direction: 1 }),
    ),
    ...Array.from({ length: misses }, () =>
      scored("USOIL", { conviction, movePct: -2, realized: -1, direction: 1 }),
    ),
  ];

  it("표본이 모자라면 판정하지 않는다", () => {
    const result = analyzeConviction(bucket(30, 3, 2));
    expect(result.monotonic).toBeNull();
    expect(result.note).toContain("판정 불가");
  });

  it("확신도가 높을수록 잘 맞으면 정상", () => {
    const result = analyzeConviction([...bucket(30, 5, 7), ...bucket(60, 9, 3)]);
    expect(result.monotonic).toBe(true);
    expect(result.note).toContain("정상");
  });

  it("역전되면 경고한다", () => {
    const result = analyzeConviction([...bucket(30, 9, 3), ...bucket(60, 4, 8)]);
    expect(result.monotonic).toBe(false);
    expect(result.note).toContain("역전");
  });
});

describe("B등급 — 방향 게이트", () => {
  const neutral = (moved: boolean) =>
    scored("USOIL", {
      direction: 0,
      movePct: moved ? 2 : 0.1,
      realized: moved ? 1 : 0,
      hit: null,
    });

  it("표본이 모자라면 제안하지 않는다", () => {
    const result = analyzeGate(Array.from({ length: 5 }, () => neutral(true)));
    expect(result.suggestion).toContain("표본 부족");
  });

  it("중립인데 대부분 움직였으면 하향을 제안한다", () => {
    const records = [
      ...Array.from({ length: 18 }, () => neutral(true)),
      ...Array.from({ length: 6 }, () => neutral(false)),
    ];
    const result = analyzeGate(records);
    expect(result.neutralN).toBe(24);
    expect(result.neutralMoved).toBe(18);
    expect(result.suggestion).toContain("하향");
  });

  it("중립 판정이 대체로 맞았으면 상향을 제안한다", () => {
    const records = [
      ...Array.from({ length: 4 }, () => neutral(true)),
      ...Array.from({ length: 20 }, () => neutral(false)),
    ];
    expect(analyzeGate(records).suggestion).toContain("상향");
  });

  it("가운데 구간이면 유지", () => {
    const records = [
      ...Array.from({ length: 12 }, () => neutral(true)),
      ...Array.from({ length: 12 }, () => neutral(false)),
    ];
    expect(analyzeGate(records).suggestion).toBe("유지");
  });
});

describe("B등급 — 위치 배수", () => {
  const withRelation = (relation: "확인" | "반증", hit: boolean, count: number) =>
    Array.from({ length: count }, () =>
      scored("USOIL", {
        direction: 1,
        movePct: hit ? 2 : -2,
        realized: hit ? 1 : -1,
        positionRelation: relation,
      }),
    );

  it("확인이 반증보다 잘 맞으면 정상", () => {
    const result = analyzePosition([
      ...withRelation("확인", true, 9),
      ...withRelation("확인", false, 3),
      ...withRelation("반증", true, 4),
      ...withRelation("반증", false, 8),
    ]);
    expect(result.note).toContain("정상");
  });

  it("역전되면 배수를 되돌리라고 제안한다", () => {
    const result = analyzePosition([
      ...withRelation("확인", true, 3),
      ...withRelation("확인", false, 9),
      ...withRelation("반증", true, 9),
      ...withRelation("반증", false, 3),
    ]);
    expect(result.note).toContain("역전");
  });

  it("표본이 모자라면 판정 불가", () => {
    expect(analyzePosition(withRelation("확인", true, 3)).note).toContain("판정 불가");
  });
});

describe("C등급 — 팩터 적중률", () => {
  const withFactor = (stance: -2 | 2, realized: Direction, count: number) =>
    Array.from({ length: count }, () =>
      scored("USOIL", {
        movePct: realized * 2,
        realized,
        direction: 1,
        factors: [{ key: "supplyRisk", stance, weight: 0.2 }],
      }),
    );

  it("표본이 모자라면 판정을 보류한다", () => {
    const stats = analyzeFactors(withFactor(2, 1, 10));
    expect(stats[0].n).toBe(10);
    expect(stats[0].verdict).toBe("표본 부족");
  });

  it("유의하게 틀린 팩터는 하향 검토로 표시한다", () => {
    const stats = analyzeFactors([
      ...withFactor(2, -1, 40), // 상승 압력이라 했는데 계속 하락
      ...withFactor(2, 1, 5),
    ]);
    const supply = stats.find((s) => s.key === "supplyRisk")!;
    expect(supply.n).toBe(45);
    expect(supply.rate!).toBeLessThan(0.2);
    expect(supply.verdict).toBe("하향 검토");
  });

  it("유의하게 맞는 팩터는 상향 검토로 표시한다", () => {
    const stats = analyzeFactors(withFactor(2, 1, FACTOR_MIN_SAMPLES + 10));
    expect(stats[0].verdict).toBe("상향 검토");
    expect(stats[0].wilson!).toBeGreaterThan(0.5);
  });

  it("실현 방향이 없던 세션과 중립 stance는 제외한다", () => {
    const stats = analyzeFactors([
      ...withFactor(2, 0, 10),
      ...Array.from({ length: 5 }, () =>
        scored("USOIL", {
          movePct: 2,
          realized: 1,
          factors: [{ key: "dollar", stance: 0, weight: 0.1 }],
        }),
      ),
    ]);
    expect(stats).toHaveLength(0);
  });

  it("자산별로 분리해 센다", () => {
    const stats = analyzeFactors([
      ...withFactor(2, 1, 3),
      scored("NAS100", {
        movePct: 2,
        realized: 1,
        factors: [{ key: "usRates", stance: 1, weight: 0.2 }],
      }),
    ]);
    expect(stats.map((s) => s.id).sort()).toEqual(["NAS100:usRates", "USOIL:supplyRisk"]);
  });
});

describe("C등급 — 블록 상한", () => {
  const rows = (capped: boolean, hit: boolean, count: number) =>
    Array.from({ length: count }, () =>
      scored("XAUUSD", {
        direction: 1,
        movePct: hit ? 2 : -2,
        realized: hit ? 1 : -1,
        blockCapped: capped,
      }),
    );

  it("양쪽 표본이 차면 비교한다", () => {
    const result = analyzeBlockCap([
      ...rows(true, true, 9),
      ...rows(true, false, 3),
      ...rows(false, true, 4),
      ...rows(false, false, 8),
    ]);
    expect(result.capped.n).toBe(12);
    expect(result.note).toContain("더 잘 맞았다");
  });

  it("표본이 모자라면 판정 불가", () => {
    expect(analyzeBlockCap(rows(true, true, 5)).note).toContain("판정 불가");
  });
});

describe("전체 리포트", () => {
  it("빈 기록이어도 안전하게 떨어진다", () => {
    const report = buildCalibrationReport([], CURRENT, NOW, "fusion-v1.1");
    expect(report.totals.records).toBe(0);
    expect(report.bands.every((band) => !band.applied)).toBe(true);
    expect(report.warnings).toContain("기록이 비어 있다");
  });

  it("B·C 등급은 같은 ruleset 기록만 쓰고 중립밴드는 전체를 쓴다", () => {
    const old = Array.from({ length: 25 }, () =>
      scored("USOIL", { movePct: 1.2, realized: 1, ruleset: "fusion-v1.0" }),
    );
    const current = Array.from({ length: 3 }, () =>
      scored("USOIL", { movePct: 1.2, realized: 1, ruleset: "fusion-v1.1" }),
    );
    const report = buildCalibrationReport([...old, ...current], CURRENT, NOW, "fusion-v1.1");

    // 중립밴드는 28건 전부 사용
    expect(report.bands.find((b) => b.asset === "USOIL")!.n).toBe(28);
    // B·C는 v1.1 3건만
    expect(report.totals.scored).toBe(3);
    expect(report.warnings.some((w) => w.includes("모집단이 다르다"))).toBe(true);
  });

  it("게이트 표본 기준이 리포트에 그대로 반영된다", () => {
    const neutrals = Array.from({ length: GATE_MIN_SAMPLES }, () =>
      scored("USOIL", { direction: 0, movePct: 3, realized: 1, hit: null }),
    );
    const report = buildCalibrationReport(neutrals, CURRENT, NOW, "fusion-v1.1");
    expect(report.gate.neutralN).toBe(GATE_MIN_SAMPLES);
    expect(report.gate.suggestion).toContain("하향");
  });
});

describe("리포트 렌더링", () => {
  it("빈 기록이어도 모든 섹션이 나온다", () => {
    const md = renderCalibrationMarkdown(
      buildCalibrationReport([], CURRENT, NOW, "fusion-v1.1"),
    );
    expect(md).toContain("# 보정 리포트 2026-08-09");
    expect(md).toContain("## A. 중립밴드");
    expect(md).toContain("## B. 확신도");
    expect(md).toContain("## C. 팩터 가중치");
    expect(md).toContain("기록이 비어 있다");
    // 자산 4개가 표본 부족으로 표시된다
    expect(md.match(/표본 부족/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("적용된 밴드는 굵게 표시하고 이전값을 함께 남긴다", () => {
    const records = Array.from({ length: 25 }, () =>
      scored("USOIL", { movePct: 0.05, realized: 0 }),
    );
    const report = buildCalibrationReport(records, CURRENT, NOW, "fusion-v1.1");
    const md = renderCalibrationMarkdown(report);
    expect(md).toContain("**0.56%**");
    expect(md).toContain("0.8%");
    expect(md).toContain("변화 한도");
  });
});
