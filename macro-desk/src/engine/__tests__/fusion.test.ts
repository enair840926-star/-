import { describe, expect, it } from "vitest";
import { computeEvents } from "../events";
import { fuse } from "../fusion";
import { computeMacro } from "../macro";
import { computeTechnical } from "../technical";
import { MACRO_WEIGHTS } from "../weights";
import type { AssetId, MacroEventInput } from "../types";
import { fullSeries } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function macroOf(asset: AssetId, stance: number) {
  return computeMacro(
    asset,
    Object.keys(MACRO_WEIGHTS[asset]).map((key) => ({
      key,
      stance,
      confidence: 1,
      note: "테스트",
    })),
  );
}

function run(
  kind: "up" | "down" | "range",
  macroStance: number,
  events: MacroEventInput[] = [],
  asset: AssetId = "NAS100",
) {
  return fuse(
    asset,
    macroOf(asset, macroStance),
    computeTechnical(fullSeries(kind)),
    computeEvents(asset, events, NOW),
    NOW,
  );
}

describe("합의 매트릭스", () => {
  it("양측 상승은 ALIGNED·고확신·상승 방향", () => {
    const result = run("up", 2);
    expect(result.regime).toBe("ALIGNED");
    expect(result.direction).toBeGreaterThan(0);
    expect(result.conviction).toBeGreaterThan(60);
    expect(result.confidence).toBe("높음");
  });

  it("양측 하락은 ALIGNED·하락 방향", () => {
    const result = run("down", -2);
    expect(result.regime).toBe("ALIGNED");
    expect(result.direction).toBeLessThan(0);
    expect(result.conviction).toBeGreaterThan(60);
  });

  it("상충이면 확신도가 무너지고 방향이 중립으로 강등된다", () => {
    const result = run("up", -2);
    expect(result.regime).toBe("CONFLICT");
    expect(result.direction).toBe(0);
    expect(result.conviction).toBeLessThan(35);
    expect(result.playbook).toContain("관망");
  });

  it("한쪽만 신호를 주면 PARTIAL이고 동조보다 확신도가 낮다", () => {
    const partial = run("up", 0);
    const aligned = run("up", 2);
    expect(partial.regime).toBe("PARTIAL");
    expect(partial.conviction).toBeLessThan(aligned.conviction);
  });

  it("양측 무신호는 RANGE 플레이북", () => {
    const result = run("range", 0);
    expect(result.regime).toBe("RANGE");
    expect(result.playbook).toContain("레인지");
  });
});

describe("이벤트 상한", () => {
  it("1급 이벤트 대기 중에는 확신도가 45로 잘린다", () => {
    const result = run("up", 2, [{ label: "FOMC", time: at(200), tier: 3 }]);
    expect(result.conviction).toBeLessThanOrEqual(45);
    expect(result.weights.technical).toBe(0.5);
    expect(result.weights.macro).toBe(0.5);
  });

  it("블랙아웃 중에는 확신도 30 이하이고 플레이북이 진입 보류를 지시한다", () => {
    const result = run("up", 2, [{ label: "CPI", time: at(5), tier: 3 }]);
    expect(result.conviction).toBeLessThanOrEqual(30);
    expect(result.playbook).toContain("블랙아웃");
    expect(result.direction).toBe(0);
  });

  it("이벤트가 없으면 기본 가중치 0.6/0.4", () => {
    const result = run("up", 2);
    expect(result.weights).toEqual({ technical: 0.6, macro: 0.4 });
  });

  it("유효시각은 다음 블랙아웃 시작을 넘지 않는다", () => {
    const result = run("up", 2, [{ label: "EIA", time: at(90), tier: 2 }]);
    expect(Date.parse(result.validUntil!)).toBeLessThanOrEqual(Date.parse(at(70)));
  });
});

describe("출력 계약", () => {
  it("두 레이어 원값이 그대로 보존된다(레이어 잠금)", () => {
    const macro = macroOf("XAUUSD", 2);
    const technical = computeTechnical(fullSeries("down"));
    const result = fuse("XAUUSD", macro, technical, computeEvents("XAUUSD", [], NOW), NOW);
    expect(result.macro.score).toBe(macro.score);
    expect(result.technical.score).toBe(technical.score);
    expect(result.technical.timeframes).toEqual(technical.timeframes);
  });

  it("재분석 트리거에 무효화 레벨과 만료 시각이 담긴다", () => {
    const result = run("up", 2);
    expect(result.reanalyzeTriggers.some((line) => line.includes("무효화"))).toBe(true);
    expect(result.reanalyzeTriggers.some((line) => line.includes("만료"))).toBe(true);
  });

  it("점수는 항상 -2~+2 안에 있다", () => {
    for (const kind of ["up", "down", "range"] as const) {
      for (const stance of [-2, -1, 0, 1, 2]) {
        const result = run(kind, stance);
        expect(result.score).toBeGreaterThanOrEqual(-2);
        expect(result.score).toBeLessThanOrEqual(2);
        expect(result.conviction).toBeGreaterThanOrEqual(0);
        expect(result.conviction).toBeLessThanOrEqual(100);
      }
    }
  });

  it("데이터가 전혀 없으면 중립·무확신으로 안전하게 떨어진다", () => {
    const result = fuse(
      "USOIL",
      computeMacro("USOIL", []),
      computeTechnical({}),
      computeEvents("USOIL", [], NOW),
      NOW,
    );
    expect(result.direction).toBe(0);
    expect(result.conviction).toBe(0);
    expect(result.flags).toContain("MACRO_EMPTY");
  });
});
