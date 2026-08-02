import { describe, expect, it } from "vitest";
import { computeMacro } from "../macro";
import { BLOCK_CAP, MACRO_WEIGHTS, stanceFromValue } from "../weights";
import { ASSET_IDS } from "../types";
import { allFactors, factorInput } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString();

describe("가중치 표", () => {
  it("자산별 가중치 합이 1이다", () => {
    for (const asset of ASSET_IDS) {
      const total = Object.values(MACRO_WEIGHTS[asset]).reduce((sum, s) => sum + s.weight, 0);
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it("수치형은 밴드를, 서수형은 앵커를 갖는다", () => {
    for (const asset of ASSET_IDS) {
      for (const [key, spec] of Object.entries(MACRO_WEIGHTS[asset])) {
        if (spec.kind === "numeric") {
          expect(spec.bands, `${asset}.${key}`).toBeTruthy();
          expect(spec.metric, `${asset}.${key}`).toBeTruthy();
          expect(spec.bands!.at(-1)!.max).toBe(Infinity);
          const maxes = spec.bands!.map((b) => b.max);
          expect(maxes).toEqual([...maxes].sort((a, b) => a - b));
        } else {
          expect(Object.keys(spec.anchors ?? {}).sort()).toEqual(["-1", "-2", "0", "1", "2"]);
        }
      }
    }
  });
});

describe("1단계 — stance 파생", () => {
  it("수치를 밴드에 넣어 stance를 만든다", () => {
    const bands = MACRO_WEIGHTS.NAS100.usRates.bands!;
    expect(stanceFromValue(bands, -12)).toBe(2);
    expect(stanceFromValue(bands, -5)).toBe(1);
    expect(stanceFromValue(bands, 0)).toBe(0);
    expect(stanceFromValue(bands, 7.5)).toBe(-1);
    expect(stanceFromValue(bands, 12)).toBe(-2);
  });

  it("밴드 경계는 상한 포함이다", () => {
    const bands = MACRO_WEIGHTS.NAS100.usRates.bands!;
    expect(stanceFromValue(bands, -8)).toBe(2);
    expect(stanceFromValue(bands, -7.99)).toBe(1);
    expect(stanceFromValue(bands, 3)).toBe(0);
    expect(stanceFromValue(bands, 3.01)).toBe(-1);
  });

  it("같은 수치는 언제나 같은 stance를 준다(재현성)", () => {
    const run = () =>
      computeMacro("NAS100", [{ key: "usRates", value: 7.5, confidence: 0.9, note: "n" }], NOW);
    expect(run().factors[0].stance).toBe(run().factors[0].stance);
    expect(run().factors[0].stance).toBe(-1);
    expect(run().factors[0].value).toBe(7.5);
  });

  it("수치형에 stance만 주면 계산은 하되 신뢰도를 0.5로 제한한다", () => {
    const layer = computeMacro(
      "NAS100",
      [{ key: "usRates", stance: -2, confidence: 1, note: "구버전 입력" }],
      NOW,
    );
    expect(layer.factors[0].stance).toBe(-2);
    expect(layer.factors[0].confidence).toBe(0.5);
    expect(layer.factors[0].flags).toContain("STANCE_UNVERIFIED");
    expect(layer.flags).toContain("STANCE_UNVERIFIED:usRates");
  });

  it("수치형에 value도 stance도 없으면 버린다", () => {
    const layer = computeMacro("NAS100", [{ key: "usRates", note: "근거만" }], NOW);
    expect(layer.factors).toHaveLength(0);
    expect(layer.flags).toContain("MISSING_VALUE:usRates");
  });

  it("서수형에 stance가 없으면 버린다", () => {
    const layer = computeMacro("XAUUSD", [{ key: "safeHaven", note: "지정학" }], NOW);
    expect(layer.factors).toHaveLength(0);
    expect(layer.flags).toContain("MISSING_STANCE:safeHaven");
  });

  it("알 수 없는 키와 중복 키를 플래그로 남긴다", () => {
    const layer = computeMacro(
      "NAS100",
      [
        factorInput("NAS100", "usRates", 1),
        factorInput("NAS100", "usRates", -2),
        { key: "oilInventory", stance: 2, note: "c" },
      ],
      NOW,
    );
    expect(layer.flags).toContain("UNKNOWN_FACTOR:oilInventory");
    expect(layer.flags).toContain("DUPLICATE_FACTOR:usRates");
    expect(layer.score).toBeCloseTo(1, 6);
  });
});

describe("2단계 — 시간 감쇠", () => {
  it("반감기 18시간마다 신뢰도가 절반이 된다", () => {
    const fresh = computeMacro("NAS100", [factorInput("NAS100", "usRates", -1, 0.8)], NOW);
    const old = computeMacro(
      "NAS100",
      [{ ...factorInput("NAS100", "usRates", -1, 0.8), asof: hoursAgo(18) }],
      NOW,
    );
    expect(fresh.factors[0].effectiveConfidence).toBeCloseTo(0.8, 4);
    expect(old.factors[0].effectiveConfidence).toBeCloseTo(0.4, 4);
    expect(old.factors[0].flags).toContain("DECAYED");
    expect(old.coverage).toBeLessThan(fresh.coverage);
  });

  it("정책 스탠스는 반감기가 72시간이다", () => {
    const layer = computeMacro(
      "NAS100",
      [{ ...factorInput("NAS100", "fedPolicy", -1, 0.8), asof: hoursAgo(72) }],
      NOW,
    );
    expect(layer.factors[0].effectiveConfidence).toBeCloseTo(0.4, 4);
  });

  it("48시간을 넘긴 비지속 팩터는 제외한다", () => {
    const layer = computeMacro(
      "NAS100",
      [
        { ...factorInput("NAS100", "usRates", -1), asof: hoursAgo(49) },
        { ...factorInput("NAS100", "fedPolicy", -1), asof: hoursAgo(49) },
      ],
      NOW,
    );
    expect(layer.flags).toContain("FACTOR_STALE:usRates");
    expect(layer.factors.map((f) => f.key)).toEqual(["fedPolicy"]);
  });

  it("asof가 없으면 감쇠하지 않는다", () => {
    const layer = computeMacro("NAS100", [factorInput("NAS100", "usRates", -1, 0.8)], NOW);
    expect(layer.factors[0].effectiveConfidence).toBeCloseTo(0.8, 6);
  });
});

describe("3단계 — 블록·중복·분산", () => {
  it("같은 블록에서 같은 사실을 인용하면 2순위부터 40%로 줄인다", () => {
    const withFact = computeMacro(
      "USOIL",
      [
        { ...factorInput("USOIL", "supplyRisk", 2), fact: "hormuz" },
        { ...factorInput("USOIL", "geopolitics", 2), fact: "hormuz" },
      ],
      NOW,
    );
    const geo = withFact.factors.find((f) => f.key === "geopolitics")!;
    const supply = withFact.factors.find((f) => f.key === "supplyRisk")!;
    expect(geo.flags).toContain("DUPLICATE_FACT:hormuz");
    expect(geo.effectiveWeight).toBeCloseTo(0.1 * 0.9 * 0.4, 4);
    expect(supply.effectiveWeight).toBeCloseTo(0.24 * 0.9, 4);
  });

  it("다른 사실이면 감쇠하지 않는다", () => {
    const layer = computeMacro(
      "USOIL",
      [
        { ...factorInput("USOIL", "supplyRisk", 2), fact: "hormuz" },
        { ...factorInput("USOIL", "geopolitics", 2), fact: "venezuela" },
      ],
      NOW,
    );
    expect(layer.factors.every((f) => !f.flags.some((x) => x.startsWith("DUPLICATE_FACT")))).toBe(
      true,
    );
  });

  it("한 블록이 60%를 넘으면 그만큼 줄이고 나머지를 키운다", () => {
    const layer = computeMacro("XAUUSD", allFactors("XAUUSD", 1), NOW);
    const total = layer.factors.reduce((sum, f) => sum + f.effectiveWeight, 0);
    const rates = layer.blocks.find((b) => b.id === "rates")!;
    expect(layer.flags).toContain("BLOCK_CAPPED:rates");
    expect(rates.weight / total).toBeCloseTo(BLOCK_CAP, 3);
  });

  it("상한에 걸려도 총 가중치(커버리지)는 보존된다", () => {
    const layer = computeMacro("XAUUSD", allFactors("XAUUSD", 1, 1), NOW);
    expect(layer.coverage).toBeCloseTo(1, 3);
  });

  it("금리 블록 상한이 골드의 편향을 완화한다", () => {
    // 금리 3종 하락 압력 vs 지정학 상승 압력
    const layer = computeMacro(
      "XAUUSD",
      [
        factorInput("XAUUSD", "realYield", -2),
        factorInput("XAUUSD", "dollar", -2),
        factorInput("XAUUSD", "fedPolicy", -2),
        factorInput("XAUUSD", "safeHaven", 2),
      ],
      NOW,
    );
    const total = layer.factors.reduce((sum, f) => sum + f.effectiveWeight, 0);
    const rates = layer.blocks.find((b) => b.id === "rates")!;
    expect(rates.weight / total).toBeCloseTo(BLOCK_CAP, 3);
    // 상한이 없었다면 -1.4 부근. 상한 적용으로 -0.8까지 완화된다.
    expect(layer.score).toBeGreaterThan(-1);
    expect(layer.score).toBeLessThan(0);
  });

  it("분산은 블록 단위로 계산한다", () => {
    const sameBlockSplit = computeMacro(
      "NAS100",
      [
        factorInput("NAS100", "riskAppetite", 2),
        factorInput("NAS100", "megacapEarnings", 2),
        factorInput("NAS100", "breadth", 2),
      ],
      NOW,
    );
    expect(sameBlockSplit.dispersion).toBeCloseTo(0, 6);

    const crossBlockSplit = computeMacro(
      "NAS100",
      [factorInput("NAS100", "usRates", -2), factorInput("NAS100", "riskAppetite", 2)],
      NOW,
    );
    expect(crossBlockSplit.dispersion).toBeGreaterThan(0.5);
    expect(crossBlockSplit.flags).toContain("MACRO_HIGH_DISPERSION");
  });

  it("블록 요약에 소속 팩터와 블록 점수가 담긴다", () => {
    const layer = computeMacro("NAS100", allFactors("NAS100", 1), NOW);
    const tape = layer.blocks.find((b) => b.id === "tape")!;
    expect(tape.factors.sort()).toEqual(["breadth", "megacapEarnings", "riskAppetite"]);
    expect(tape.score).toBeCloseTo(1, 6);
  });
});

describe("레이어 종합", () => {
  it("모든 팩터가 같은 방향이면 그 값에 수렴하고 분산은 0이다", () => {
    const layer = computeMacro("XAUUSD", allFactors("XAUUSD", 2, 1), NOW);
    expect(layer.score).toBeCloseTo(2, 6);
    expect(layer.coverage).toBeCloseTo(1, 6);
    expect(layer.dispersion).toBeCloseTo(0, 6);
    expect(layer.confidence).toBeCloseTo(1, 6);
  });

  it("신뢰도가 낮으면 점수는 그대로지만 커버리지·확신도가 낮아진다", () => {
    const strong = computeMacro("USOIL", [factorInput("USOIL", "inventory", 2, 1)], NOW);
    const weak = computeMacro("USOIL", [factorInput("USOIL", "inventory", 2, 0.3)], NOW);
    expect(strong.score).toBeCloseTo(weak.score, 6);
    expect(weak.coverage).toBeLessThan(strong.coverage);
    expect(weak.flags).toContain("MACRO_COVERAGE_LOW");
  });

  it("팩터가 없으면 중립·무신뢰", () => {
    const layer = computeMacro("XAUUSD", [], NOW);
    expect(layer.score).toBe(0);
    expect(layer.confidence).toBe(0);
    expect(layer.blocks).toHaveLength(0);
    expect(layer.flags).toContain("MACRO_EMPTY");
  });
});
