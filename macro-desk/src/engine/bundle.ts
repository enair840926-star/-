/**
 * v4 통합 번들(rawbundle.json) → 엔진 캔들 입력 어댑터.
 *
 * ruleset v4.5.26 §1을 따른다.
 *  - candles[].time_utc는 봉 "시작" 시각이며 이미 true UTC로 교정된 값이다(추가 시프트 금지).
 *  - is_complete=false 봉은 확정 지표 계산에서 제외한다.
 * 번들의 hud_lite/by_tf/derived 같은 파생값은 읽지 않고 원시 캔들만 옮긴다.
 */
import type { CandleRow, Timeframe } from "./types";
import { TIMEFRAMES } from "./types";

const TF_ALIASES: Record<string, Timeframe> = {
  d1: "D1",
  daily: "D1",
  "1d": "D1",
  h4: "H4",
  "4h": "H4",
  "240": "H4",
  h1: "H1",
  "1h": "H1",
  "60": "H1",
  m15: "M15",
  "15m": "M15",
  "15": "M15",
};

type LooseCandle = Record<string, unknown>;

export function normalizeTf(value: unknown): Timeframe | null {
  if (typeof value !== "string") return null;
  return TF_ALIASES[value.trim().toLowerCase()] ?? null;
}

function pick(candle: LooseCandle, keys: string[]): unknown {
  for (const key of keys) {
    if (candle[key] !== undefined && candle[key] !== null) return candle[key];
  }
  return undefined;
}

function toIso(time: unknown): string | null {
  if (typeof time === "number") {
    const ms = time > 1e12 ? time : time * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof time !== "string" || !time.trim()) return null;
  const text = time.trim();
  // "2026-07-31 21:00:00" 같은 공백 구분 표기는 UTC로 해석한다.
  const candidate = /[zZ]|[+-]\d{2}:?\d{2}$/.test(text)
    ? text
    : `${text.replace(" ", "T")}${text.includes("T") || text.includes(" ") ? "" : "T00:00:00"}Z`;
  const date = new Date(candidate.endsWith("Z") ? candidate : `${candidate}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toRow(candle: LooseCandle): CandleRow | null {
  if (candle.is_complete === false) return null;
  const iso = toIso(pick(candle, ["time_utc", "time", "t", "timestamp", "datetime"]));
  if (!iso) return null;
  const open = Number(pick(candle, ["open", "o"]));
  const high = Number(pick(candle, ["high", "h"]));
  const low = Number(pick(candle, ["low", "l"]));
  const close = Number(pick(candle, ["close", "c"]));
  if (![open, high, low, close].every((value) => Number.isFinite(value))) return null;
  return [iso, open, high, low, close];
}

/** rawbundle의 가능한 캔들 배치 형태를 모두 받아 TF별 배열로 정규화한다. */
export function collectByTimeframe(bundle: unknown): Partial<Record<Timeframe, LooseCandle[]>> {
  const out: Partial<Record<Timeframe, LooseCandle[]>> = {};
  const push = (tf: Timeframe, list: unknown) => {
    if (!Array.isArray(list)) return;
    out[tf] = [...(out[tf] ?? []), ...(list as LooseCandle[])];
  };

  const visit = (node: unknown, depth: number) => {
    if (!node || typeof node !== "object" || depth > 5) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (!item || typeof item !== "object") continue;
        const record = item as LooseCandle;
        const tf = normalizeTf(record.tf ?? record.timeframe ?? record.period);
        if (tf) push(tf, record.candles ?? record.bars ?? record.data ?? [record]);
      }
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      const tf = normalizeTf(key);
      if (tf && Array.isArray(value)) {
        push(tf, value);
        continue;
      }
      if (value && typeof value === "object") visit(value, depth + 1);
    }
  };

  visit(bundle, 0);
  return out;
}

export interface BundleExtract {
  candles: Partial<Record<Timeframe, CandleRow[]>>;
  /** TF별 채택 봉 수와 마지막 봉 시각 */
  report: Array<{ tf: Timeframe; bars: number; lastTime: string | null; dropped: number }>;
}

export function extractBundleCandles(bundle: unknown, maxBars = 180): BundleExtract {
  const collected = collectByTimeframe(bundle);
  const candles: BundleExtract["candles"] = {};
  const report: BundleExtract["report"] = [];

  for (const tf of TIMEFRAMES) {
    const list = collected[tf] ?? [];
    const rows = list
      .map(toRow)
      .filter((row): row is CandleRow => row !== null)
      .sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
    const deduped = rows.filter((row, index) => index === 0 || row[0] !== rows[index - 1][0]);
    const trimmed = deduped.slice(Math.max(0, deduped.length - maxBars));
    if (trimmed.length) candles[tf] = trimmed;
    report.push({
      tf,
      bars: trimmed.length,
      lastTime: trimmed.length ? trimmed[trimmed.length - 1][0] : null,
      dropped: list.length - deduped.length,
    });
  }

  return { candles, report };
}
