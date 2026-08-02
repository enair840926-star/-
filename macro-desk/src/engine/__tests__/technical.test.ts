import { describe, expect, it } from "vitest";
import { computeTechnical, momentumScore, structureScore, trendScore } from "../technical";
import { normalizeCandles } from "../indicators";
import { fullSeries, makeSeries, ranging, trendingDown, trendingUp } from "./fixtures";

describe("서브 점수", () => {
  it("상승 추세는 양수, 하락 추세는 음수", () => {
    expect(trendScore(normalizeCandles(trendingUp()))!.score).toBeGreaterThan(1);
    expect(trendScore(normalizeCandles(trendingDown()))!.score).toBeLessThan(-1);
  });

  it("HH/HL 구조를 상승으로 읽는다", () => {
    const up = structureScore(normalizeCandles(trendingUp()))!;
    const down = structureScore(normalizeCandles(trendingDown()))!;
    expect(up.score).toBeGreaterThan(0);
    expect(up.note).toContain("HH/HL");
    expect(down.score).toBeLessThan(0);
    expect(down.note).toContain("LH/LL");
  });

  it("모멘텀은 RSI와 ROC 부호를 따른다", () => {
    expect(momentumScore(normalizeCandles(trendingUp()))!.score).toBeGreaterThan(0);
    expect(momentumScore(normalizeCandles(trendingDown()))!.score).toBeLessThan(0);
  });

  it("워밍업이 부족하면 null", () => {
    expect(trendScore(normalizeCandles(makeSeries({ bars: 10 })))).toBeNull();
    expect(momentumScore(normalizeCandles(makeSeries({ bars: 5 })))).toBeNull();
  });
});

describe("computeTechnical", () => {
  it("전 TF 상승이면 강한 양수 점수와 높은 정렬도", () => {
    const layer = computeTechnical(fullSeries("up"));
    expect(layer.score).toBeGreaterThan(1);
    expect(layer.alignment).toBeGreaterThan(0.9);
    expect(layer.confidence).toBeGreaterThan(0.6);
    expect(layer.timeframes).toHaveLength(4);
  });

  it("전 TF 하락이면 강한 음수 점수", () => {
    const layer = computeTechnical(fullSeries("down"));
    expect(layer.score).toBeLessThan(-1);
    expect(layer.alignment).toBeGreaterThan(0.9);
  });

  it("TF가 엇갈리면 정렬도가 떨어진다", () => {
    const mixed = computeTechnical({
      D1: trendingUp(),
      H4: trendingUp(),
      H1: trendingDown(),
      M15: trendingDown(),
    });
    expect(mixed.alignment).toBeLessThan(0.6);
    expect(mixed.confidence).toBeLessThan(computeTechnical(fullSeries("up")).confidence);
  });

  it("레인지에서는 점수 절대값이 작다", () => {
    const layer = computeTechnical({ D1: ranging(), H4: ranging(), H1: ranging(), M15: ranging() });
    expect(Math.abs(layer.score)).toBeLessThan(1);
  });

  it("누락·워밍업 부족 TF를 플래그로 남기고 남은 TF로 계산한다", () => {
    const layer = computeTechnical({ D1: trendingUp(), H1: makeSeries({ bars: 20, drift: 1 }) });
    expect(layer.flags).toContain("TF_H4_MISSING");
    expect(layer.flags).toContain("TF_M15_MISSING");
    expect(layer.flags).toContain("TF_H1_WARMUP");
    expect(layer.flags).toContain("TF_COVERAGE_LOW");
    expect(layer.timeframes.map((read) => read.tf)).toEqual(["D1"]);
  });

  it("입력이 전혀 없으면 중립·플래그", () => {
    const layer = computeTechnical({});
    expect(layer.score).toBe(0);
    expect(layer.timeframes).toHaveLength(0);
    expect(layer.flags).toContain("TF_D1_MISSING");
  });

  it("무효화 레벨은 롱이 현재가 아래, 숏이 위에 놓인다", () => {
    const layer = computeTechnical(fullSeries("up"));
    expect(layer.lastPrice).not.toBeNull();
    expect(layer.invalidation.long!).toBeLessThan(layer.lastPrice!);
    expect(layer.invalidation.short!).toBeLessThan(layer.lastPrice! + layer.atrH1! * 4);
  });

  it("당일 레인지가 평균을 크게 넘으면 소진 플래그", () => {
    const daily = trendingUp(120);
    const wide = daily[daily.length - 1];
    daily[daily.length - 1] = [wide[0], wide[1], wide[1] + 30, wide[1] - 30, wide[4]];
    const layer = computeTechnical({ D1: daily, H4: trendingUp(), H1: trendingUp(), M15: trendingUp() });
    expect(layer.rangeUsage!).toBeGreaterThan(1.2);
    expect(layer.flags).toContain("RANGE_EXHAUSTED");
  });
});
