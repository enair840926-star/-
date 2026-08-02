/**
 * 성과 평가.
 *
 * 이진 적중률만으로는 정보의 대부분을 버린다. 편향이 +0.77이었는지 +0.24였는지,
 * 실제로 2% 움직였는지 0.9% 움직였는지가 전부 날아간다. 그래서 표본 700건이
 * 필요해지고 반년을 기다려야 한다.
 *
 * 여기서는 네 가지를 더 본다.
 *  1. IC — 연속 상관. 중립 예측도 표본이 되어 판정 기간이 크게 줄어든다
 *  2. 벤치마크 — "전일 방향 지속"보다 나은가. 비교 대상이 없으면 어떤 숫자도 의미가 없다
 *  3. 정책 시뮬레이션 — 확신도 임계별로 실제 수익이 어떻게 되는가
 *  4. 다중 지평 — 8시간이 매크로에 너무 짧은 것인지 24시간에서 확인
 *
 * 모든 계산은 결정적이다. 기록만 있으면 언제든 같은 결과가 나온다.
 */
import { round } from "./indicators";
import type { AssetId, Direction, PredictionRecord } from "./types";

/** 진입 1회당 차감할 왕복 비용(%p). 스프레드·슬리피지 근사 */
export const DEFAULT_COST_PCT = 0.03;
/** IC가 유의하다고 볼 최소 |t| */
export const IC_T_THRESHOLD = 2;

// ── 상관 ────────────────────────────────────────────────────────────

export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx <= 0 || dy <= 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** 동순위를 평균 순위로 처리한 랭크 변환 */
export function ranks(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value, index }));
  indexed.sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].value === indexed[i].value) j += 1;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[indexed[k].index] = average;
    i = j + 1;
  }
  return out;
}

export function spearman(xs: number[], ys: number[]): number | null {
  if (Math.min(xs.length, ys.length) < 3) return null;
  return pearson(ranks(xs), ranks(ys));
}

// ── 지평 표본 ───────────────────────────────────────────────────────

export interface HorizonSample {
  asset: AssetId;
  ts: string;
  direction: Direction;
  conviction: number;
  score: number;
  priorMovePct: number | null;
  coverage: number;
  /** 지평 종료 시점까지의 변화율(%) */
  movePct: number;
  /** 중립밴드로 이산화한 실현 방향 */
  realized: Direction;
}

/**
 * 기록만으로 임의 지평의 실현 결과를 만든다.
 *
 * outcome 필드에 의존하지 않는다 — 같은 예측을 8시간·24시간 두 지평으로
 * 동시에 평가할 수 있어야 "매크로가 실제로 작동하는 시간축"을 찾을 수 있다.
 */
export function sampleAtHorizon(
  records: PredictionRecord[],
  hours: number,
  bands: Record<AssetId, number>,
): HorizonSample[] {
  const byAsset = new Map<AssetId, PredictionRecord[]>();
  for (const record of records) {
    if (!Number.isFinite(record.refPrice as number)) continue;
    const list = byAsset.get(record.asset) ?? [];
    list.push(record);
    byAsset.set(record.asset, list);
  }

  const out: HorizonSample[] = [];
  const target = hours * 3_600_000;
  const lower = target * 0.75;
  const upper = target * 1.75;

  for (const [asset, list] of byAsset) {
    const sorted = [...list].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    for (let i = 0; i < sorted.length; i += 1) {
      const start = sorted[i];
      const startMs = Date.parse(start.ts);
      const end = sorted.slice(i + 1).find((candidate) => {
        const gap = Date.parse(candidate.ts) - startMs;
        return gap >= lower && gap <= upper;
      });
      if (!end || !end.refPrice || !start.refPrice) continue;

      const movePct = ((end.refPrice - start.refPrice) / start.refPrice) * 100;
      const band = bands[asset];
      const realized: Direction = movePct > band ? 1 : movePct < -band ? -1 : 0;
      out.push({
        asset,
        ts: start.ts,
        direction: start.direction,
        conviction: start.conviction,
        score: start.score,
        priorMovePct: start.priorMovePct,
        coverage: start.coverage,
        movePct: round(movePct, 4),
        realized,
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

// ── 1. IC ──────────────────────────────────────────────────────────

export interface IcResult {
  n: number;
  ic: number | null;
  rankIc: number | null;
  /** 표준오차 근사 1/√n */
  se: number | null;
  t: number | null;
  significant: boolean;
  note: string;
}

/** 편향 점수와 실현 변화율의 상관. 중립 예측도 표본이 된다. */
export function informationCoefficient(samples: HorizonSample[]): IcResult {
  const xs = samples.map((sample) => sample.score);
  const ys = samples.map((sample) => sample.movePct);
  const n = samples.length;
  const ic = pearson(xs, ys);
  const rankIc = spearman(xs, ys);

  if (ic === null || n < 10) {
    return { n, ic, rankIc, se: null, t: null, significant: false, note: "표본 부족 (10건 미만)" };
  }
  const se = 1 / Math.sqrt(n);
  const t = ic / se;
  const significant = Math.abs(t) >= IC_T_THRESHOLD;
  return {
    n,
    ic: round(ic, 4),
    rankIc: rankIc === null ? null : round(rankIc, 4),
    se: round(se, 4),
    t: round(t, 2),
    significant,
    note: significant
      ? ic > 0
        ? "편향과 실현 방향에 유의한 양의 상관"
        : "유의한 음의 상관 — 부호가 반대로 작동하고 있다"
      : "노이즈와 구분되지 않음",
  };
}

// ── 2. 벤치마크 ─────────────────────────────────────────────────────

export type StrategyId = "system" | "momentum" | "contrarian" | "random" | "always-long";

/** 재현 가능한 의사난수 — 같은 기록이면 같은 무작위 예측이 나온다 */
function deterministicSign(seed: string): Direction {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 2 === 0 ? 1 : -1;
}

export function strategyDirection(strategy: StrategyId, sample: HorizonSample): Direction {
  switch (strategy) {
    case "system":
      return sample.direction;
    case "momentum":
      return sample.priorMovePct === null
        ? 0
        : ((Math.sign(sample.priorMovePct) || 0) as Direction);
    case "contrarian":
      return sample.priorMovePct === null
        ? 0
        : ((-Math.sign(sample.priorMovePct) || 0) as Direction);
    case "random":
      return deterministicSign(`${sample.asset}${sample.ts}`);
    case "always-long":
      return 1;
  }
}

export interface StrategyResult {
  id: StrategyId;
  /** 방향을 낸 횟수 */
  trades: number;
  hits: number;
  hitRate: number | null;
  /** 방향 × 변화율의 합(%) — 비용 차감 전 */
  grossPct: number;
  /** 비용 차감 후 */
  netPct: number;
  avgPct: number | null;
}

export function evaluateStrategy(
  samples: HorizonSample[],
  strategy: StrategyId,
  costPct = DEFAULT_COST_PCT,
): StrategyResult {
  let trades = 0;
  let hits = 0;
  let gross = 0;
  for (const sample of samples) {
    const direction = strategyDirection(strategy, sample);
    if (direction === 0) continue;
    trades += 1;
    if (Math.sign(direction) === sample.realized) hits += 1;
    gross += Math.sign(direction) * sample.movePct;
  }
  const net = gross - trades * costPct;
  return {
    id: strategy,
    trades,
    hits,
    hitRate: trades > 0 ? round(hits / trades, 3) : null,
    grossPct: round(gross, 3),
    netPct: round(net, 3),
    avgPct: trades > 0 ? round(net / trades, 4) : null,
  };
}

export function compareBenchmarks(
  samples: HorizonSample[],
  costPct = DEFAULT_COST_PCT,
): StrategyResult[] {
  const strategies: StrategyId[] = ["system", "momentum", "contrarian", "random", "always-long"];
  return strategies.map((strategy) => evaluateStrategy(samples, strategy, costPct));
}

// ── 3. 정책 시뮬레이션 ──────────────────────────────────────────────

export interface PolicyPoint {
  threshold: number;
  trades: number;
  hitRate: number | null;
  netPct: number;
  avgPct: number | null;
}

/**
 * 확신도 임계를 올려가며 "그 이상일 때만 방향대로 들어갔다면" 결과를 본다.
 * 게이트 25가 적정한지에 직접 답한다.
 */
export function policySweep(
  samples: HorizonSample[],
  thresholds = [0, 10, 20, 25, 30, 40, 50, 60],
  costPct = DEFAULT_COST_PCT,
): PolicyPoint[] {
  return thresholds.map((threshold) => {
    const chosen = samples.filter(
      (sample) => sample.direction !== 0 && sample.conviction >= threshold,
    );
    let hits = 0;
    let gross = 0;
    for (const sample of chosen) {
      if (Math.sign(sample.direction) === sample.realized) hits += 1;
      gross += Math.sign(sample.direction) * sample.movePct;
    }
    const net = gross - chosen.length * costPct;
    return {
      threshold,
      trades: chosen.length,
      hitRate: chosen.length ? round(hits / chosen.length, 3) : null,
      netPct: round(net, 3),
      avgPct: chosen.length ? round(net / chosen.length, 4) : null,
    };
  });
}

// ── 4. 손익 비대칭 ──────────────────────────────────────────────────

export interface PayoffResult {
  hits: number;
  misses: number;
  /** 맞았을 때 평균 이동폭(%) */
  avgWin: number | null;
  /** 틀렸을 때 평균 이동폭(%) */
  avgLoss: number | null;
  /** 승률 × 평균이익 − 패률 × 평균손실 */
  expectancy: number | null;
  note: string;
}

/** 적중률이 50% 아래여도 맞을 때 크게 움직이면 쓸 만하다. 그 반대도 성립한다. */
export function payoffAsymmetry(samples: HorizonSample[]): PayoffResult {
  const directional = samples.filter((sample) => sample.direction !== 0);
  const wins: number[] = [];
  const losses: number[] = [];
  for (const sample of directional) {
    const signed = Math.sign(sample.direction) * sample.movePct;
    if (signed > 0) wins.push(signed);
    else losses.push(-signed);
  }
  if (!directional.length) {
    return { hits: 0, misses: 0, avgWin: null, avgLoss: null, expectancy: null, note: "표본 없음" };
  }
  const avg = (list: number[]) =>
    list.length ? list.reduce((a, b) => a + b, 0) / list.length : null;
  const avgWin = avg(wins);
  const avgLoss = avg(losses);
  const winRate = wins.length / directional.length;
  const expectancy =
    avgWin !== null && avgLoss !== null ? winRate * avgWin - (1 - winRate) * avgLoss : null;
  return {
    hits: wins.length,
    misses: losses.length,
    avgWin: avgWin === null ? null : round(avgWin, 4),
    avgLoss: avgLoss === null ? null : round(avgLoss, 4),
    expectancy: expectancy === null ? null : round(expectancy, 4),
    note:
      expectancy === null
        ? "판정 불가"
        : expectancy > 0
          ? "기대값 양수 — 비용 전 기준"
          : "기대값 음수",
  };
}

// ── 5. 데이터 품질 ──────────────────────────────────────────────────

export interface QualityResult {
  /** 커버리지 구간별 적중률 — 근거를 많이 모은 날이 더 잘 맞는가 */
  byCoverage: Array<{ id: string; n: number; hitRate: number | null }>;
  /** 인접 기록 간격이 비정상적으로 벌어진 횟수 (실행 누락) */
  gaps: number;
  note: string;
}

export function dataQuality(
  samples: HorizonSample[],
  records: PredictionRecord[],
): QualityResult {
  const buckets = [
    { id: "낮음 (<0.5)", min: 0, max: 0.5 },
    { id: "보통 (0.5~0.7)", min: 0.5, max: 0.7 },
    { id: "높음 (≥0.7)", min: 0.7, max: Infinity },
  ];
  const byCoverage = buckets.map((bucket) => {
    const rows = samples.filter(
      (sample) =>
        sample.direction !== 0 && sample.coverage >= bucket.min && sample.coverage < bucket.max,
    );
    const hits = rows.filter((row) => Math.sign(row.direction) === row.realized).length;
    return { id: bucket.id, n: rows.length, hitRate: rows.length ? round(hits / rows.length, 3) : null };
  });

  // 스냅샷은 6~10시간 간격이다. 그보다 크게 벌어지면 실행이 누락된 것
  let gaps = 0;
  const byAsset = new Map<AssetId, number[]>();
  for (const record of records) {
    const list = byAsset.get(record.asset) ?? [];
    list.push(Date.parse(record.ts));
    byAsset.set(record.asset, list);
  }
  for (const times of byAsset.values()) {
    const sorted = [...times].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      if (sorted[i] - sorted[i - 1] > 14 * 3_600_000) gaps += 1;
    }
  }

  return {
    byCoverage,
    gaps,
    note: gaps > 0 ? `실행 누락 의심 ${gaps}회 — 예약 작업 확인 필요` : "실행 간격 정상",
  };
}

// ── 종합 ────────────────────────────────────────────────────────────

export interface HorizonEvaluation {
  hours: number;
  samples: number;
  ic: IcResult;
  benchmarks: StrategyResult[];
  policy: PolicyPoint[];
  payoff: PayoffResult;
}

export interface Evaluation {
  generatedAt: string;
  costPct: number;
  horizons: HorizonEvaluation[];
  quality: QualityResult;
  verdict: string;
}

/**
 * 8시간과 24시간 두 지평으로 동시에 평가한다.
 * "8시간은 매크로가 작동하기엔 짧다"는 가설을 데이터로 검증하기 위해서다.
 */
export function evaluate(
  records: PredictionRecord[],
  bands: Record<AssetId, number>,
  now: Date,
  options: { horizons?: number[]; costPct?: number } = {},
): Evaluation {
  const horizons = options.horizons ?? [8, 24];
  const costPct = options.costPct ?? DEFAULT_COST_PCT;

  const evaluations = horizons.map((hours) => {
    const samples = sampleAtHorizon(records, hours, bands);
    return {
      hours,
      samples: samples.length,
      ic: informationCoefficient(samples),
      benchmarks: compareBenchmarks(samples, costPct),
      policy: policySweep(samples, undefined, costPct),
      payoff: payoffAsymmetry(samples),
    };
  });

  const primary = evaluations[0];
  const system = primary?.benchmarks.find((b) => b.id === "system");
  const best = primary?.benchmarks
    .filter((b) => b.id !== "system" && b.trades > 0)
    .sort((a, b) => b.netPct - a.netPct)[0];

  let verdict = "표본 부족 — 판정 보류";
  if (primary && primary.samples >= 20 && system && system.trades > 0) {
    if (primary.ic.significant && (primary.ic.ic ?? 0) > 0) {
      verdict = "편향에 유의한 정보가 있다";
    } else if (best && system.netPct <= best.netPct) {
      verdict = `나이브 전략(${best.id})에 밀린다 — 방향 예측의 부가가치가 확인되지 않음`;
    } else {
      verdict = "노이즈와 구분되지 않음 — 표본을 더 모아야 한다";
    }
  }

  return {
    generatedAt: now.toISOString(),
    costPct,
    horizons: evaluations,
    quality: dataQuality(sampleAtHorizon(records, horizons[0], bands), records),
    verdict,
  };
}

// ── 리포트 렌더링 ───────────────────────────────────────────────────

const pct = (value: number | null, digits = 0) =>
  value === null ? "—" : `${(value * 100).toFixed(digits)}%`;
const num = (value: number | null, digits = 2) =>
  value === null ? "—" : value.toFixed(digits);

function table(header: string[], rows: string[][]): string {
  if (!rows.length) return "_해당 없음_\n";
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

const STRATEGY_LABEL: Record<StrategyId, string> = {
  system: "**시스템**",
  momentum: "전일 방향 지속",
  contrarian: "역방향",
  random: "무작위",
  "always-long": "항상 매수",
};

export function renderEvaluationMarkdown(evaluation: Evaluation): string {
  const lines: string[] = [
    "## 0. 판정",
    "",
    `**${evaluation.verdict}**`,
    "",
    `진입 비용 ${evaluation.costPct}%p 가정 · ${evaluation.quality.note}`,
    "",
  ];

  for (const horizon of evaluation.horizons) {
    lines.push(
      `## 1-${horizon.hours}h. 성과 (${horizon.hours}시간 지평 · 표본 ${horizon.samples}건)`,
      "",
      "### IC — 편향 점수와 실현 변화율의 상관",
      "",
      `IC ${num(horizon.ic.ic, 3)} · 랭크IC ${num(horizon.ic.rankIc, 3)} · ` +
        `t ${num(horizon.ic.t, 2)} · 표본 ${horizon.ic.n}건`,
      "",
      `→ **${horizon.ic.note}**`,
      "",
      "### 나이브 벤치마크 대비",
      "",
      table(
        ["전략", "진입", "적중률", "누적(%)", "회당(%)"],
        horizon.benchmarks.map((row) => [
          STRATEGY_LABEL[row.id],
          String(row.trades),
          pct(row.hitRate, 1),
          num(row.netPct, 2),
          num(row.avgPct, 3),
        ]),
      ),
      "",
      "### 확신도 임계별 정책 성과",
      "",
      table(
        ["임계", "진입", "적중률", "누적(%)", "회당(%)"],
        horizon.policy.map((row) => [
          String(row.threshold),
          String(row.trades),
          pct(row.hitRate, 1),
          num(row.netPct, 2),
          num(row.avgPct, 3),
        ]),
      ),
      "",
      "### 손익 비대칭",
      "",
      `적중 ${horizon.payoff.hits}건 평균 ${num(horizon.payoff.avgWin, 2)}% · ` +
        `실패 ${horizon.payoff.misses}건 평균 ${num(horizon.payoff.avgLoss, 2)}% · ` +
        `기대값 ${num(horizon.payoff.expectancy, 3)}%`,
      "",
      `→ **${horizon.payoff.note}**`,
      "",
    );
  }

  lines.push(
    "### 데이터 품질",
    "",
    table(
      ["커버리지", "진입", "적중률"],
      evaluation.quality.byCoverage.map((row) => [row.id, String(row.n), pct(row.hitRate, 1)]),
    ),
    "",
  );

  return lines.join("\n");
}
