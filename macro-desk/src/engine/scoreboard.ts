/**
 * 검증 루프.
 *
 * 스냅샷마다 (방향·확신도·기준가)를 남기고, 다음 실행에서 실현 방향과 대조해 채점한다.
 * 이 기록이 쌓여야 가중치와 확신도 공식이 추측을 벗어난다.
 *
 * 평가 구간은 **다음 스냅샷까지(8시간)** 로 고정한다. 자산별로 다르게 두지 않는다.
 */
import { round } from "./indicators";
import type {
  AssetId,
  Direction,
  FusionResult,
  PredictionRecord,
  Scoreboard,
  ScoreboardBucket,
} from "./types";
import { MAX_VALID_HOURS, NEUTRAL_BAND_PCT } from "./weights";
import { RULESET_VERSION } from "./types";

const HOUR = 3_600_000;
/** 이 시간을 넘겨 채점되지 못한 기록은 실행 누락으로 보고 닫는다 */
const STALE_AFTER_HOURS = 20;

const CONVICTION_BUCKETS: Array<{ id: string; min: number; max: number }> = [
  { id: "25-39", min: 25, max: 39 },
  { id: "40-54", min: 40, max: 54 },
  { id: "55-69", min: 55, max: 69 },
  { id: "70+", min: 70, max: Infinity },
];

/** 이번 스냅샷의 예측을 기록 1건으로 만든다. */
export function openPrediction(fusion: FusionResult, generatedAt: Date): PredictionRecord {
  const refPrice = fusion.levels?.last ?? fusion.technical.lastPrice ?? null;
  return {
    ts: generatedAt.toISOString(),
    ruleset: RULESET_VERSION,
    asset: fusion.asset,
    mode: fusion.mode,
    direction: fusion.direction,
    conviction: fusion.conviction,
    score: fusion.score,
    regime: fusion.regime,
    coverage: fusion.macro.coverage,
    dispersion: fusion.macro.dispersion,
    factors: fusion.macro.factors.map((factor) => ({
      key: factor.key,
      stance: factor.stance,
      weight: factor.effectiveWeight,
    })),
    positionRelation: fusion.position?.relation ?? null,
    eventTier: fusion.events.maxTier,
    refPrice,
    horizonEnd: new Date(generatedAt.getTime() + MAX_VALID_HOURS * HOUR).toISOString(),
    outcome: null,
  };
}

/**
 * 같은 세션의 예측을 갈아끼운다.
 *
 * 런북은 플래그가 뜨면 고쳐서 다시 돌리라고 지시하므로 한 세션에 여러 번 실행될 수 있다.
 * 아직 채점되지 않은 같은 자산의 최근 기록은 새 예측으로 대체해 중복을 막는다.
 */
export function upsertPrediction(
  records: PredictionRecord[],
  prediction: PredictionRecord,
  windowHours = 2,
): PredictionRecord[] {
  const ts = Date.parse(prediction.ts);
  const next = records.filter(
    (record) =>
      record.outcome !== null ||
      record.asset !== prediction.asset ||
      Math.abs(Date.parse(record.ts) - ts) > windowHours * HOUR,
  );
  next.push(prediction);
  return next;
}

function realizedDirection(movePct: number, asset: AssetId): Direction {
  const band = NEUTRAL_BAND_PCT[asset];
  if (movePct > band) return 1;
  if (movePct < -band) return -1;
  return 0;
}

/**
 * 아직 열려 있는 기록 중 평가 구간이 끝난 것을 채점한다.
 * `prices`에 해당 자산의 현재가가 없으면 그대로 열어둔다(다음 실행에서 다시 시도).
 */
export function scorePredictions(
  records: PredictionRecord[],
  prices: Partial<Record<AssetId, number>>,
  now: Date,
): { records: PredictionRecord[]; scored: number; stale: number } {
  let scored = 0;
  let stale = 0;

  for (const record of records) {
    if (record.outcome) continue;
    if (Date.parse(record.horizonEnd) > now.getTime()) continue;

    const ageHours = (now.getTime() - Date.parse(record.ts)) / HOUR;
    const endPrice = prices[record.asset];

    if (!Number.isFinite(endPrice as number) || !record.refPrice) {
      if (ageHours > STALE_AFTER_HOURS) {
        record.outcome = {
          scoredAt: now.toISOString(),
          endPrice: 0,
          movePct: 0,
          realized: 0,
          hit: null,
          skipped: record.refPrice ? "no-price" : "no-ref",
        };
        stale += 1;
      }
      continue;
    }

    if (ageHours > STALE_AFTER_HOURS) {
      record.outcome = {
        scoredAt: now.toISOString(),
        endPrice: endPrice as number,
        movePct: 0,
        realized: 0,
        hit: null,
        skipped: "stale",
      };
      stale += 1;
      continue;
    }

    const movePct = (((endPrice as number) - record.refPrice) / record.refPrice) * 100;
    const realized = realizedDirection(movePct, record.asset);
    record.outcome = {
      scoredAt: now.toISOString(),
      endPrice: round(endPrice as number, 5),
      movePct: round(movePct, 3),
      realized,
      // 중립 예측은 적중률 모수에서 뺀다. 대신 "중립인데 움직였는지"를 따로 센다.
      hit: record.direction === 0 ? null : Math.sign(record.direction) === realized,
    };
    scored += 1;
  }

  return { records, scored, stale };
}

const emptyBucket = (): ScoreboardBucket => ({ n: 0, hit: 0, rate: null });

function finalize(bucket: ScoreboardBucket): ScoreboardBucket {
  return { ...bucket, rate: bucket.n > 0 ? round(bucket.hit / bucket.n, 3) : null };
}

/** 최근 `window`건의 채점 결과를 자산별·확신도 구간별로 집계한다. */
export function buildScoreboard(
  records: PredictionRecord[],
  now: Date,
  window = 30,
): Scoreboard {
  const closed = records
    .filter((record) => record.outcome && !record.outcome.skipped)
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const recent = closed.slice(Math.max(0, closed.length - window * 4));

  const total = emptyBucket();
  const byAsset: Scoreboard["byAsset"] = {};
  const byConviction: Scoreboard["byConviction"] = {};
  for (const bucket of CONVICTION_BUCKETS) byConviction[bucket.id] = emptyBucket();

  for (const record of recent) {
    const outcome = record.outcome!;
    const asset = (byAsset[record.asset] ??= { ...emptyBucket(), neutralN: 0, neutralMoved: 0 });

    if (outcome.hit === null) {
      asset.neutralN += 1;
      if (outcome.realized !== 0) asset.neutralMoved += 1;
      continue;
    }

    total.n += 1;
    asset.n += 1;
    if (outcome.hit) {
      total.hit += 1;
      asset.hit += 1;
    }
    const bucket = CONVICTION_BUCKETS.find(
      (b) => record.conviction >= b.min && record.conviction <= b.max,
    );
    if (bucket) {
      byConviction[bucket.id].n += 1;
      if (outcome.hit) byConviction[bucket.id].hit += 1;
    }
  }

  return {
    window,
    total: finalize(total),
    byAsset: Object.fromEntries(
      Object.entries(byAsset).map(([asset, bucket]) => [
        asset,
        { ...finalize(bucket), neutralN: bucket.neutralN, neutralMoved: bucket.neutralMoved },
      ]),
    ),
    byConviction: Object.fromEntries(
      Object.entries(byConviction).map(([id, bucket]) => [id, finalize(bucket)]),
    ),
    updatedAt: now.toISOString(),
  };
}

/** jsonl 한 줄씩 파싱. 깨진 줄은 버리고 개수만 알린다. */
export function parsePredictions(text: string): { records: PredictionRecord[]; broken: number } {
  const records: PredictionRecord[] = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed) as PredictionRecord;
      if (record && typeof record.ts === "string" && typeof record.asset === "string") {
        records.push(record);
      } else {
        broken += 1;
      }
    } catch {
      broken += 1;
    }
  }
  return { records, broken };
}

export function serializePredictions(records: PredictionRecord[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + "\n";
}

/** 알림 한 줄용 요약 */
export function scoreboardLine(scoreboard: Scoreboard): string {
  if (!scoreboard.total.n) return "적중률 집계 전 (기록 축적 중)";
  const rate = Math.round((scoreboard.total.rate ?? 0) * 100);
  const strong = scoreboard.byConviction["40-54"];
  const stronger = scoreboard.byConviction["55-69"];
  const high = (strong?.n ?? 0) + (stronger?.n ?? 0);
  const highHit = (strong?.hit ?? 0) + (stronger?.hit ?? 0);
  const tail = high > 0 ? ` (확신도 40+ 구간 ${Math.round((highHit / high) * 100)}%)` : "";
  return `적중률 최근 ${scoreboard.total.n}건 ${rate}%${tail}`;
}
