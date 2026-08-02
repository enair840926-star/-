import { describe, expect, it } from "vitest";
import { computeMacro } from "../macro";
import { MACRO_WEIGHTS } from "../weights";
import { ASSET_IDS } from "../types";

describe("가중치 표", () => {
  it("자산별 가중치 합이 1이다", () => {
    for (const asset of ASSET_IDS) {
      const total = Object.values(MACRO_WEIGHTS[asset]).reduce(
        (sum, spec) => sum + spec.weight,
        0,
      );
      expect(total).toBeCloseTo(1, 10);
    }
  });
});

describe("computeMacro", () => {
  it("모든 팩터가 같은 방향이면 그 값에 수렴하고 분산은 0이다", () => {
    const factors = Object.keys(MACRO_WEIGHTS.XAUUSD).map((key) => ({
      key,
      stance: 2,
      confidence: 1,
      note: "테스트",
    }));
    const layer = computeMacro("XAUUSD", factors);
    expect(layer.score).toBeCloseTo(2, 6);
    expect(layer.coverage).toBeCloseTo(1, 6);
    expect(layer.dispersion).toBeCloseTo(0, 6);
    expect(layer.confidence).toBeCloseTo(1, 6);
  });

  it("정반대 팩터가 섞이면 점수는 중립에 가까워지고 컨피던스가 깎인다", () => {
    const keys = Object.keys(MACRO_WEIGHTS.NAS100);
    const factors = keys.map((key, index) => ({
      key,
      stance: index % 2 === 0 ? 2 : -2,
      confidence: 1,
      note: "테스트",
    }));
    const layer = computeMacro("NAS100", factors);
    expect(Math.abs(layer.score)).toBeLessThan(0.6);
    expect(layer.dispersion).toBeGreaterThan(0.8);
    expect(layer.confidence).toBeLessThan(0.5);
    expect(layer.flags).toContain("MACRO_HIGH_DISPERSION");
  });

  it("가중치가 큰 팩터가 결과를 지배한다", () => {
    const layer = computeMacro("EURUSD", [
      { key: "rateDiff", stance: -2, confidence: 1, note: "미 금리 우위 확대" },
      { key: "riskAppetite", stance: 2, confidence: 1, note: "위험선호 개선" },
    ]);
    expect(layer.score).toBeLessThan(0);
    expect(layer.factors[0].key).toBe("rateDiff");
  });

  it("신뢰도가 낮은 팩터는 기여도와 커버리지를 함께 낮춘다", () => {
    const strong = computeMacro("USOIL", [
      { key: "inventory", stance: 2, confidence: 1, note: "재고 급감" },
    ]);
    const weak = computeMacro("USOIL", [
      { key: "inventory", stance: 2, confidence: 0.3, note: "재고 급감(추정)" },
    ]);
    expect(strong.score).toBeCloseTo(weak.score, 6);
    expect(weak.coverage).toBeLessThan(strong.coverage);
    expect(weak.confidence).toBeLessThan(strong.confidence);
    expect(weak.flags).toContain("MACRO_COVERAGE_LOW");
  });

  it("알 수 없는 키와 중복 키를 플래그로 남기고 계산에서 제외한다", () => {
    const layer = computeMacro("NAS100", [
      { key: "usRates", stance: 1, confidence: 1, note: "a" },
      { key: "usRates", stance: -2, confidence: 1, note: "b" },
      { key: "oilInventory", stance: 2, confidence: 1, note: "c" },
    ]);
    expect(layer.flags).toContain("UNKNOWN_FACTOR:oilInventory");
    expect(layer.flags).toContain("DUPLICATE_FACTOR:usRates");
    expect(layer.score).toBeCloseTo(1, 6);
  });

  it("팩터가 없으면 중립·무신뢰", () => {
    const layer = computeMacro("XAUUSD", []);
    expect(layer.score).toBe(0);
    expect(layer.confidence).toBe(0);
    expect(layer.flags).toContain("MACRO_EMPTY");
  });

  it("stance는 -2~+2로 클램프된다", () => {
    const layer = computeMacro("XAUUSD", [
      { key: "dollar", stance: 9, confidence: 1, note: "과입력" },
    ]);
    expect(layer.score).toBe(2);
  });
});
