#!/usr/bin/env tsx
/**
 * 세션 입력(JSON) → 융합 엔진 → public/macro.json
 *
 *   npm run snapshot -- --input data/session/latest.json
 *   npm run snapshot -- --input data/session/latest.json --now 2026-08-03T08:00:00+09:00 --print
 *
 * 입력 스키마는 docs/fusion-ruleset-v1.md 참고.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSnapshot, validateInput } from "../src/engine/index";
import { renderNotification } from "../src/engine/notify";
import {
  buildScoreboard,
  openPrediction,
  upsertPrediction,
  parsePredictions,
  scoreboardLine,
  scorePredictions,
  serializePredictions,
} from "../src/engine/scoreboard";
import type { AssetId, PredictionRecord, Snapshot, SnapshotInput } from "../src/engine/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  input: string;
  out: string;
  history: string;
  now?: string;
  print: boolean;
  strict: boolean;
  /** 예측 기록·채점을 건너뛴다 (리허설용) */
  noHistory: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    input: "data/session/latest.json",
    out: "public/macro.json",
    history: "data/history/predictions.jsonl",
    print: false,
    strict: true,
    noHistory: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--input" || arg === "-i") options.input = next();
    else if (arg === "--out" || arg === "-o") options.out = next();
    else if (arg === "--now") options.now = next();
    else if (arg === "--history") options.history = next();
    else if (arg === "--no-history") options.noHistory = true;
    else if (arg === "--print") options.print = true;
    else if (arg === "--no-strict") options.strict = false;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "사용법: npm run snapshot -- [옵션]",
          "  --input, -i  세션 입력 JSON 경로 (기본 data/session/latest.json)",
          "  --out,   -o  출력 경로 (기본 public/macro.json)",
          "  --now        기준 시각 ISO (기본: 입력의 generatedAt 또는 현재)",
          "  --history    예측 기록 경로 (기본 data/history/predictions.jsonl)",
          "  --no-history 기록·채점을 건너뛴다",
          "  --print      파일에 쓰지 않고 표준출력으로만 확인",
          "  --no-strict  검증 오류가 있어도 계속 진행",
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

const DIRECTION_LABEL: Record<string, string> = {
  "-2": "강한하락",
  "-1": "하락",
  "0": "중립",
  "1": "상승",
  "2": "강한상승",
};

function summarize(snapshot: Snapshot): string {
  const rows = Object.entries(snapshot.assets).map(([asset, value]) => {
    const fusion = value!.fusion!;
    return [
      asset.padEnd(7),
      DIRECTION_LABEL[String(value!.direction)].padEnd(5),
      `${String(fusion.conviction).padStart(3)}점`,
      fusion.regime.padEnd(8),
      `기술 ${fusion.technical.score.toFixed(2).padStart(5)}`,
      `매크로 ${fusion.macro.score.toFixed(2).padStart(5)}`,
      fusion.playbook.slice(0, 46),
    ].join("  ");
  });
  return rows.join("\n");
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = resolve(root, options.input);

  let input: SnapshotInput;
  try {
    input = JSON.parse(readFileSync(inputPath, "utf8")) as SnapshotInput;
  } catch (error) {
    console.error(`입력을 읽지 못했습니다: ${inputPath}`);
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }

  const errors = validateInput(input);
  if (errors.length) {
    console.error("입력 검증 실패:");
    for (const error of errors) console.error(`  - ${error}`);
    if (options.strict) process.exit(1);
    console.error("(--no-strict: 계속 진행)");
  }

  const now = options.now ? new Date(options.now) : undefined;
  if (now && Number.isNaN(now.getTime())) {
    console.error(`--now 파싱 불가: ${options.now}`);
    process.exit(1);
  }
  if (now) input.generatedAt = now.toISOString();

  const snapshot = runSnapshot(input, now);
  const generatedAt = new Date(snapshot.generatedAt);

  if (!options.noHistory) {
    const historyPath = resolve(root, options.history);
    const { records, broken } = existsSync(historyPath)
      ? parsePredictions(readFileSync(historyPath, "utf8"))
      : { records: [] as PredictionRecord[], broken: 0 };
    if (broken) console.error(`경고: 기록 ${broken}줄을 읽지 못해 건너뜁니다`);

    // 1) 이번 실행의 가격으로 열린 예측을 먼저 채점한다
    const prices: Partial<Record<AssetId, number>> = {};
    for (const [asset, value] of Object.entries(snapshot.assets)) {
      const price = value!.fusion!.levels?.last ?? value!.fusion!.technical.lastPrice;
      if (Number.isFinite(price as number)) prices[asset as AssetId] = price as number;
    }
    const { scored, stale } = scorePredictions(records, prices, generatedAt);

    // 2) 이번 예측을 연다 (같은 세션 재실행이면 갈아끼운다)
    let updated = records;
    for (const value of Object.values(snapshot.assets)) {
      updated = upsertPrediction(updated, openPrediction(value!.fusion!, generatedAt));
    }
    updated.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));

    snapshot.scoreboard = buildScoreboard(updated, generatedAt);

    if (!options.print) {
      mkdirSync(dirname(historyPath), { recursive: true });
      writeFileSync(historyPath, serializePredictions(updated), "utf8");
    }
    console.error(
      `기록: 채점 ${scored}건${stale ? ` · 누락 마감 ${stale}건` : ""} · 누적 ${updated.length}건`,
    );
  }

  const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;

  if (options.print) {
    process.stdout.write(serialized);
  } else {
    const outPath = resolve(root, options.out);
    writeFileSync(outPath, serialized, "utf8");
    console.error(`작성: ${outPath}`);
  }

  console.error(`기준 ${snapshot.generatedAt} · ruleset ${snapshot.ruleset}`);
  console.error(summarize(snapshot));
  console.error("\n── 알림 문구 (그대로 마지막 답변에 쓴다) ──");
  console.error(renderNotification(snapshot));
  console.error("── 알림 문구 끝 ──");
  if (snapshot.scoreboard) console.error(scoreboardLine(snapshot.scoreboard));

  const flagged = Object.entries(snapshot.assets).filter(
    ([, value]) => value!.fusion!.flags.length,
  );
  if (flagged.length) {
    console.error("\n플래그:");
    for (const [asset, value] of flagged) {
      console.error(`  ${asset}: ${value!.fusion!.flags.join(", ")}`);
    }
  }
}

main();
