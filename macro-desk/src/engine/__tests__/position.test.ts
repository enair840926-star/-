import { describe, expect, it } from "vitest";
import { computePosition, positionRelation } from "../position";
import { computeEvents } from "../events";
import { fuse } from "../fusion";
import { computeMacro } from "../macro";
import { computeTechnical } from "../technical";
import { NEUTRAL_BAND_PCT } from "../weights";
import type { AssetId, LevelInput, MacroFactorInput } from "../types";
import { allFactors } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");

function run(asset: AssetId, factors: MacroFactorInput[], levels?: LevelInput) {
  return fuse(
    asset,
    computeMacro(asset, factors, NOW),
    computeTechnical({}),
    computeEvents(asset, [], NOW),
    NOW,
    { mode: "macro-only", levels },
  );
}

describe("computePosition", () => {
  it("전일 종가 대비 변화를 자산별 중립밴드로 정규화한다", () => {
    const band = NEUTRAL_BAND_PCT.USOIL; // 0.8%
    const flat = computePosition("USOIL", { last: 100, prevClose: 100 });
    const oneBand = computePosition("USOIL", { last: 100 * (1 + band / 100), prevClose: 100 });
    expect(flat.score).toBe(0);
    expect(flat.movePct).toBe(0);
    expect(oneBand.movePct).toBeCloseTo(band, 6);
    expect(oneBand.score).toBeCloseTo(Math.tanh(1), 3);
  });

  it("자산마다 같은 변화율이 다른 강도로 읽힌다", () => {
    const oil = computePosition("USOIL", { last: 100.4, prevClose: 100 });
    const eur = computePosition("EURUSD", { last: 100.4, prevClose: 100 });
    expect(Math.abs(eur.score)).toBeGreaterThan(Math.abs(oil.score));
  });

  it("저항 돌파와 지지 이탈에 가산치를 준다", () => {
    const plain = computePosition("XAUUSD", { last: 4110, prevClose: 4100 });
    const broke = computePosition("XAUUSD", {
      last: 4110,
      prevClose: 4100,
      resistance: [4100],
    });
    expect(broke.score).toBeCloseTo(plain.score + 0.3, 3);
    expect(broke.brokeResistance).toBe(true);
    expect(broke.note).toContain("상향 돌파");

    const lost = computePosition("XAUUSD", { last: 3990, prevClose: 4000, support: [4000] });
    expect(lost.lostSupport).toBe(true);
    expect(lost.score).toBeLessThan(0);
    expect(lost.note).toContain("이탈");
  });

  it("점수는 -1 ~ +1로 제한된다", () => {
    const extreme = computePosition("EURUSD", {
      last: 120,
      prevClose: 100,
      resistance: [110],
    });
    expect(extreme.score).toBe(1);
  });

  it("prevClose가 없으면 미수집으로 떨어진다", () => {
    const layer = computePosition("USOIL", { last: 84 });
    expect(layer.flags).toContain("POSITION_UNAVAILABLE");
    expect(layer.score).toBe(0);
    expect(layer.movePct).toBeNull();
  });
});

describe("positionRelation", () => {
  const up = computePosition("USOIL", { last: 102, prevClose: 100 });
  const down = computePosition("USOIL", { last: 98, prevClose: 100 });
  const flat = computePosition("USOIL", { last: 100.05, prevClose: 100 });

  it("같은 방향이면 확인", () => {
    expect(positionRelation(up, 1.2)).toEqual({ relation: "확인", multiplier: 1.15 });
    expect(positionRelation(down, -1.2)).toEqual({ relation: "확인", multiplier: 1.15 });
  });

  it("반대 방향이면 반증", () => {
    expect(positionRelation(up, -1.2)).toEqual({ relation: "반증", multiplier: 0.7 });
  });

  it("가격이 조용하거나 매크로 편향이 없으면 중립", () => {
    expect(positionRelation(flat, 1.2).relation).toBe("중립");
    expect(positionRelation(up, 0.1).relation).toBe("중립");
  });

  it("미수집이면 배수 1", () => {
    const none = computePosition("USOIL", {});
    expect(positionRelation(none, 1.2)).toEqual({ relation: "미수집", multiplier: 1 });
  });
});

describe("융합에 반영", () => {
  // 확신도 상한(70)에 닿지 않는 세기로 둬야 배수 효과가 보인다
  const factors = allFactors("USOIL", 1);

  it("가격이 확인해 주면 확신도가 오르고 방향은 그대로다", () => {
    const neutral = run("USOIL", factors, { last: 100, prevClose: 100 });
    const confirmed = run("USOIL", factors, { last: 102, prevClose: 100 });
    expect(confirmed.conviction).toBeGreaterThan(neutral.conviction);
    expect(confirmed.direction).toBe(neutral.direction);
    expect(confirmed.position?.relation).toBe("확인");
    expect(confirmed.playbook).toContain("가격도 확인");
  });

  it("가격이 반대면 확신도가 깎이고 트리거가 붙는다", () => {
    const denied = run("USOIL", factors, { last: 97, prevClose: 100 });
    const neutral = run("USOIL", factors, { last: 100, prevClose: 100 });
    expect(denied.conviction).toBeLessThan(neutral.conviction);
    expect(denied.position?.relation).toBe("반증");
    expect(denied.playbook).toContain("가격은 반대");
    expect(denied.reanalyzeTriggers.some((t) => t.includes("가격이 매크로 편향과 반대"))).toBe(true);
  });

  it("가격은 방향을 뒤집지 못한다", () => {
    const strongUpMacro = allFactors("USOIL", 2);

    const priceCrash = run("USOIL", strongUpMacro, { last: 90, prevClose: 100 });
    expect(priceCrash.score).toBeGreaterThan(0);
    expect(priceCrash.direction).toBeGreaterThanOrEqual(0);
  });

  it("레벨을 못 구하면 배수 1로 지나간다", () => {
    const result = run("USOIL", factors, { last: 84 });
    expect(result.position?.multiplier).toBe(1);
    expect(result.flags).toContain("POSITION_UNAVAILABLE");
  });

  it("fusion 모드에는 위치 레이어를 만들지 않는다", () => {
    const result = fuse(
      "USOIL",
      computeMacro("USOIL", factors, NOW),
      computeTechnical({}),
      computeEvents("USOIL", [], NOW),
      NOW,
    );
    expect(result.position).toBeUndefined();
  });
});
