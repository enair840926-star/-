import { describe, expect, it } from "vitest";
import { marketHoursBetween } from "../clock";

const at = (iso: string) => new Date(iso);

describe("marketHoursBetween", () => {
  it("평일 구간은 벽시계 시간과 같다", () => {
    // 2026-08-03(월) ~ 08-04(화)
    expect(marketHoursBetween(at("2026-08-03T00:00:00Z"), at("2026-08-03T08:00:00Z"))).toBe(8);
    expect(marketHoursBetween(at("2026-08-03T12:00:00Z"), at("2026-08-04T12:00:00Z"))).toBe(24);
  });

  it("주말 휴장(금 21시 ~ 일 21시 UTC)을 뺀다", () => {
    // 금 20:00Z → 일 02:00Z = 벽시계 30시간, 휴장 29시간 → 시장 1시간
    expect(marketHoursBetween(at("2026-07-31T20:00:00Z"), at("2026-08-02T02:00:00Z"))).toBeCloseTo(
      1,
      6,
    );
  });

  it("주말을 통째로 건너뛰면 양끝만 남는다", () => {
    // 금 19:00Z → 월 01:00Z = 벽시계 54시간, 휴장 48시간 → 6시간
    expect(marketHoursBetween(at("2026-07-31T19:00:00Z"), at("2026-08-03T01:00:00Z"))).toBeCloseTo(
      6,
      6,
    );
  });

  it("휴장 구간 안에서만 흐르면 0이다", () => {
    expect(marketHoursBetween(at("2026-08-01T02:00:00Z"), at("2026-08-02T10:00:00Z"))).toBe(0);
  });

  it("여러 주를 건너뛰면 주말마다 뺀다", () => {
    // 7/31(금) 12:00Z → 8/10(월) 12:00Z = 벽시계 240시간, 주말 2회(96시간) → 144시간
    expect(
      marketHoursBetween(at("2026-07-31T12:00:00Z"), at("2026-08-10T12:00:00Z")),
    ).toBeCloseTo(144, 6);
  });

  it("역순·동일 시각은 0", () => {
    expect(marketHoursBetween(at("2026-08-03T12:00:00Z"), at("2026-08-03T12:00:00Z"))).toBe(0);
    expect(marketHoursBetween(at("2026-08-04T12:00:00Z"), at("2026-08-03T12:00:00Z"))).toBe(0);
  });
});
