import { describe, expect, it } from "vitest";
import { computeEvents } from "../events";
import { fuse } from "../fusion";
import { computeMacro } from "../macro";
import { computeTechnical } from "../technical";
import { runSnapshot, validateInput } from "../index";
import { MACRO_WEIGHTS } from "../weights";
import type { AssetId, MacroEventInput, MacroFactorInput, SnapshotInput } from "../types";
import { fullSeries } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

function run(
  asset: AssetId,
  factors: MacroFactorInput[],
  events: MacroEventInput[] = [],
  levels?: { last?: number; support?: number[]; resistance?: number[] },
) {
  return fuse(
    asset,
    computeMacro(asset, factors),
    computeTechnical({}),
    computeEvents(asset, events, NOW),
    NOW,
    { mode: "macro-only", levels },
  );
}

const allFactors = (asset: AssetId, stance: number, confidence = 0.9): MacroFactorInput[] =>
  Object.keys(MACRO_WEIGHTS[asset]).map((key) => ({ key, stance, confidence, note: "테스트" }));

describe("매크로 전용 모드", () => {
  it("차트 없이도 편향이 서면 방향을 낸다", () => {
    const result = run("USOIL", allFactors("USOIL", 2));
    expect(result.mode).toBe("macro-only");
    expect(result.direction).toBeGreaterThan(0);
    expect(result.conviction).toBeGreaterThan(50);
    expect(result.weights).toEqual({ technical: 0, macro: 1 });
    expect(result.flags).toContain("MACRO_ONLY");
  });

  it("확신도는 70을 넘지 않는다(차트 미확인 상한)", () => {
    const result = run("XAUUSD", allFactors("XAUUSD", 2, 1));
    expect(result.conviction).toBeLessThanOrEqual(70);
    expect(result.confidence).toBe("높음");
  });

  it("점수는 매크로 점수를 그대로 쓴다", () => {
    const macro = computeMacro("NAS100", allFactors("NAS100", -2));
    const result = run("NAS100", allFactors("NAS100", -2));
    expect(result.score).toBe(macro.score);
    expect(result.direction).toBe(-2);
  });

  it("팩터가 반반으로 갈리면 요인 상충으로 잡고 방향을 비운다", () => {
    const keys = Object.keys(MACRO_WEIGHTS.NAS100);
    const factors = keys.map((key, index) => ({
      key,
      stance: index % 2 === 0 ? 2 : -2,
      confidence: 0.9,
      note: "테스트",
    }));
    const result = run("NAS100", factors);
    expect(result.regime).toBe("CONFLICT");
    expect(result.direction).toBe(0);
    expect(result.playbook).toContain("요인 상충");
    expect(result.playbook).toContain("vs");
  });

  it("편향이 서면 주도 요인과 반대 요인을 이름으로 짚어준다", () => {
    const result = run("EURUSD", [
      { key: "ecbPolicy", stance: 2, confidence: 0.9, note: "9월 인상 확률 79%" },
      { key: "ezData", stance: 2, confidence: 0.9, note: "2Q GDP +0.4%" },
      { key: "rateDiff", stance: -1, confidence: 0.8, note: "미 장기금리 우위" },
    ]);
    expect(result.direction).toBeGreaterThan(0);
    expect(result.playbook).toContain("ECB 스탠스");
    expect(result.playbook).toContain("반대 요인");
  });

  it("관측 레벨이 있으면 확인·무효 문장을 붙인다", () => {
    const result = run("XAUUSD", allFactors("XAUUSD", 2), [], {
      last: 4042,
      support: [4000],
      resistance: [4100],
    });
    expect(result.playbook).toContain("4100 상향 돌파");
    expect(result.playbook).toContain("4000 이탈");
    expect(result.levels?.last).toBe(4042);
    expect(result.reanalyzeTriggers.some((line) => line.includes("지지 4000"))).toBe(true);
    expect(result.reanalyzeTriggers.some((line) => line.includes("저항 4100"))).toBe(true);
  });

  it("이벤트 상한과 블랙아웃은 그대로 적용된다", () => {
    const ahead = run("USOIL", allFactors("USOIL", 2), [{ label: "고용", time: at(200), tier: 3 }]);
    expect(ahead.conviction).toBeLessThanOrEqual(45);

    const inside = run("USOIL", allFactors("USOIL", 2), [{ label: "고용", time: at(5), tier: 3 }]);
    expect(inside.conviction).toBeLessThanOrEqual(30);
    expect(inside.direction).toBe(0);
    expect(inside.playbook).toContain("발표 영향권");
  });

  it("차트 레이어는 비어 있고 무효화 가격을 만들지 않는다", () => {
    const result = run("USOIL", allFactors("USOIL", 2));
    expect(result.technical.timeframes).toHaveLength(0);
    expect(result.technical.invalidation).toEqual({ long: null, short: null });
    expect(result.reanalyzeTriggers.every((line) => !line.includes("무효화"))).toBe(true);
  });
});

describe("스냅샷 기본 모드", () => {
  const input: SnapshotInput = {
    generatedAt: NOW.toISOString(),
    events: [{ label: "ISM 제조업", time: at(120), tier: 2 }],
    assets: {
      USOIL: {
        factors: allFactors("USOIL", 2),
        levels: { last: 84.6, support: [82.5], resistance: [86.0] },
      },
    },
  };

  it("mode를 지정하지 않으면 macro-only로 돈다", () => {
    const snapshot = runSnapshot(input);
    expect(snapshot.mode).toBe("macro-only");
    expect(snapshot.assets.USOIL!.fusion!.mode).toBe("macro-only");
    expect(snapshot.assets.USOIL!.direction).toBeGreaterThan(0);
  });

  it("candles 없이도 검증을 통과한다", () => {
    expect(validateInput(input)).toEqual([]);
  });

  it("factors가 비면 오류로 잡는다", () => {
    const errors = validateInput({ events: [], assets: { USOIL: { factors: [] } } });
    expect(errors.some((error) => error.includes("factors가 비어"))).toBe(true);
  });

  it("자산별로 fusion 모드를 덮어쓸 수 있다", () => {
    const snapshot = runSnapshot({
      ...input,
      assets: {
        ...input.assets,
        NAS100: { mode: "fusion", factors: allFactors("NAS100", 1), candles: fullSeries("up") },
      },
    });
    expect(snapshot.assets.NAS100!.fusion!.mode).toBe("fusion");
    expect(snapshot.assets.NAS100!.fusion!.technical.timeframes.length).toBe(4);
    expect(snapshot.assets.USOIL!.fusion!.mode).toBe("macro-only");
  });
});
