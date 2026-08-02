import { describe, expect, it } from "vitest";
import { atr, ema, normalizeCandles, rsi, squash, swings } from "../indicators";
import { makeSeries } from "./fixtures";

const closes = (rows: ReturnType<typeof makeSeries>) => rows.map((row) => row[4]);

describe("ema", () => {
  it("워밍업 이전 구간은 비어 있고 시드는 단순평균이다", () => {
    const values = [1, 2, 3, 4, 5, 6];
    const out = ema(values, 3);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBeUndefined();
    expect(out[2]).toBeCloseTo(2, 10);
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[5]).toBeGreaterThan(out[4]);
  });

  it("기간보다 짧은 입력에는 빈 배열", () => {
    expect(ema([1, 2], 5)).toEqual([]);
  });
});

describe("atr", () => {
  it("폭이 일정한 캔들에서는 그 폭과 같다", () => {
    const rows = Array.from({ length: 40 }, (_, i) => [
      new Date(Date.UTC(2026, 0, 1) + i * 3_600_000).toISOString(),
      100,
      101,
      99,
      100,
    ]);
    const series = atr(normalizeCandles(rows as never), 14);
    expect(series[series.length - 1]).toBeCloseTo(2, 6);
  });

  it("변동폭이 커지면 ATR도 커진다", () => {
    const narrow = atr(normalizeCandles(makeSeries({ bars: 80, spread: 1 })), 14);
    const wide = atr(normalizeCandles(makeSeries({ bars: 80, spread: 4 })), 14);
    expect(wide[wide.length - 1]).toBeGreaterThan(narrow[narrow.length - 1]);
  });
});

describe("rsi", () => {
  it("단조 상승은 100, 단조 하락은 0에 수렴", () => {
    const up = rsi(Array.from({ length: 40 }, (_, i) => 100 + i), 14);
    const down = rsi(Array.from({ length: 40 }, (_, i) => 100 - i), 14);
    expect(up[up.length - 1]).toBeCloseTo(100, 6);
    expect(down[down.length - 1]).toBeCloseTo(0, 6);
  });
});

describe("swings", () => {
  it("사인파에서 고점과 저점을 번갈아 찾는다", () => {
    const rows = makeSeries({ bars: 60, drift: 0, wave: 5, spread: 0.2 });
    const points = swings(normalizeCandles(rows), 2, 2);
    expect(points.filter((point) => point.kind === "high").length).toBeGreaterThan(2);
    expect(points.filter((point) => point.kind === "low").length).toBeGreaterThan(2);
  });

  it("마지막 right개 봉은 미확정으로 제외된다", () => {
    const rows = normalizeCandles(makeSeries({ bars: 30, drift: 0, wave: 4, spread: 0.2 }));
    const points = swings(rows, 2, 2);
    expect(Math.max(...points.map((point) => point.index))).toBeLessThanOrEqual(rows.length - 3);
  });
});

describe("normalizeCandles", () => {
  it("최신순 입력을 과거→최신으로 정렬한다", () => {
    const rows = makeSeries({ bars: 5 }).reverse();
    const out = normalizeCandles(rows);
    const times = out.map((candle) => Date.parse(candle.t));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it("숫자가 아닌 행은 버린다", () => {
    const out = normalizeCandles([
      ["2026-01-01T00:00:00Z", 1, 2, 0.5, 1.5],
      ["2026-01-01T01:00:00Z", Number.NaN, 2, 0.5, 1.5],
    ] as never);
    expect(out).toHaveLength(1);
  });

  it("객체 형태와 배열 형태를 모두 받는다", () => {
    const out = normalizeCandles([{ t: "2026-01-01T00:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5 }]);
    expect(out[0].c).toBe(1.5);
  });
});

describe("squash", () => {
  it("스케일 대비 크기를 [-1,1]로 압축한다", () => {
    expect(squash(0, 5)).toBe(0);
    expect(squash(100, 1)).toBeCloseTo(1, 6);
    expect(squash(-100, 1)).toBeCloseTo(-1, 6);
    expect(squash(1, 0)).toBe(0);
  });
});

describe("closes helper", () => {
  it("픽스처가 결정적이다", () => {
    expect(closes(makeSeries({ bars: 3, drift: 1 }))).toEqual(closes(makeSeries({ bars: 3, drift: 1 })));
  });
});
