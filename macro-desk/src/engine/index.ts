import { computeEvents } from "./events";
import { fuse } from "./fusion";
import { computeMacro } from "./macro";
import { computeTechnical } from "./technical";
import type {
  AnalysisMode,
  AssetId,
  FusionResult,
  Snapshot,
  SnapshotAsset,
  SnapshotDriver,
  SnapshotInput,
} from "./types";
import { ASSET_IDS, RULESET_VERSION } from "./types";
import { MACRO_WEIGHTS } from "./weights";

export * from "./types";
export { computeMacro } from "./macro";
export { computeTechnical, momentumScore, structureScore, trendScore } from "./technical";
export { computeEvents } from "./events";
export { fuse, regimeLabel } from "./fusion";
export { MACRO_WEIGHTS, TF_WEIGHTS, EVENT_TIERS } from "./weights";
export { sessionBoundaries, nextSessionBoundary } from "./sessions";

const DEFAULT_SCHEDULE = "08:00 · 16:00 · 22:00 KST";
/** 번들 없이 폰만으로 쓰는 것이 기본 운영 형태다. */
const DEFAULT_MODE: AnalysisMode = "macro-only";

function fmtKST(ts: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function readOf(value: number): SnapshotDriver["read"] {
  if (value > 0.25) return "상승";
  if (value < -0.25) return "하락";
  return "중립";
}

/** 구형 화면(v1)이 그대로 읽는 drivers 배열: 매크로 상위 3 + 기술 요약 1 */
function toDrivers(fusion: FusionResult): SnapshotDriver[] {
  const macroDrivers: SnapshotDriver[] = fusion.macro.factors.slice(0, 3).map((factor) => ({
    name: factor.label,
    read: readOf(factor.stance),
    note: factor.note,
  }));
  const timeframes = fusion.technical.timeframes
    .map((read) => `${read.tf} ${read.score > 0 ? "+" : ""}${read.score.toFixed(1)}`)
    .join(" · ");
  if (timeframes) {
    macroDrivers.push({
      name: "차트 구조",
      read: readOf(fusion.technical.score),
      note: timeframes,
    });
  }
  return macroDrivers;
}

function headlineEvent(fusion: FusionResult): string {
  const next = fusion.events.headline;
  if (!next) return "없음";
  return `${next.label} ${fmtKST(Date.parse(next.time))} KST`;
}

/** 입력 스키마 사전 검증. 오류 문자열 배열을 반환하며 비어 있으면 통과. */
export function validateInput(input: SnapshotInput): string[] {
  const errors: string[] = [];
  if (!input || typeof input !== "object") return ["입력이 객체가 아닙니다"];
  if (!Array.isArray(input.events)) errors.push("events 배열이 필요합니다");
  if (!input.assets || typeof input.assets !== "object") {
    errors.push("assets 객체가 필요합니다");
    return errors;
  }
  for (const [assetId, asset] of Object.entries(input.assets)) {
    if (!ASSET_IDS.includes(assetId as AssetId)) {
      errors.push(`알 수 없는 자산: ${assetId}`);
      continue;
    }
    if (!asset) continue;
    const table = MACRO_WEIGHTS[assetId as AssetId];
    for (const factor of asset.factors ?? []) {
      const spec = table[factor.key];
      if (!spec) {
        errors.push(
          `${assetId}: 알 수 없는 팩터 키 "${factor.key}" (가능: ${Object.keys(table).join(", ")})`,
        );
        continue;
      }
      if (spec.kind === "numeric") {
        if (!Number.isFinite(factor.value as number)) {
          if (Number.isFinite(factor.stance as number)) {
            errors.push(
              `${assetId}.${factor.key}: 수치형 팩터입니다. stance 대신 value를 넣으세요 (${spec.metric})`,
            );
          } else {
            errors.push(`${assetId}.${factor.key}: value가 필요합니다 (${spec.metric})`);
          }
        }
      } else if (!Number.isFinite(factor.stance as number)) {
        errors.push(`${assetId}.${factor.key}: 서수형 팩터입니다. stance(-2~2)가 필요합니다`);
      } else if (Math.abs(factor.stance as number) > 2) {
        errors.push(`${assetId}.${factor.key}: stance는 -2~2 범위여야 합니다`);
      }
      if (factor.asof && !Number.isFinite(Date.parse(factor.asof))) {
        errors.push(`${assetId}.${factor.key}: asof 파싱 불가 (${factor.asof})`);
      }
      if (!factor.note) errors.push(`${assetId}.${factor.key}: note가 비어 있습니다`);
    }
    if (!asset.factors?.length) errors.push(`${assetId}: factors가 비어 있습니다`);
    if (modeOf(input, assetId as AssetId) === "fusion") {
      if (!Object.keys(asset.candles ?? {}).length) {
        errors.push(
          `${assetId}: fusion 모드인데 candles가 비어 있습니다 (번들 없이 쓰려면 mode: "macro-only")`,
        );
      }
    } else {
      if (!Number.isFinite(asset.levels?.last as number)) {
        errors.push(`${assetId}: levels.last(현재가)가 필요합니다`);
      }
      if (!Number.isFinite(asset.levels?.prevClose as number)) {
        errors.push(`${assetId}: levels.prevClose(직전 세션 종가)가 필요합니다`);
      }
    }
  }
  for (const event of input.events ?? []) {
    if (!Number.isFinite(Date.parse(event.time))) {
      errors.push(`이벤트 "${event.label}": time 파싱 불가 (${event.time})`);
    }
    if (![1, 2, 3].includes(event.tier)) {
      errors.push(`이벤트 "${event.label}": tier는 1·2·3 중 하나여야 합니다`);
    }
  }
  return errors;
}

/** 이 자산에 적용되는 모드. 자산 설정이 스냅샷 기본값을 덮어쓴다. */
export function modeOf(input: SnapshotInput, asset: AssetId): AnalysisMode {
  return input.assets[asset]?.mode ?? input.mode ?? DEFAULT_MODE;
}

/** 자산 1건 분석 */
export function analyzeAsset(
  asset: AssetId,
  input: SnapshotInput,
  now: Date = new Date(),
): FusionResult {
  const assetInput = input.assets[asset];
  const mode = modeOf(input, asset);
  const macro = computeMacro(asset, assetInput?.factors ?? [], now);
  const technical = computeTechnical(mode === "macro-only" ? {} : (assetInput?.candles ?? {}));
  if (mode === "macro-only") {
    // 차트를 아예 쓰지 않는 모드다. 누락은 오류가 아니므로 TF 플래그를 남기지 않는다.
    technical.flags = [];
  }
  const events = computeEvents(asset, input.events ?? [], now);
  return fuse(asset, macro, technical, events, now, { mode, levels: assetInput?.levels });
}

/** 전체 스냅샷 생성 — public/macro.json 으로 그대로 직렬화된다. */
export function runSnapshot(input: SnapshotInput, now?: Date): Snapshot {
  const generatedAt = input.generatedAt ? new Date(input.generatedAt) : (now ?? new Date());
  const assets: Snapshot["assets"] = {};

  for (const asset of ASSET_IDS) {
    if (!input.assets[asset]) continue;
    const fusion = analyzeAsset(asset, input, generatedAt);
    const snapshotAsset: SnapshotAsset = {
      direction: fusion.direction,
      confidence: fusion.confidence,
      rationale: fusion.rationale,
      drivers: toDrivers(fusion),
      event: headlineEvent(fusion),
      asof: `${fmtKST(generatedAt.getTime())} KST`,
      setAt: generatedAt.toISOString(),
      source: "scheduled",
      fusion,
    };
    assets[asset] = snapshotAsset;
  }

  return {
    version: 2,
    ruleset: RULESET_VERSION,
    mode: input.mode ?? DEFAULT_MODE,
    generatedAt: generatedAt.toISOString(),
    schedule: input.schedule || DEFAULT_SCHEDULE,
    ...(input.note ? { note: input.note } : {}),
    assets,
  };
}
