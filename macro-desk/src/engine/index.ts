import { computeEvents } from "./events";
import { fuse } from "./fusion";
import { computeMacro } from "./macro";
import { computeTechnical } from "./technical";
import type {
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
    const valid = Object.keys(MACRO_WEIGHTS[assetId as AssetId]);
    for (const factor of asset.factors ?? []) {
      if (!valid.includes(factor.key)) {
        errors.push(`${assetId}: 알 수 없는 팩터 키 "${factor.key}" (가능: ${valid.join(", ")})`);
      }
      if (!Number.isFinite(factor.stance)) {
        errors.push(`${assetId}.${factor.key}: stance가 숫자가 아닙니다`);
      }
      if (!factor.note) errors.push(`${assetId}.${factor.key}: note가 비어 있습니다`);
    }
    if (!asset.technicalPending && (!asset.candles || !Object.keys(asset.candles).length)) {
      errors.push(
        `${assetId}: candles가 비어 있습니다 (매크로만 먼저 올리려면 technicalPending: true)`,
      );
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

/** 자산 1건 분석 */
export function analyzeAsset(
  asset: AssetId,
  input: SnapshotInput,
  now: Date = new Date(),
): FusionResult {
  const assetInput = input.assets[asset];
  const macro = computeMacro(asset, assetInput?.factors ?? []);
  const technical = computeTechnical(assetInput?.candles ?? {});
  if (assetInput?.technicalPending) {
    // 번들 미첨부는 "데이터 오류"가 아니라 명시된 운영 상태다. 누락 플래그를 하나로 접는다.
    technical.flags = ["TECH_PENDING", ...technical.flags.filter((flag) => !flag.endsWith("_MISSING"))];
  }
  const events = computeEvents(asset, input.events ?? [], now);
  return fuse(asset, macro, technical, events, now);
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
    generatedAt: generatedAt.toISOString(),
    schedule: input.schedule || DEFAULT_SCHEDULE,
    ...(input.note ? { note: input.note } : {}),
    assets,
  };
}
