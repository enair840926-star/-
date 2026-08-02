#!/usr/bin/env tsx
/**
 * v4 통합 번들(rawbundle.json 또는 ZIP)의 캔들을 세션 입력의 candles 블록으로 옮긴다.
 *
 *   npm run bundle -- --asset XAUUSD --zip ~/bundles/xauusd-v4.zip
 *   npm run bundle -- --asset NAS100 --raw /tmp/extract/rawbundle.json
 *
 * 매크로 팩터는 건드리지 않는다. 기술 레이어 입력만 교체한다(레이어 잠금).
 * 확정봉(is_complete!==false)만 넘긴다 — ruleset v4.5.26 §1 준수.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBundleCandles } from "../src/engine/bundle";
import type { AssetId, SnapshotInput } from "../src/engine/types";
import { ASSET_IDS } from "../src/engine/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

interface Options {
  asset: AssetId;
  zip?: string;
  raw?: string;
  input: string;
  maxBars: number;
  print: boolean;
}

function usage(code: number): never {
  console.error(
    [
      "사용법: npm run bundle -- --asset <ID> (--zip <파일> | --raw <rawbundle.json>)",
      "  --asset    NAS100 | XAUUSD | USOIL | EURUSD",
      "  --zip      v4 통합 번들 ZIP (내부 rawbundle.json을 읽는다)",
      "  --raw      이미 추출한 rawbundle.json",
      "  --input    갱신할 세션 입력 (기본 data/session/latest.json)",
      "  --max-bars TF당 최대 봉 수 (기본 180)",
      "  --print    파일에 쓰지 않고 candles 블록만 출력",
    ].join("\n"),
  );
  process.exit(code);
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { input: "data/session/latest.json", maxBars: 180, print: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    if (arg === "--asset") options.asset = next() as AssetId;
    else if (arg === "--zip") options.zip = next();
    else if (arg === "--raw") options.raw = next();
    else if (arg === "--input") options.input = next();
    else if (arg === "--max-bars") options.maxBars = Number(next());
    else if (arg === "--print") options.print = true;
    else if (arg === "--help" || arg === "-h") usage(0);
    else usage(2);
  }
  if (!options.asset || !ASSET_IDS.includes(options.asset)) usage(2);
  if (!options.zip && !options.raw) usage(2);
  return options as Options;
}

function loadRawBundle(options: Options): unknown {
  if (options.raw) {
    return JSON.parse(readFileSync(resolve(root, options.raw), "utf8"));
  }
  const zipPath = resolve(root, options.zip!);
  if (!existsSync(zipPath)) {
    console.error(`ZIP을 찾을 수 없습니다: ${zipPath}`);
    process.exit(1);
  }
  const listing = execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const entry = listing.find((name) => name.endsWith("rawbundle.json"));
  if (!entry) {
    console.error(`ZIP 안에 rawbundle.json이 없습니다. 내용: ${listing.join(", ")}`);
    process.exit(1);
  }
  const buffer = execFileSync("unzip", ["-p", zipPath, entry], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  return JSON.parse(buffer);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const bundle = loadRawBundle(options);
  const { candles, report: rows } = extractBundleCandles(bundle, options.maxBars);
  const report = rows.map(
    (row) => `${row.tf} ${row.bars}봉${row.lastTime ? ` (마지막 ${row.lastTime})` : ""}`,
  );

  if (!Object.keys(candles).length) {
    console.error("번들에서 캔들을 찾지 못했습니다. rawbundle 구조를 확인하세요.");
    process.exit(1);
  }

  if (options.print) {
    process.stdout.write(`${JSON.stringify(candles, null, 2)}\n`);
    console.error(report.join(" · "));
    return;
  }

  const inputPath = resolve(root, options.input);
  const input: SnapshotInput = existsSync(inputPath)
    ? (JSON.parse(readFileSync(inputPath, "utf8")) as SnapshotInput)
    : { events: [], assets: {} };
  input.assets = input.assets ?? {};
  const existing = input.assets[options.asset];
  input.assets[options.asset] = {
    factors: existing?.factors ?? [],
    candles,
    dataSource: `v4 통합 번들 (${options.zip ?? options.raw})`,
  };
  writeFileSync(inputPath, `${JSON.stringify(input, null, 2)}\n`, "utf8");
  console.error(`${options.asset} 캔들 갱신: ${inputPath}`);
  console.error(report.join(" · "));
  if (!existing?.factors?.length) {
    console.error("주의: 이 자산의 매크로 팩터가 비어 있습니다. 수집 후 다시 스냅샷을 만드세요.");
  }
}

main();
