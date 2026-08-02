import { clamp, round, weightedMean, weightedStdev } from "./indicators";
import type {
  AssetId,
  BlockResult,
  MacroFactorInput,
  MacroFactorResult,
  MacroLayer,
  Stance,
} from "./types";
import {
  BLOCK_CAP,
  DECAY_HALF_LIFE_HOURS,
  DECAY_HALF_LIFE_PERSISTENT_HOURS,
  DUPLICATE_FACT_WEIGHT,
  FACTOR_MAX_AGE_HOURS,
  MACRO_WEIGHTS,
  stanceFromValue,
} from "./weights";

const DEFAULT_CONFIDENCE = 0.7;
/** 수치형 팩터에 value 없이 stance만 준 경우의 신뢰도 상한 */
const UNVERIFIED_CONFIDENCE_CAP = 0.5;
const HOUR = 3_600_000;

export function factorKeysFor(asset: AssetId): string[] {
  return Object.keys(MACRO_WEIGHTS[asset]);
}

const asStance = (value: number): Stance =>
  clamp(Math.round(value), -2, 2) as Stance;

/** 1단계 — 입력을 루브릭에 맞춰 해석하고 stance를 확정한다. */
function resolveFactors(asset: AssetId, factors: MacroFactorInput[], now: Date) {
  const table = MACRO_WEIGHTS[asset];
  const layerFlags: string[] = [];
  const seen = new Set<string>();
  const resolved: MacroFactorResult[] = [];

  for (const factor of factors ?? []) {
    const spec = table[factor.key];
    if (!spec) {
      layerFlags.push(`UNKNOWN_FACTOR:${factor.key}`);
      continue;
    }
    if (seen.has(factor.key)) {
      layerFlags.push(`DUPLICATE_FACTOR:${factor.key}`);
      continue;
    }
    seen.add(factor.key);

    const flags: string[] = [];
    let confidence = clamp(
      Number.isFinite(factor.confidence as number)
        ? (factor.confidence as number)
        : DEFAULT_CONFIDENCE,
      0,
      1,
    );

    // stance 확정: 수치형은 밴드에서 파생, 서수형은 입력값
    let stance: Stance;
    let value: number | undefined;
    if (spec.kind === "numeric") {
      if (Number.isFinite(factor.value as number)) {
        value = factor.value as number;
        stance = stanceFromValue(spec.bands!, value);
      } else if (Number.isFinite(factor.stance as number)) {
        stance = asStance(factor.stance as number);
        confidence = Math.min(confidence, UNVERIFIED_CONFIDENCE_CAP);
        flags.push("STANCE_UNVERIFIED");
        layerFlags.push(`STANCE_UNVERIFIED:${factor.key}`);
      } else {
        layerFlags.push(`MISSING_VALUE:${factor.key}`);
        continue;
      }
    } else {
      if (!Number.isFinite(factor.stance as number)) {
        layerFlags.push(`MISSING_STANCE:${factor.key}`);
        continue;
      }
      stance = asStance(factor.stance as number);
    }

    // 2단계 — 시간 감쇠
    const asofMs = factor.asof ? Date.parse(factor.asof) : Number.NaN;
    const ageHours = Number.isFinite(asofMs)
      ? Math.max(0, (now.getTime() - asofMs) / HOUR)
      : 0;
    const halfLife = spec.persistent
      ? DECAY_HALF_LIFE_PERSISTENT_HOURS
      : DECAY_HALF_LIFE_HOURS;
    if (!spec.persistent && ageHours > FACTOR_MAX_AGE_HOURS) {
      layerFlags.push(`FACTOR_STALE:${factor.key}`);
      continue;
    }
    const effectiveConfidence = confidence * 0.5 ** (ageHours / halfLife);
    if (ageHours >= halfLife) flags.push("DECAYED");

    resolved.push({
      key: factor.key,
      label: spec.label,
      block: spec.block,
      kind: spec.kind,
      stance,
      ...(value === undefined ? {} : { value }),
      ...(factor.fact ? { fact: factor.fact } : {}),
      note: factor.note,
      ...(factor.source ? { source: factor.source } : {}),
      ...(factor.asof ? { asof: factor.asof } : {}),
      weight: spec.weight,
      confidence,
      effectiveConfidence: round(effectiveConfidence, 4),
      effectiveWeight: spec.weight * effectiveConfidence,
      contribution: 0,
      flags,
    });
  }

  const missing = Object.keys(table).filter((key) => !seen.has(key));
  if (missing.length) layerFlags.push(`MISSING_FACTORS:${missing.join(",")}`);
  return { resolved, layerFlags };
}

/**
 * 3단계-B — 같은 블록에서 같은 사실을 인용한 팩터는 한 번만 온전히 센다.
 * 가중치가 가장 큰 팩터만 100%, 나머지는 40%로 줄인다.
 */
function dampenDuplicateFacts(factors: MacroFactorResult[], layerFlags: string[]) {
  const leader = new Map<string, string>();
  for (const factor of [...factors].sort((a, b) => b.effectiveWeight - a.effectiveWeight)) {
    if (!factor.fact) continue;
    const id = `${factor.block}:${factor.fact}`;
    if (!leader.has(id)) {
      leader.set(id, factor.key);
      continue;
    }
    factor.effectiveWeight *= DUPLICATE_FACT_WEIGHT;
    factor.flags.push(`DUPLICATE_FACT:${factor.fact}`);
    layerFlags.push(`DUPLICATE_FACT:${factor.key}<-${leader.get(id)}`);
  }
}

/**
 * 3단계-A — 한 블록이 전체 가중치의 BLOCK_CAP을 넘으면 그만큼 줄이고
 * 나머지 블록을 비례 확대한다. 총합은 보존된다(커버리지 불변).
 */
function applyBlockCap(factors: MacroFactorResult[], layerFlags: string[]) {
  const total = factors.reduce((sum, factor) => sum + factor.effectiveWeight, 0);
  if (total <= 0) return;
  const byBlock = new Map<string, number>();
  for (const factor of factors) {
    byBlock.set(factor.block, (byBlock.get(factor.block) ?? 0) + factor.effectiveWeight);
  }
  const over = [...byBlock.entries()]
    .filter(([, weight]) => weight / total > BLOCK_CAP)
    .sort((a, b) => b[1] - a[1])[0];
  if (!over) return;

  const [blockId, blockWeight] = over;
  const rest = total - blockWeight;
  if (rest <= 0) return;
  const scaleIn = (BLOCK_CAP * total) / blockWeight;
  const scaleOut = ((1 - BLOCK_CAP) * total) / rest;
  for (const factor of factors) {
    factor.effectiveWeight *= factor.block === blockId ? scaleIn : scaleOut;
  }
  layerFlags.push(`BLOCK_CAPPED:${blockId}`);
}

function summarizeBlocks(factors: MacroFactorResult[]): BlockResult[] {
  const groups = new Map<string, MacroFactorResult[]>();
  for (const factor of factors) {
    const list = groups.get(factor.block) ?? [];
    list.push(factor);
    groups.set(factor.block, list);
  }
  return [...groups.entries()]
    .map(([id, list]) => ({
      id,
      score: round(
        weightedMean(list.map((f) => ({ value: f.stance, weight: f.effectiveWeight }))),
        3,
      ),
      weight: round(
        list.reduce((sum, f) => sum + f.effectiveWeight, 0),
        4,
      ),
      factors: list.map((f) => f.key),
    }))
    .sort((a, b) => b.weight - a.weight);
}

/**
 * 매크로 레이어 계산 (ruleset fusion-v1.1). 차트 값을 일절 참조하지 않는다.
 *
 * 1) 루브릭으로 stance 확정 (수치형은 밴드에서 파생)
 * 2) asof 기준 시간 감쇠
 * 3) 같은 사실 중복 감쇠 → 블록 상한 → 블록 단위 분산
 *
 * score       = Σ(w_eff·stance) / Σ(w_eff)         → -2 ~ +2
 * coverage    = Σ(w_eff)                           → 0 ~ 1
 * dispersion  = 블록 점수 간 가중표준편차 / 2       → 0 ~ 1
 * confidence  = coverage × (1 − 0.6 × dispersion)
 */
export function computeMacro(
  asset: AssetId,
  factors: MacroFactorInput[],
  now: Date = new Date(),
): MacroLayer {
  const { resolved, layerFlags } = resolveFactors(asset, factors, now);
  const flags = layerFlags;

  dampenDuplicateFacts(resolved, flags);
  applyBlockCap(resolved, flags);

  for (const factor of resolved) {
    factor.effectiveWeight = round(factor.effectiveWeight, 4);
    factor.contribution = round(factor.effectiveWeight * factor.stance, 4);
  }

  const blocks = summarizeBlocks(resolved);
  const coverage = clamp(
    resolved.reduce((sum, factor) => sum + factor.effectiveWeight, 0),
    0,
    1,
  );
  const score = resolved.length
    ? weightedMean(resolved.map((f) => ({ value: f.stance, weight: f.effectiveWeight })))
    : 0;
  const dispersion = blocks.length
    ? clamp(
        weightedStdev(
          blocks.map((block) => ({ value: block.score, weight: block.weight })),
          score,
        ) / 2,
        0,
        1,
      )
    : 0;
  const confidence = clamp(coverage * (1 - 0.6 * dispersion), 0, 1);

  if (coverage < 0.5) flags.push("MACRO_COVERAGE_LOW");
  if (dispersion > 0.5) flags.push("MACRO_HIGH_DISPERSION");
  if (!resolved.length) flags.push("MACRO_EMPTY");

  return {
    score: round(score, 3),
    confidence: round(confidence, 3),
    coverage: round(coverage, 3),
    dispersion: round(dispersion, 3),
    factors: resolved.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    blocks,
    flags,
  };
}
