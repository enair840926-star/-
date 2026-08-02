/**
 * 주간 보정 계산.
 *
 * 여기 있는 것은 전부 **결정적 계산**이다. 같은 기록이면 같은 제안이 나온다.
 * LLM 판단이 끼어들지 않는다 — 예약 루틴은 이 결과를 실행·전달만 한다.
 *
 * 등급
 *  A 중립밴드   : 자동 적용. 실현 변화율 분포는 우리 예측과 무관하므로 자기참조가 아니다.
 *  B 확신도·게이트·위치배수 : 제안만.
 *  C 팩터 가중치·블록 상한  : 제안만. 사람이 승인해야 한다.
 */
import { clamp, round } from "./indicators";
import { CONVICTION_BUCKETS } from "./scoreboard";
import type { AssetId, PredictionRecord } from "./types";
import { ASSET_IDS } from "./types";

// ── 상수 ────────────────────────────────────────────────────────────
/** 중립밴드로 쓸 |변화율| 분위수 */
export const NEUTRAL_BAND_PERCENTILE = 30;
export const BAND_MIN_SAMPLES = 20;
/** 1회 보정에서 허용하는 최대 변화폭 */
export const BAND_MAX_CHANGE = 0.3;
export const BAND_FLOOR = 0.05;
export const BAND_CEIL = 3;

export const BUCKET_MIN_SAMPLES = 10;
export const GATE_MIN_SAMPLES = 20;
export const GATE_HIGH_RATIO = 0.65;
export const GATE_LOW_RATIO = 0.35;
export const POSITION_MIN_SAMPLES = 10;
export const FACTOR_MIN_SAMPLES = 30;

// ── 통계 ────────────────────────────────────────────────────────────

/** 선형 보간 분위수. p는 0~100. */
export function percentile(values: number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const index = (clamp(p, 0, 100) / 100) * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/**
 * Wilson 점수구간 하한(95%).
 * 표본이 작을 때 점추정만 보면 노이즈를 실력으로 착각한다.
 */
export function wilsonLowerBound(hits: number, n: number, z = 1.96): number | null {
  if (n <= 0) return null;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const center = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return clamp((center - margin) / denom, 0, 1);
}

// ── 출력 타입 ───────────────────────────────────────────────────────

export interface BandCalibration {
  asset: AssetId;
  n: number;
  current: number;
  /** 분위수 원값 */
  raw: number | null;
  /** 한도·범위 적용 후 실제 제안값 */
  proposed: number | null;
  applied: boolean;
  note: string;
}

export interface BucketStat {
  id: string;
  n: number;
  hit: number;
  rate: number | null;
  wilson: number | null;
}

export interface FactorStat extends BucketStat {
  asset: AssetId;
  key: string;
  verdict: "하향 검토" | "상향 검토" | "유지" | "표본 부족";
}

export interface CalibrationReport {
  generatedAt: string;
  ruleset: string;
  totals: { records: number; scored: number; directional: number };
  bands: BandCalibration[];
  conviction: { buckets: BucketStat[]; monotonic: boolean | null; note: string };
  gate: {
    neutralN: number;
    neutralMoved: number;
    ratio: number | null;
    suggestion: string;
  };
  position: { buckets: BucketStat[]; note: string };
  factors: FactorStat[];
  blockCap: { capped: BucketStat; uncapped: BucketStat; note: string };
  warnings: string[];
}

// ── 집계 ────────────────────────────────────────────────────────────

const isScored = (record: PredictionRecord) =>
  record.outcome !== null && !record.outcome.skipped;

const stat = (id: string, hit: number, n: number): BucketStat => ({
  id,
  n,
  hit,
  rate: n > 0 ? round(hit / n, 3) : null,
  wilson: n > 0 ? round(wilsonLowerBound(hit, n) ?? 0, 3) : null,
});

/**
 * A등급 — 중립밴드.
 * 실현 |변화율| 분포의 p30을 쓴다. 예측 방향과 무관하므로 ruleset 버전도 가리지 않는다.
 */
export function calibrateBands(
  records: PredictionRecord[],
  current: Record<AssetId, number>,
): BandCalibration[] {
  return ASSET_IDS.map((asset) => {
    const moves = records
      .filter((record) => record.asset === asset && isScored(record))
      .map((record) => Math.abs(record.outcome!.movePct));
    const now = current[asset];

    if (moves.length < BAND_MIN_SAMPLES) {
      return {
        asset,
        n: moves.length,
        current: now,
        raw: null,
        proposed: null,
        applied: false,
        note: `표본 부족 (${moves.length}/${BAND_MIN_SAMPLES})`,
      };
    }

    const raw = percentile(moves, NEUTRAL_BAND_PERCENTILE)!;
    const limited = clamp(raw, now * (1 - BAND_MAX_CHANGE), now * (1 + BAND_MAX_CHANGE));
    const proposed = round(clamp(limited, BAND_FLOOR, BAND_CEIL), 2);

    const notes: string[] = [];
    if (Math.abs(raw - limited) > 1e-9) {
      notes.push(`변화 한도 ±${BAND_MAX_CHANGE * 100}% 적용 (원값 ${round(raw, 2)}%)`);
    }
    if (limited < BAND_FLOOR || limited > BAND_CEIL) notes.push("절대 범위로 클램프");
    if (proposed === now) notes.push("변화 없음");

    return {
      asset,
      n: moves.length,
      current: now,
      raw: round(raw, 3),
      proposed,
      applied: proposed !== now,
      note: notes.join(" · ") || "적용",
    };
  });
}

/** B등급 — 확신도 구간별 적중률과 단조성 */
export function analyzeConviction(records: PredictionRecord[]): CalibrationReport["conviction"] {
  const buckets = CONVICTION_BUCKETS.map((bucket) => {
    const rows = records.filter(
      (record) =>
        isScored(record) &&
        record.outcome!.hit !== null &&
        record.conviction >= bucket.min &&
        record.conviction <= bucket.max,
    );
    return stat(bucket.id, rows.filter((r) => r.outcome!.hit).length, rows.length);
  });

  const usable = buckets.filter((bucket) => bucket.n >= BUCKET_MIN_SAMPLES);
  if (usable.length < 2) {
    return { buckets, monotonic: null, note: "판정 불가 — 표본 10건 이상인 구간이 2개 미만" };
  }
  const monotonic = usable.every(
    (bucket, index) => index === 0 || (bucket.rate ?? 0) >= (usable[index - 1].rate ?? 0),
  );
  return {
    buckets,
    monotonic,
    note: monotonic
      ? "정상 — 확신도가 높을수록 적중률이 높다"
      : "역전 — 확신도 공식이 실제 성과를 반영하지 못하고 있다",
  };
}

/** B등급 — 방향 게이트. 중립 예측 중 실제로 움직인 비율. */
export function analyzeGate(records: PredictionRecord[]): CalibrationReport["gate"] {
  const neutrals = records.filter(
    (record) => isScored(record) && record.outcome!.hit === null && record.direction === 0,
  );
  const moved = neutrals.filter((record) => record.outcome!.realized !== 0).length;
  const ratio = neutrals.length ? moved / neutrals.length : null;

  if (neutrals.length < GATE_MIN_SAMPLES) {
    return {
      neutralN: neutrals.length,
      neutralMoved: moved,
      ratio: ratio === null ? null : round(ratio, 3),
      suggestion: `표본 부족 (${neutrals.length}/${GATE_MIN_SAMPLES})`,
    };
  }
  const suggestion =
    ratio! >= GATE_HIGH_RATIO
      ? "게이트 하향 검토 — 중립으로 넘긴 세션 대부분이 실제로 움직였다"
      : ratio! <= GATE_LOW_RATIO
        ? "게이트 상향 검토 — 중립 판정이 대체로 맞았다"
        : "유지";
  return {
    neutralN: neutrals.length,
    neutralMoved: moved,
    ratio: round(ratio!, 3),
    suggestion,
  };
}

/** B등급 — 위치 배수가 실제로 적중률을 가르는지 */
export function analyzePosition(records: PredictionRecord[]): CalibrationReport["position"] {
  const relations = ["확인", "중립", "반증"] as const;
  const buckets = relations.map((relation) => {
    const rows = records.filter(
      (record) =>
        isScored(record) && record.outcome!.hit !== null && record.positionRelation === relation,
    );
    return stat(relation, rows.filter((r) => r.outcome!.hit).length, rows.length);
  });

  const usable = buckets.filter((bucket) => bucket.n >= POSITION_MIN_SAMPLES);
  if (usable.length < 2) return { buckets, note: "판정 불가 — 표본 부족" };

  const confirm = buckets.find((b) => b.id === "확인");
  const deny = buckets.find((b) => b.id === "반증");
  if (confirm && deny && confirm.n >= POSITION_MIN_SAMPLES && deny.n >= POSITION_MIN_SAMPLES) {
    return {
      buckets,
      note:
        (confirm.rate ?? 0) > (deny.rate ?? 0)
          ? "정상 — 가격이 확인해 준 예측이 더 잘 맞았다"
          : "역전 — 위치 배수를 1.0으로 되돌리는 것을 검토",
    };
  }
  return { buckets, note: "부분 판정 — 확인·반증 양쪽 표본이 필요" };
}

/** C등급 — 팩터별 기여 부호가 실현 방향과 맞았는지 */
export function analyzeFactors(records: PredictionRecord[]): FactorStat[] {
  const tally = new Map<string, { asset: AssetId; key: string; hit: number; n: number }>();

  for (const record of records) {
    if (!isScored(record)) continue;
    const realized = record.outcome!.realized;
    if (realized === 0) continue; // 방향이 없던 세션은 팩터 판정 불가
    for (const factor of record.factors ?? []) {
      if (factor.stance === 0 || factor.weight <= 0) continue;
      const id = `${record.asset}:${factor.key}`;
      const entry = tally.get(id) ?? { asset: record.asset, key: factor.key, hit: 0, n: 0 };
      entry.n += 1;
      if (Math.sign(factor.stance) === Math.sign(realized)) entry.hit += 1;
      tally.set(id, entry);
    }
  }

  return [...tally.values()]
    .map((entry) => {
      const base = stat(`${entry.asset}:${entry.key}`, entry.hit, entry.n);
      let verdict: FactorStat["verdict"] = "표본 부족";
      if (entry.n >= FACTOR_MIN_SAMPLES) {
        // Wilson 하한이 50%를 넘으면 유의하게 좋고, 상한이 50% 아래면 유의하게 나쁘다
        const upper = 1 - (wilsonLowerBound(entry.n - entry.hit, entry.n) ?? 0);
        verdict =
          (base.wilson ?? 0) > 0.5 ? "상향 검토" : upper < 0.5 ? "하향 검토" : "유지";
      }
      return { ...base, asset: entry.asset, key: entry.key, verdict };
    })
    .sort((a, b) => (a.rate ?? 1) - (b.rate ?? 1));
}

/** C등급 — 블록 상한이 걸린 예측이 실제로 더 나았는지 */
export function analyzeBlockCap(records: PredictionRecord[]): CalibrationReport["blockCap"] {
  const pick = (capped: boolean) => {
    const rows = records.filter(
      (record) =>
        isScored(record) && record.outcome!.hit !== null && record.blockCapped === capped,
    );
    return stat(capped ? "상한 적용" : "상한 없음", rows.filter((r) => r.outcome!.hit).length, rows.length);
  };
  const capped = pick(true);
  const uncapped = pick(false);
  const note =
    capped.n < BUCKET_MIN_SAMPLES || uncapped.n < BUCKET_MIN_SAMPLES
      ? "판정 불가 — 양쪽 표본 10건 이상 필요"
      : (capped.rate ?? 0) >= (uncapped.rate ?? 0)
        ? "상한이 걸린 예측이 더 잘 맞았다 — 현재 0.6 유지 또는 강화 검토"
        : "상한이 걸린 예측이 더 못 맞았다 — 상한 완화 검토";
  return { capped, uncapped, note };
}

/**
 * 전체 리포트.
 *
 * `ruleset`이 주어지면 B·C 등급은 그 버전 기록만 쓴다(파라미터가 바뀌면 모집단이 달라지므로).
 * A등급(중립밴드)은 시장 데이터라 버전을 가리지 않는다.
 */
export function buildCalibrationReport(
  records: PredictionRecord[],
  current: Record<AssetId, number>,
  now: Date,
  ruleset: string | null,
): CalibrationReport {
  const sameVersion = ruleset
    ? records.filter((record) => record.ruleset === ruleset)
    : records;
  const scored = sameVersion.filter(isScored);
  const directional = scored.filter((record) => record.outcome!.hit !== null);

  const warnings: string[] = [];
  if (!records.length) warnings.push("기록이 비어 있다");
  if (ruleset && sameVersion.length < records.length) {
    warnings.push(
      `ruleset ${ruleset} 기록만 집계 (${sameVersion.length}/${records.length}) — 이전 버전은 모집단이 다르다`,
    );
  }

  const conviction = analyzeConviction(sameVersion);
  if (conviction.monotonic === false) warnings.push("확신도 구간별 적중률 역전");

  return {
    generatedAt: now.toISOString(),
    ruleset: ruleset ?? "(전체)",
    totals: {
      records: records.length,
      scored: scored.length,
      directional: directional.length,
    },
    // 중립밴드는 버전 무관하게 전체 기록을 쓴다
    bands: calibrateBands(records, current),
    conviction,
    gate: analyzeGate(sameVersion),
    position: analyzePosition(sameVersion),
    factors: analyzeFactors(sameVersion),
    blockCap: analyzeBlockCap(sameVersion),
    warnings,
  };
}

// ── 리포트 렌더링 ───────────────────────────────────────────────────

const pct = (value: number | null) => (value === null ? "—" : `${Math.round(value * 100)}%`);
const band = (value: number | null) => (value === null ? "—" : `${value}%`);

function table(header: string[], rows: string[][]): string {
  if (!rows.length) return "_해당 없음_\n";
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

/** 주간 리포트 마크다운. 사람이 읽고 승인 여부를 정하는 문서다. */
export function renderCalibrationMarkdown(report: CalibrationReport): string {
  const date = report.generatedAt.slice(0, 10);
  const lines: string[] = [
    `# 보정 리포트 ${date}`,
    "",
    `기록 ${report.totals.records}건 · 채점 완료 ${report.totals.scored}건 · ` +
      `방향 예측 ${report.totals.directional}건 · ruleset ${report.ruleset}`,
    "",
  ];

  if (report.warnings.length) {
    lines.push("> **주의**", ...report.warnings.map((w) => `> - ${w}`), "");
  }

  lines.push(
    "## A. 중립밴드 — 자동 적용",
    "",
    table(
      ["자산", "표본", "이전", `p${NEUTRAL_BAND_PERCENTILE}`, "적용", "비고"],
      report.bands.map((row) => [
        row.asset,
        String(row.n),
        band(row.current),
        band(row.raw),
        row.applied ? `**${band(row.proposed)}**` : "유지",
        row.note,
      ]),
    ),
    "",
    "## B. 확신도 · 게이트 · 위치 배수 — 제안",
    "",
    "### 확신도 구간별 적중률",
    "",
    table(
      ["구간", "표본", "적중", "적중률", "Wilson 하한"],
      report.conviction.buckets.map((b) => [
        b.id,
        String(b.n),
        String(b.hit),
        pct(b.rate),
        pct(b.wilson),
      ]),
    ),
    "",
    `단조성: **${report.conviction.note}**`,
    "",
    "### 방향 게이트 (현재 25)",
    "",
    `중립 예측 ${report.gate.neutralN}건 중 ${report.gate.neutralMoved}건이 실제로 움직임` +
      (report.gate.ratio === null ? "" : ` (${pct(report.gate.ratio)})`),
    "",
    `→ **${report.gate.suggestion}**`,
    "",
    "### 위치 배수 (확인 ×1.15 / 반증 ×0.7)",
    "",
    table(
      ["관계", "표본", "적중", "적중률"],
      report.position.buckets.map((b) => [b.id, String(b.n), String(b.hit), pct(b.rate)]),
    ),
    "",
    `→ **${report.position.note}**`,
    "",
    "## C. 팩터 가중치 · 블록 상한 — 승인 필요",
    "",
    table(
      ["팩터", "표본", "적중률", "Wilson 하한", "판정"],
      report.factors.map((f) => [
        `${f.asset} · ${f.key}`,
        String(f.n),
        pct(f.rate),
        pct(f.wilson),
        f.verdict,
      ]),
    ),
    "",
    "### 블록 상한 (현재 0.6)",
    "",
    table(
      ["구분", "표본", "적중", "적중률"],
      [report.blockCap.capped, report.blockCap.uncapped].map((b) => [
        b.id,
        String(b.n),
        String(b.hit),
        pct(b.rate),
      ]),
    ),
    "",
    `→ **${report.blockCap.note}**`,
    "",
    "---",
    "",
    "A등급은 이미 적용됐다. B·C등급은 제안일 뿐이며 사람이 승인해야 반영된다.",
    "가중치는 합이 1.0이어야 하므로 한 팩터만 바꿀 수 없다 — 재배분안으로 검토한다.",
    "",
  );

  return lines.join("\n");
}
