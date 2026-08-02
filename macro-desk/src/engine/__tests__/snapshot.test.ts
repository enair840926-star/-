import { describe, expect, it } from "vitest";
import { runSnapshot, validateInput } from "../index";
import type { SnapshotInput } from "../types";
import { allFactors, factorInput, fullSeries } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");

const input: SnapshotInput = {
  mode: "fusion",
  generatedAt: NOW.toISOString(),
  events: [{ label: "FOMC 성명", time: "2026-08-03T18:00:00Z", tier: 3, assets: ["NAS100"] }],
  assets: {
    NAS100: {
      factors: [
        { key: "usRates", value: -6, confidence: 0.9, note: "10Y 4.10%로 6bp 하락" },
        { key: "fedPolicy", stance: 1, confidence: 0.8, note: "9월 인하 확률 72%" },
        { key: "riskAppetite", value: -0.8, confidence: 0.8, note: "VIX 14.2(-0.8pt)" },
        { key: "megacapEarnings", stance: 2, confidence: 0.9, note: "빅테크 가이던스 상향" },
        { key: "breadth", value: 62, confidence: 0.7, note: "상승종목 62%" },
        { key: "dollar", value: 0, confidence: 0.7, note: "DXY 보합" },
      ],
      candles: fullSeries("up"),
      dataSource: "테스트 합성 시계열",
    },
    XAUUSD: {
      factors: [{ key: "dollar", value: 0.3, confidence: 0.8, note: "DXY +0.3%" }],
      candles: fullSeries("down"),
    },
  },
};

describe("runSnapshot", () => {
  const snapshot = runSnapshot(input);

  it("입력에 있는 자산만 출력한다", () => {
    expect(Object.keys(snapshot.assets).sort()).toEqual(["NAS100", "XAUUSD"]);
    expect(snapshot.version).toBe(2);
    expect(snapshot.ruleset).toBe("fusion-v1.0");
  });

  it("v1 화면이 읽는 필드를 그대로 채운다", () => {
    const asset = snapshot.assets.NAS100!;
    expect([-2, -1, 0, 1, 2]).toContain(asset.direction);
    expect(["높음", "중간", "낮음"]).toContain(asset.confidence);
    expect(asset.source).toBe("scheduled");
    expect(asset.setAt).toBe(NOW.toISOString());
    expect(asset.asof).toContain("KST");
    expect(asset.rationale.length).toBeGreaterThan(0);
    expect(asset.drivers.length).toBeGreaterThan(0);
    expect(asset.drivers.every((driver) => ["상승", "하락", "중립"].includes(driver.read))).toBe(true);
  });

  it("drivers 마지막 항목으로 차트 요약이 붙는다", () => {
    const drivers = snapshot.assets.NAS100!.drivers;
    expect(drivers[drivers.length - 1].name).toBe("차트 구조");
    expect(drivers[drivers.length - 1].note).toContain("D1");
  });

  it("헤드라인 이벤트가 자산별로 다르게 붙는다", () => {
    expect(snapshot.assets.NAS100!.event).toContain("FOMC");
    expect(snapshot.assets.XAUUSD!.event).toBe("없음");
  });

  it("fusion 블록에 두 레이어 근거가 모두 들어간다", () => {
    const fusion = snapshot.assets.NAS100!.fusion!;
    expect(fusion.macro.factors.length).toBe(6);
    expect(fusion.technical.timeframes.length).toBe(4);
    expect(fusion.events.maxTier).toBe(3);
    expect(fusion.conviction).toBeLessThanOrEqual(45);
  });

  it("커버리지가 낮은 자산은 낮은 확신도로 표시된다", () => {
    const gold = snapshot.assets.XAUUSD!.fusion!;
    expect(gold.macro.flags).toContain("MACRO_COVERAGE_LOW");
    expect(gold.macro.coverage).toBeLessThan(0.5);
  });
});

describe("validateInput", () => {
  it("정상 입력은 오류 없음", () => {
    expect(validateInput(input)).toEqual([]);
  });

  it("잘못된 팩터 키·이벤트 티어·빈 캔들을 잡아낸다", () => {
    const errors = validateInput({
      mode: "fusion",
      events: [{ label: "이상한 이벤트", time: "not-a-date", tier: 9 as never }],
      assets: {
        NAS100: {
          factors: [{ key: "oilInventory", value: 1, note: "잘못된 키" }],
          candles: {},
        },
      },
    });
    expect(errors.some((error) => error.includes("알 수 없는 팩터 키"))).toBe(true);
    expect(errors.some((error) => error.includes("time 파싱 불가"))).toBe(true);
    expect(errors.some((error) => error.includes("tier"))).toBe(true);
    expect(errors.some((error) => error.includes("candles가 비어"))).toBe(true);
  });

  it("note 누락과 숫자가 아닌 stance를 잡아낸다", () => {
    const errors = validateInput({
      events: [],
      assets: {
        USOIL: {
          factors: [{ key: "inventory", value: "많음" as never, note: "" }],
          candles: fullSeries("up"),
        },
      },
    });
    expect(errors.some((error) => error.includes("value가 필요합니다"))).toBe(true);
    expect(errors.some((error) => error.includes("note가 비어"))).toBe(true);
  });
});
