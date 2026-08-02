#!/usr/bin/env tsx
/**
 * 주간 보정.
 *
 *   npm run calibrate              # 리포트 생성 + A등급(중립밴드) 자동 적용
 *   npm run calibrate -- --dry     # 계산·출력만, 파일 수정 없음
 *   npm run calibrate -- --all     # ruleset 버전 무관하게 전체 집계
 *
 * 계산은 src/engine/calibrate.ts의 결정적 함수가 한다. 이 스크립트는 읽기·쓰기만 담당한다.
 * B·C 등급은 절대 자동 적용하지 않는다 — 리포트에만 남긴다.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCalibrationReport, renderCalibrationMarkdown } from "../src/engine/calibrate";
import { parsePredictions } from "../src/engine/scoreboard";
import type { AssetId, PredictionRecord } from "../src/engine/types";
import { RULESET_VERSION } from "../src/engine/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  history: string;
  params: string;
  outDir: string;
  dry: boolean;
  all: boolean;
  now?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    history: "data/history/predictions.jsonl",
    params: "src/engine/params.json",
    outDir: "docs/calibration",
    dry: false,
    all: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--history") options.history = next();
    else if (arg === "--params") options.params = next();
    else if (arg === "--out") options.outDir = next();
    else if (arg === "--now") options.now = next();
    else if (arg === "--dry") options.dry = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "사용법: npm run calibrate -- [옵션]",
          "  --dry        파일을 쓰지 않고 결과만 출력",
          "  --all        ruleset 버전 무관하게 전체 집계",
          "  --history    예측 기록 경로",
          "  --params     파라미터 파일 경로",
          "  --out        리포트 디렉터리",
          "  --now        기준 시각 ISO (테스트용)",
        ].join("\n"),
      );
      process.exit(0);
    } else {
      console.error(`알 수 없는 인자: ${arg}`);
      process.exit(2);
    }
  }
  return options;
}

interface ParamsFile {
  version: number;
  updatedAt: string;
  source: string;
  neutralBandPct: Record<AssetId, number>;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`--now 파싱 불가: ${options.now}`);
    process.exit(1);
  }

  const historyPath = resolve(root, options.history);
  let records: PredictionRecord[] = [];
  if (existsSync(historyPath)) {
    const parsed = parsePredictions(readFileSync(historyPath, "utf8"));
    records = parsed.records;
    if (parsed.broken) console.error(`경고: 기록 ${parsed.broken}줄을 읽지 못했습니다`);
  } else {
    console.error(`기록이 아직 없습니다: ${historyPath}`);
  }

  const paramsPath = resolve(root, options.params);
  const params = JSON.parse(readFileSync(paramsPath, "utf8")) as ParamsFile;

  const report = buildCalibrationReport(
    records,
    params.neutralBandPct,
    now,
    options.all ? null : RULESET_VERSION,
  );

  // A등급만 자동 적용한다
  const applied = report.bands.filter((band) => band.applied && band.proposed !== null);
  if (applied.length && !options.dry) {
    for (const band of applied) {
      params.neutralBandPct[band.asset] = band.proposed!;
    }
    params.updatedAt = now.toISOString();
    params.source = `calibrated:${now.toISOString().slice(0, 10)}`;
    writeFileSync(paramsPath, `${JSON.stringify(params, null, 2)}\n`, "utf8");
  }

  const markdown = renderCalibrationMarkdown(report);
  const reportPath = resolve(root, options.outDir, `${now.toISOString().slice(0, 10)}.md`);
  if (options.dry) {
    process.stdout.write(markdown);
  } else {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, markdown, "utf8");
    console.error(`리포트: ${reportPath}`);
  }

  // 콘솔 요약 — 알림에 그대로 쓸 수 있는 형태
  console.error(
    `기록 ${report.totals.records}건 · 채점 ${report.totals.scored}건 · ruleset ${report.ruleset}`,
  );
  if (applied.length) {
    for (const band of applied) {
      console.error(`  중립밴드 ${band.asset}: ${band.current}% → ${band.proposed}% (표본 ${band.n})`);
    }
  } else {
    console.error("  중립밴드: 변경 없음");
  }
  console.error(`  확신도 단조성: ${report.conviction.note}`);
  console.error(`  방향 게이트: ${report.gate.suggestion}`);
  console.error(`  위치 배수: ${report.position.note}`);
  const pending = report.factors.filter((factor) => factor.verdict !== "표본 부족");
  console.error(
    pending.length
      ? `  가중치 승인 대기 ${pending.length}건: ${pending
          .map((f) => `${f.asset}·${f.key}(${f.verdict})`)
          .join(", ")}`
      : "  가중치: 표본 부족",
  );
  for (const warning of report.warnings) console.error(`  ⚠ ${warning}`);
}

main();
