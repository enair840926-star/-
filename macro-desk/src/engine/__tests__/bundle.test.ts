import { describe, expect, it } from "vitest";
import { collectByTimeframe, extractBundleCandles, normalizeTf, toRow } from "../bundle";

const candle = (time: string, close: number, extra: Record<string, unknown> = {}) => ({
  time_utc: time,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  tick_volume: 100,
  is_complete: true,
  ...extra,
});

describe("normalizeTf", () => {
  it("표기 변형을 흡수한다", () => {
    expect(normalizeTf("H1")).toBe("H1");
    expect(normalizeTf("h1")).toBe("H1");
    expect(normalizeTf("1h")).toBe("H1");
    expect(normalizeTf("240")).toBe("H4");
    expect(normalizeTf("M5")).toBeNull();
    expect(normalizeTf(15)).toBeNull();
  });
});

describe("toRow", () => {
  it("확정봉만 통과시킨다", () => {
    expect(toRow(candle("2026-07-31T21:00:00Z", 100))).not.toBeNull();
    expect(toRow(candle("2026-07-31T22:00:00Z", 100, { is_complete: false }))).toBeNull();
  });

  it("공백 구분 시각과 epoch를 모두 UTC로 읽는다", () => {
    expect(toRow(candle("2026-07-31 21:00:00", 100))![0]).toBe("2026-07-31T21:00:00.000Z");
    expect(toRow({ ...candle("x", 100), time_utc: 1_785_000_000_000 })![0]).toBe(
      new Date(1_785_000_000_000).toISOString(),
    );
    expect(toRow({ ...candle("x", 100), time_utc: 1_785_000_000 })![0]).toBe(
      new Date(1_785_000_000_000).toISOString(),
    );
  });

  it("o/h/l/c 축약 키도 받는다", () => {
    const row = toRow({ t: "2026-07-31T21:00:00Z", o: 1, h: 3, l: 0.5, c: 2 });
    expect(row).toEqual(["2026-07-31T21:00:00.000Z", 1, 3, 0.5, 2]);
  });

  it("시각이나 가격이 깨지면 버린다", () => {
    expect(toRow({ time_utc: "언젠가", open: 1, high: 2, low: 0, close: 1 })).toBeNull();
    expect(toRow({ time_utc: "2026-07-31T21:00:00Z", open: "x", high: 2, low: 0, close: 1 })).toBeNull();
  });
});

describe("collectByTimeframe", () => {
  it("TF 키 객체 형태를 읽는다", () => {
    const bundle = { candles: { H1: [candle("2026-07-31T21:00:00Z", 100)], D1: [] } };
    expect(collectByTimeframe(bundle).H1).toHaveLength(1);
  });

  it("tf 필드를 가진 배열 형태를 읽는다", () => {
    const bundle = {
      candles: [
        { tf: "H4", candles: [candle("2026-07-31T20:00:00Z", 100)] },
        { timeframe: "d1", bars: [candle("2026-07-30T21:00:00Z", 99)] },
      ],
    };
    const out = collectByTimeframe(bundle);
    expect(out.H4).toHaveLength(1);
    expect(out.D1).toHaveLength(1);
  });

  it("중첩된 위치에 있어도 찾아낸다", () => {
    const bundle = { data: { market: { by_tf: { M15: [candle("2026-07-31T21:45:00Z", 100)] } } } };
    expect(collectByTimeframe(bundle).M15).toHaveLength(1);
  });
});

describe("extractBundleCandles", () => {
  const rows = Array.from({ length: 10 }, (_, i) =>
    candle(new Date(Date.UTC(2026, 6, 31, 8 + i)).toISOString(), 100 + i),
  );

  it("시간순 정렬·중복 제거·개수 제한을 적용한다", () => {
    const bundle = { candles: { H1: [...rows].reverse().concat([rows[0]]) } };
    const { candles, report } = extractBundleCandles(bundle, 5);
    expect(candles.H1).toHaveLength(5);
    expect(candles.H1![0][0]).toBe(rows[5].time_utc);
    expect(candles.H1![4][4]).toBe(109);
    const h1 = report.find((entry) => entry.tf === "H1")!;
    expect(h1.dropped).toBe(1);
    expect(h1.lastTime).toBe(rows[9].time_utc);
  });

  it("미확정봉은 제외한다", () => {
    const bundle = {
      candles: { H1: [...rows, candle("2026-07-31T18:00:00Z", 200, { is_complete: false })] },
    };
    const { candles } = extractBundleCandles(bundle);
    expect(candles.H1).toHaveLength(10);
    expect(candles.H1!.every((row) => row[4] < 200)).toBe(true);
  });

  it("캔들이 없으면 빈 결과와 0봉 리포트", () => {
    const { candles, report } = extractBundleCandles({ meta: {} });
    expect(Object.keys(candles)).toHaveLength(0);
    expect(report.every((entry) => entry.bars === 0)).toBe(true);
  });
});
