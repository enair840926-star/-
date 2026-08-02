import { describe, expect, it } from "vitest";
import { renderNotification } from "../notify";
import { runSnapshot } from "../index";
import type { SnapshotInput } from "../types";
import { allFactors, factorInput } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000).toISOString();

const levels = { last: 100, prevClose: 98.5, support: [95], resistance: [105] };

function snapshot(input: Partial<SnapshotInput> = {}) {
  return runSnapshot({
    generatedAt: NOW.toISOString(),
    events: [],
    assets: {},
    ...input,
  });
}

describe("알림 문구", () => {
  it("방향이 선 자산을 첫 줄에 올리고 나머지는 관망으로 센다", () => {
    const text = renderNotification(
      snapshot({
        assets: {
          USOIL: { factors: allFactors("USOIL", 2), levels },
          NAS100: { factors: [factorInput("NAS100", "usRates", 0)], levels },
        },
      }),
    );
    const first = text.split("\n")[0];
    expect(first).toContain("USOIL");
    expect(first).toContain("상승");
    expect(first).toContain("나머지 1종 관망");
  });

  it("전부 중립이면 그렇게 알린다", () => {
    const text = renderNotification(
      snapshot({
        assets: { USOIL: { factors: [factorInput("USOIL", "dollar", 0)], levels } },
      }),
    );
    expect(text.split("\n")[0]).toContain("전 종목 관망");
  });

  it("블랙아웃이면 첫 줄이 보류 안내로 바뀐다", () => {
    const text = renderNotification(
      snapshot({
        events: [{ label: "고용보고서", time: at(10), tier: 3 }],
        assets: { USOIL: { factors: allFactors("USOIL", 2), levels } },
      }),
    );
    expect(text.split("\n")[0]).toContain("⛔");
    expect(text.split("\n")[0]).toContain("고용보고서");
    expect(text.split("\n")[0]).toContain("판단 보류");
  });

  it("방향이 선 자산에는 주도·반대 요인과 돌파 레벨이 붙는다", () => {
    const text = renderNotification(
      snapshot({
        assets: {
          USOIL: {
            factors: [factorInput("USOIL", "supplyRisk", 2), factorInput("USOIL", "opec", -1)],
            levels,
          },
        },
      }),
    );
    expect(text).toContain("공급 차질 주도");
    expect(text).toContain("반대 OPEC+");
    expect(text).toContain("105 돌파 시 강화");
    expect(text).toContain("95 이탈 시 무효");
  });

  it("중립 자산에는 상충 구도와 기울기를 보여준다", () => {
    const text = renderNotification(
      snapshot({
        assets: {
          NAS100: {
            factors: [factorInput("NAS100", "usRates", -2), factorInput("NAS100", "riskAppetite", 2)],
            levels,
          },
        },
      }),
    );
    expect(text).toContain("상충");
    expect(text).toMatch(/미세|완전 중립|상승 쪽|하락 쪽/);
    expect(text).toContain("95 ~ 105 이탈 시 재확인");
  });

  it("가격 동조·역행을 표시한다", () => {
    const up = renderNotification(
      snapshot({
        assets: { USOIL: { factors: allFactors("USOIL", 2), levels: { ...levels, last: 103, prevClose: 100 } } },
      }),
    );
    expect(up).toContain("동조");
    const down = renderNotification(
      snapshot({
        assets: { USOIL: { factors: allFactors("USOIL", 2), levels: { ...levels, last: 97, prevClose: 100 } } },
      }),
    );
    expect(down).toContain("역행");
  });

  it("36시간 내 이벤트를 경고로 붙인다", () => {
    const text = renderNotification(
      snapshot({
        events: [{ label: "미국 고용보고서", time: at(30 * 60), tier: 3 }],
        assets: { USOIL: { factors: allFactors("USOIL", 1), levels } },
      }),
    );
    expect(text).toContain("⚡");
    expect(text).toContain("미국 고용보고서");
    expect(text).toContain("1급");
  });

  it("적중률이 없으면 집계 전으로 표기한다", () => {
    const text = renderNotification(
      snapshot({ assets: { USOIL: { factors: allFactors("USOIL", 1), levels } } }),
    );
    expect(text.trim().endsWith("적중률 집계 전")).toBe(true);
  });

  it("자산이 없으면 안전하게 떨어진다", () => {
    expect(renderNotification(snapshot())).toContain("자산이 없습니다");
  });
});
