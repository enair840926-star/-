import { describe, expect, it } from "vitest";
import { computeEvents } from "../events";
import type { MacroEventInput } from "../types";

const NOW = new Date("2026-08-03T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

describe("computeEvents", () => {
  it("이벤트가 없으면 상한 100·티어 0", () => {
    const layer = computeEvents("NAS100", [], NOW);
    expect(layer.maxTier).toBe(0);
    expect(layer.convictionCap).toBe(100);
    expect(layer.activeBlackout).toBeNull();
  });

  it("1급 이벤트가 유효구간에 있으면 상한 45", () => {
    const events: MacroEventInput[] = [{ label: "FOMC", time: at(180), tier: 3 }];
    const layer = computeEvents("NAS100", events, NOW);
    expect(layer.maxTier).toBe(3);
    expect(layer.convictionCap).toBe(45);
    expect(layer.flags).toContain("TIER1_EVENT_AHEAD");
    expect(layer.nextBlackoutStart).toBe(at(135));
  });

  it("블랙아웃 구간 안이면 active로 표시된다", () => {
    const events: MacroEventInput[] = [{ label: "CPI", time: at(10), tier: 3 }];
    const layer = computeEvents("XAUUSD", events, NOW);
    expect(layer.activeBlackout?.label).toBe("CPI");
    expect(layer.flags).toContain("BLACKOUT_ACTIVE:CPI");
    expect(layer.windows[0].minutesUntil).toBe(10);
  });

  it("자산 필터가 적용된다", () => {
    const events: MacroEventInput[] = [
      { label: "EIA 재고", time: at(60), tier: 2, assets: ["USOIL"] },
    ];
    expect(computeEvents("USOIL", events, NOW).maxTier).toBe(2);
    expect(computeEvents("EURUSD", events, NOW).maxTier).toBe(0);
  });

  it("유효구간 밖의 이벤트는 표기만 하고 확신도 상한에는 넣지 않는다", () => {
    const events: MacroEventInput[] = [{ label: "다음날 FOMC", time: at(60 * 20), tier: 3 }];
    const layer = computeEvents("NAS100", events, NOW);
    expect(layer.windows).toHaveLength(1);
    expect(layer.headline?.label).toBe("다음날 FOMC");
    expect(layer.maxTier).toBe(0);
    expect(layer.convictionCap).toBe(100);
  });

  it("48시간을 넘어가면 표기에서도 빠진다", () => {
    const layer = computeEvents("NAS100", [{ label: "먼 이벤트", time: at(60 * 60), tier: 3 }], NOW);
    expect(layer.windows).toHaveLength(0);
    expect(layer.headline).toBeNull();
  });

  it("이미 지나간 이벤트는 상한을 되돌린다", () => {
    const events: MacroEventInput[] = [{ label: "지나간 지표", time: at(-90), tier: 3 }];
    const layer = computeEvents("NAS100", events, NOW);
    expect(layer.activeBlackout).toBeNull();
    expect(layer.convictionCap).toBe(100);
  });

  it("여러 이벤트 중 최고 티어가 상한을 정한다", () => {
    const events: MacroEventInput[] = [
      { label: "2급", time: at(30), tier: 2 },
      { label: "1급", time: at(200), tier: 3 },
    ];
    expect(computeEvents("NAS100", events, NOW).convictionCap).toBe(45);
  });

  it("시간 파싱 실패는 플래그로 남긴다", () => {
    const layer = computeEvents("NAS100", [{ label: "깨진값", time: "언젠가", tier: 2 }], NOW);
    expect(layer.flags).toContain("EVENT_BAD_TIME:깨진값");
  });
});
