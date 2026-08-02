import { describe, expect, it } from "vitest";
import {
  buildScoreboard,
  openPrediction,
  parsePredictions,
  scoreboardLine,
  scorePredictions,
  serializePredictions,
  upsertPrediction,
} from "../scoreboard";
import { computeEvents } from "../events";
import { fuse } from "../fusion";
import { computeMacro } from "../macro";
import { computeTechnical } from "../technical";
import { NEUTRAL_BAND_PCT } from "../weights";
import type { AssetId, Direction, PredictionRecord } from "../types";
import { allFactors } from "./fixtures";

const NOW = new Date("2026-08-03T12:00:00Z");
const hoursLater = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

function record(
  overrides: Partial<PredictionRecord> & { asset: AssetId; direction: Direction },
): PredictionRecord {
  return {
    ts: NOW.toISOString(),
    ruleset: "fusion-v1.1",
    mode: "macro-only",
    conviction: 45,
    score: 0.8,
    regime: "PARTIAL",
    refPrice: 100,
    horizonEnd: hoursLater(8).toISOString(),
    outcome: null,
    ...overrides,
  };
}

describe("openPrediction", () => {
  it("융합 결과에서 기준가와 평가 종료 시각을 만든다", () => {
    const fusion = fuse(
      "USOIL",
      computeMacro("USOIL", allFactors("USOIL", 2), NOW),
      computeTechnical({}),
      computeEvents("USOIL", [], NOW),
      NOW,
      { mode: "macro-only", levels: { last: 84.67, prevClose: 83.9 } },
    );
    const prediction = openPrediction(fusion, NOW);
    expect(prediction.asset).toBe("USOIL");
    expect(prediction.refPrice).toBe(84.67);
    expect(prediction.direction).toBe(fusion.direction);
    expect(prediction.conviction).toBe(fusion.conviction);
    expect(prediction.horizonEnd).toBe(hoursLater(8).toISOString());
    expect(prediction.outcome).toBeNull();
    expect(prediction.ruleset).toBe("fusion-v1.1");
  });
});

describe("scorePredictions", () => {
  it("평가 구간이 끝나면 중립밴드로 실현 방향을 정해 채점한다", () => {
    const band = NEUTRAL_BAND_PCT.USOIL; // 0.8%
    const records = [
      record({ asset: "USOIL", direction: 1 }),
      record({ asset: "XAUUSD", direction: -1, refPrice: 4000 }),
    ];
    const { scored } = scorePredictions(
      records,
      { USOIL: 100 * (1 + (band + 0.5) / 100), XAUUSD: 3960 },
      hoursLater(8),
    );
    expect(scored).toBe(2);
    expect(records[0].outcome!.realized).toBe(1);
    expect(records[0].outcome!.hit).toBe(true);
    expect(records[1].outcome!.realized).toBe(-1);
    expect(records[1].outcome!.hit).toBe(true);
  });

  it("밴드 안에서 움직이면 실현 방향은 중립이고 방향 예측은 빗나간 것으로 본다", () => {
    const records = [record({ asset: "USOIL", direction: 1 })];
    scorePredictions(records, { USOIL: 100.2 }, hoursLater(8));
    expect(records[0].outcome!.realized).toBe(0);
    expect(records[0].outcome!.hit).toBe(false);
  });

  it("중립 예측은 적중률 모수에서 빼고 실제 움직임만 남긴다", () => {
    const records = [record({ asset: "USOIL", direction: 0, conviction: 12 })];
    scorePredictions(records, { USOIL: 103 }, hoursLater(8));
    expect(records[0].outcome!.hit).toBeNull();
    expect(records[0].outcome!.realized).toBe(1);
  });

  it("평가 구간 전에는 건드리지 않는다", () => {
    const records = [record({ asset: "USOIL", direction: 1 })];
    const { scored } = scorePredictions(records, { USOIL: 110 }, hoursLater(3));
    expect(scored).toBe(0);
    expect(records[0].outcome).toBeNull();
  });

  it("가격이 없으면 열어두고 다음 실행에서 다시 시도한다", () => {
    const records = [record({ asset: "USOIL", direction: 1 })];
    scorePredictions(records, {}, hoursLater(9));
    expect(records[0].outcome).toBeNull();
    scorePredictions(records, { USOIL: 105 }, hoursLater(10));
    expect(records[0].outcome!.hit).toBe(true);
  });

  it("20시간을 넘겨도 못 채우면 실행 누락으로 닫는다", () => {
    const records = [record({ asset: "USOIL", direction: 1 })];
    const { stale } = scorePredictions(records, {}, hoursLater(21));
    expect(stale).toBe(1);
    expect(records[0].outcome!.skipped).toBe("no-price");
    expect(records[0].outcome!.hit).toBeNull();
  });

  it("이미 채점된 기록은 다시 건드리지 않는다", () => {
    const records = [record({ asset: "USOIL", direction: 1 })];
    scorePredictions(records, { USOIL: 105 }, hoursLater(8));
    const first = records[0].outcome!.endPrice;
    scorePredictions(records, { USOIL: 90 }, hoursLater(16));
    expect(records[0].outcome!.endPrice).toBe(first);
  });
});

describe("buildScoreboard", () => {
  const closed = (asset: AssetId, direction: Direction, conviction: number, hit: boolean) =>
    record({
      asset,
      direction,
      conviction,
      outcome: {
        scoredAt: NOW.toISOString(),
        endPrice: 100,
        movePct: hit ? 2 : -2,
        realized: (hit ? direction : -direction) as Direction,
        hit,
      },
    });

  it("자산별·확신도 구간별로 집계한다", () => {
    const board = buildScoreboard(
      [
        closed("USOIL", 1, 45, true),
        closed("USOIL", 1, 45, false),
        closed("USOIL", -1, 60, true),
        closed("NAS100", 1, 30, false),
      ],
      NOW,
    );
    expect(board.total).toMatchObject({ n: 4, hit: 2, rate: 0.5 });
    expect(board.byAsset.USOIL).toMatchObject({ n: 3, hit: 2 });
    expect(board.byConviction["40-54"]).toMatchObject({ n: 2, hit: 1 });
    expect(board.byConviction["55-69"]).toMatchObject({ n: 1, hit: 1, rate: 1 });
    expect(board.byConviction["25-39"]).toMatchObject({ n: 1, hit: 0, rate: 0 });
  });

  it("중립 예측은 따로 세서 과보수성을 드러낸다", () => {
    const neutral = record({
      asset: "EURUSD",
      direction: 0,
      conviction: 10,
      outcome: {
        scoredAt: NOW.toISOString(),
        endPrice: 1.16,
        movePct: 1.2,
        realized: 1,
        hit: null,
      },
    });
    const board = buildScoreboard([neutral, closed("EURUSD", 1, 45, true)], NOW);
    expect(board.byAsset.EURUSD.neutralN).toBe(1);
    expect(board.byAsset.EURUSD.neutralMoved).toBe(1);
    expect(board.byAsset.EURUSD.n).toBe(1);
  });

  it("채점 안 된 기록과 누락 마감은 집계에서 뺀다", () => {
    const board = buildScoreboard(
      [
        record({ asset: "USOIL", direction: 1 }),
        record({
          asset: "USOIL",
          direction: 1,
          outcome: {
            scoredAt: NOW.toISOString(),
            endPrice: 0,
            movePct: 0,
            realized: 0,
            hit: null,
            skipped: "stale",
          },
        }),
      ],
      NOW,
    );
    expect(board.total.n).toBe(0);
    expect(board.total.rate).toBeNull();
  });

  it("기록이 없으면 알림 문구가 집계 전으로 나온다", () => {
    expect(scoreboardLine(buildScoreboard([], NOW))).toContain("집계 전");
  });

  it("집계가 있으면 전체와 확신도 40+ 적중률을 함께 표기한다", () => {
    const line = scoreboardLine(
      buildScoreboard([closed("USOIL", 1, 45, true), closed("USOIL", 1, 45, true)], NOW),
    );
    expect(line).toContain("100%");
    expect(line).toContain("확신도 40+");
  });
});

describe("jsonl 직렬화", () => {
  it("왕복해도 값이 보존된다", () => {
    const records = [record({ asset: "USOIL", direction: 1 }), record({ asset: "NAS100", direction: -2 })];
    const { records: parsed, broken } = parsePredictions(serializePredictions(records));
    expect(broken).toBe(0);
    expect(parsed).toEqual(records);
  });

  it("깨진 줄과 빈 줄은 건너뛴다", () => {
    const text = `${JSON.stringify(record({ asset: "USOIL", direction: 1 }))}\n\n{깨짐\n{"x":1}\n`;
    const { records, broken } = parsePredictions(text);
    expect(records).toHaveLength(1);
    expect(broken).toBe(2);
  });
});

describe("upsertPrediction", () => {
  it("같은 세션에서 다시 돌리면 기존 예측을 갈아끼운다", () => {
    const first = record({ asset: "USOIL", direction: 1, conviction: 30 });
    const retry = record({
      asset: "USOIL",
      direction: 1,
      conviction: 45,
      ts: new Date(NOW.getTime() + 15 * 60_000).toISOString(),
    });
    const out = upsertPrediction([first], retry);
    expect(out).toHaveLength(1);
    expect(out[0].conviction).toBe(45);
  });

  it("다른 자산은 건드리지 않는다", () => {
    const other = record({ asset: "NAS100", direction: -1 });
    const out = upsertPrediction([other], record({ asset: "USOIL", direction: 1 }));
    expect(out).toHaveLength(2);
  });

  it("이미 채점된 기록은 남긴다", () => {
    const closed = record({
      asset: "USOIL",
      direction: 1,
      outcome: { scoredAt: NOW.toISOString(), endPrice: 100, movePct: 2, realized: 1, hit: true },
    });
    const out = upsertPrediction([closed], record({ asset: "USOIL", direction: -1 }));
    expect(out).toHaveLength(2);
  });

  it("다음 세션(2시간 초과)의 예측은 새로 쌓인다", () => {
    const first = record({ asset: "USOIL", direction: 1 });
    const nextSession = record({
      asset: "USOIL",
      direction: -1,
      ts: new Date(NOW.getTime() + 8 * 3_600_000).toISOString(),
    });
    expect(upsertPrediction([first], nextSession)).toHaveLength(2);
  });
});
