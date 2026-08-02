import { clamp, round, weightedMean, weightedStdev } from "./indicators";
import type { AssetId, MacroFactorInput, MacroFactorResult, MacroLayer } from "./types";
import { MACRO_WEIGHTS } from "./weights";

const DEFAULT_CONFIDENCE = 0.7;

export function factorKeysFor(asset: AssetId): string[] {
  return Object.keys(MACRO_WEIGHTS[asset]);
}

/**
 * 매크로 레이어 계산. 차트 값을 일절 참조하지 않는다(레이어 잠금 원칙).
 *
 * score       = Σ(w·c·stance) / Σ(w·c)            → -2 ~ +2
 * coverage    = Σ(w·c)                            → 0 ~ 1 (가중치 표 합이 1이므로)
 * dispersion  = 가중표준편차 / 2                   → 0 ~ 1
 * confidence  = coverage × (1 − 0.6 × dispersion)
 */
export function computeMacro(asset: AssetId, factors: MacroFactorInput[]): MacroLayer {
  const table = MACRO_WEIGHTS[asset];
  const flags: string[] = [];
  const seen = new Set<string>();
  const results: MacroFactorResult[] = [];

  for (const factor of factors ?? []) {
    const spec = table[factor.key];
    if (!spec) {
      flags.push(`UNKNOWN_FACTOR:${factor.key}`);
      continue;
    }
    if (seen.has(factor.key)) {
      flags.push(`DUPLICATE_FACTOR:${factor.key}`);
      continue;
    }
    seen.add(factor.key);
    const stance = clamp(Number(factor.stance) || 0, -2, 2);
    const confidence = clamp(
      Number.isFinite(factor.confidence as number)
        ? (factor.confidence as number)
        : DEFAULT_CONFIDENCE,
      0,
      1,
    );
    results.push({
      ...factor,
      label: spec.label,
      weight: spec.weight,
      stance,
      confidence,
      contribution: round(spec.weight * confidence * stance, 4),
    });
  }

  const missing = Object.keys(table).filter((key) => !seen.has(key));
  if (missing.length) flags.push(`MISSING_FACTORS:${missing.join(",")}`);

  const pairs = results.map((result) => ({
    value: result.stance,
    weight: result.weight * result.confidence,
  }));
  const coverage = clamp(
    pairs.reduce((sum, pair) => sum + pair.weight, 0),
    0,
    1,
  );
  const score = pairs.length ? weightedMean(pairs) : 0;
  const dispersion = pairs.length ? clamp(weightedStdev(pairs, score) / 2, 0, 1) : 0;
  const confidence = clamp(coverage * (1 - 0.6 * dispersion), 0, 1);

  if (coverage < 0.5) flags.push("MACRO_COVERAGE_LOW");
  if (dispersion > 0.5) flags.push("MACRO_HIGH_DISPERSION");
  if (!results.length) flags.push("MACRO_EMPTY");

  return {
    score: round(score, 3),
    confidence: round(confidence, 3),
    coverage: round(coverage, 3),
    dispersion: round(dispersion, 3),
    factors: results.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution)),
    flags,
  };
}
