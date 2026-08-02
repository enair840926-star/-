import { useEffect, useMemo, useRef, useState } from "react";
import type { FusionResult, Regime, Scoreboard } from "./engine/types";
import { regimeLabel } from "./engine/fusion";

const KST = "Asia/Seoul";
const STORE_KEY = "macrodesk:v4:overrides";

const CITIES = [
  ["Asia/Tokyo", "아시아"],
  ["Europe/London", "런던"],
  ["America/New_York", "뉴욕"],
] as const;

const ASSETS = [
  {
    id: "NAS100",
    name: "NAS100",
    sub: "나스닥100",
    drivers: "美 국채금리 · Fed · 빅테크 실적 · 위험선호",
  },
  {
    id: "XAUUSD",
    name: "XAUUSD",
    sub: "골드",
    drivers: "DXY · 실질금리 · Fed·물가·고용 · 안전자산/지정학",
  },
  {
    id: "USOIL",
    name: "USOIL",
    sub: "WTI 원유",
    drivers: "EIA/API 재고 · OPEC+ · 공급/지정학 · 달러 · 수요",
  },
  {
    id: "EURUSD",
    name: "EURUSD",
    sub: "유로달러",
    drivers: "Fed·ECB · 美-EZ 금리차 · 양 지역 지표 · 달러/유로 강도",
  },
] as const;

type AssetId = (typeof ASSETS)[number]["id"];
type Direction = -2 | -1 | 0 | 1 | 2;

const DIRS: Array<{
  v: Direction;
  short: string;
  label: string;
  color: string;
}> = [
  { v: -2, short: "강하락", label: "강한 하락", color: "#f0546a" },
  { v: -1, short: "하락", label: "하락", color: "#d46173" },
  { v: 0, short: "중립", label: "중립", color: "#e4b455" },
  { v: 1, short: "상승", label: "상승", color: "#3bb68c" },
  { v: 2, short: "강상승", label: "강한 상승", color: "#2fd4a0" },
];

const EVENTS = [
  {
    label: "미국 주요지표 (CPI·고용 등)",
    tz: "America/New_York",
    h: 8,
    m: 30,
    note: "발표일",
  },
  {
    label: "FOMC 성명",
    tz: "America/New_York",
    h: 14,
    m: 0,
    note: "FOMC일·익일새벽",
  },
  {
    label: "EIA 원유재고",
    tz: "America/New_York",
    h: 10,
    m: 30,
    note: "수요일",
  },
  {
    label: "ECB 통화정책",
    tz: "Europe/Berlin",
    h: 14,
    m: 15,
    note: "ECB일",
  },
] as const;

interface Driver {
  name: string;
  read: "상승" | "하락" | "중립";
  note: string;
}

interface Bias {
  direction: Direction | null;
  confidence: "높음" | "중간" | "낮음" | null;
  rationale: string;
  drivers: Driver[];
  event: string;
  asof: string | null;
  setAt: string | null;
  source: "scheduled" | "manual" | null;
  note?: string;
  fusion?: FusionResult;
}

interface MacroPayload {
  version: number;
  generatedAt: string | null;
  schedule: string;
  scoreboard?: Scoreboard;
  assets: Record<AssetId, Bias>;
}

type Overrides = Partial<Record<AssetId, Partial<Bias>>>;

const EMPTY_BIAS: Bias = {
  direction: null,
  confidence: null,
  rationale: "",
  drivers: [],
  event: "없음",
  asof: null,
  setAt: null,
  source: null,
};

const EMPTY_PAYLOAD: MacroPayload = {
  version: 1,
  generatedAt: null,
  schedule: "08:00 · 16:00 · 22:00 KST",
  assets: Object.fromEntries(
    ASSETS.map((asset) => [asset.id, { ...EMPTY_BIAS }]),
  ) as Record<AssetId, Bias>,
};

function tzOffsetHours(tz: string, date: Date) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  dtf.formatToParts(date).forEach((x) => {
    p[x.type] = x.value;
  });
  const hh = p.hour === "24" ? "00" : p.hour;
  const asUTC = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(hh),
    Number(p.minute),
    Number(p.second),
  );
  return (asUTC - date.getTime()) / 3_600_000;
}

function ymdInTz(tz: string, date: Date) {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const p: Record<string, string> = {};
  dtf.formatToParts(date).forEach((x) => {
    p[x.type] = x.value;
  });
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day) };
}

function instantFromCity(
  tz: string,
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  return guess - tzOffsetHours(tz, new Date(guess)) * 3_600_000;
}

const mod24 = (x: number) => ((x % 24) + 24) % 24;
const inWrap = (x: number, a: number, b: number) =>
  a <= b ? x >= a && x < b : x >= a || x < b;

function kstHourFloat(date: Date) {
  const dtf = new Intl.DateTimeFormat("en-GB", {
    timeZone: KST,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const p: Record<string, string> = {};
  dtf.formatToParts(date).forEach((x) => {
    p[x.type] = x.value;
  });
  const hh = p.hour === "24" ? 0 : Number(p.hour);
  return hh + Number(p.minute) / 60 + Number(p.second) / 3600;
}

function buildBoundaries(now: Date) {
  const out: Array<{ t: number; label: string; kind: string }> = [];
  for (let off = -1; off <= 2; off += 1) {
    const base = new Date(now.getTime() + off * 86_400_000);
    for (const [tz, label] of CITIES) {
      const { y, m, d } = ymdInTz(tz, base);
      out.push({
        t: instantFromCity(tz, y, m, d, 8, 0),
        label,
        kind: "개장",
      });
      out.push({
        t: instantFromCity(tz, y, m, d, 17, 0),
        label,
        kind: "폐장",
      });
    }
  }
  return out
    .sort((a, b) => a.t - b.t)
    .filter((b, i, arr) => i === 0 || Math.abs(b.t - arr[i - 1].t) > 60_000);
}

function activeSessions(now: Date) {
  const nowK = kstHourFloat(now);
  return CITIES.map(([tz, label]) => {
    const off = tzOffsetHours(tz, now);
    const open = mod24(8 + (9 - off));
    const close = mod24(17 + (9 - off));
    return { label, open, close, active: inWrap(nowK, open, close) };
  });
}

function freshness(
  setAt: string | null,
  now: Date,
  boundaries: ReturnType<typeof buildBoundaries>,
) {
  if (!setAt) return { state: "unset", frac: 0 } as const;
  const start = Date.parse(setAt);
  if (!Number.isFinite(start)) return { state: "stale", frac: 0 } as const;
  const current = now.getTime();
  const crossed = boundaries.filter((b) => b.t > start && b.t <= current).length;
  const next = boundaries.find((b) => b.t > start);
  const elapsed = current - start;
  const state =
    crossed >= 2 || elapsed > 12 * 3_600_000
      ? "stale"
      : crossed >= 1
        ? "review"
        : "fresh";
  const frac = next
    ? Math.max(0, Math.min(1, 1 - (current - start) / (next.t - start)))
    : 1;
  return {
    state,
    frac,
    crossed,
    elapsed,
    validUntil: next?.t ?? null,
    boundaryLabel: next ? `${next.label} ${next.kind}` : null,
  };
}

function fmtClock(ts: number) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: KST,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(new Date(ts));
}

function fmtDate(ts: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(new Date(ts));
}

function fmtKST(ts: number | string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: KST,
    month: "numeric",
    day: "numeric",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

function fmtDur(ms: number) {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
}

function segsFor(open: number, close: number) {
  const o = mod24(open);
  const c = mod24(close);
  const pct = (h: number) => (h / 24) * 100;
  if (o < c) return [{ left: pct(o), width: pct(c) - pct(o) }];
  return [
    { left: pct(o), width: 100 - pct(o) },
    { left: 0, width: pct(c) },
  ];
}

function readClass(read: Driver["read"]) {
  return read === "상승" ? "up" : read === "하락" ? "down" : "neutral";
}

function readLabel(read: Driver["read"]) {
  return read === "상승" ? "상승요인" : read === "하락" ? "하락요인" : "중립";
}

function normalizePayload(value: unknown): MacroPayload {
  if (!value || typeof value !== "object") throw new Error("데이터 형식 오류");
  const input = value as Partial<MacroPayload>;
  const assets = { ...EMPTY_PAYLOAD.assets };
  for (const asset of ASSETS) {
    const raw = input.assets?.[asset.id];
    if (!raw) continue;
    const direction =
      raw.direction === null || raw.direction === undefined
        ? Number.NaN
        : Number(raw.direction);
    const fusion =
      raw.fusion && typeof raw.fusion === "object" && Number.isFinite(raw.fusion.conviction)
        ? raw.fusion
        : undefined;
    assets[asset.id] = {
      ...EMPTY_BIAS,
      ...raw,
      fusion,
      direction:
        Number.isInteger(direction) && direction >= -2 && direction <= 2
          ? (direction as Direction)
          : null,
      drivers: Array.isArray(raw.drivers) ? raw.drivers.slice(0, 5) : [],
      source: raw.source === "manual" ? "manual" : "scheduled",
    };
  }
  return {
    version: Number(input.version) || 1,
    generatedAt: input.generatedAt || null,
    schedule: input.schedule || EMPTY_PAYLOAD.schedule,
    ...(input.scoreboard && typeof input.scoreboard === "object"
      ? { scoreboard: input.scoreboard }
      : {}),
    assets,
  };
}

const REGIME_CLASS: Record<Regime, string> = {
  ALIGNED: "aligned",
  PARTIAL: "partial",
  CONFLICT: "conflict",
  RANGE: "range",
};

function LayerBar({
  label,
  score,
  confidence,
  hint,
}: {
  label: string;
  score: number;
  confidence: number;
  hint: string;
}) {
  const half = Math.min(50, (Math.abs(score) / 2) * 50);
  const positive = score >= 0;
  return (
    <div className="md-layer">
      <div className="md-layer-head">
        <span className="md-layer-label">{label}</span>
        <span className={`md-layer-value ${positive ? "up" : "down"}`}>
          {score > 0 ? "+" : ""}
          {score.toFixed(2)}
        </span>
        <span className="md-layer-conf">신뢰 {Math.round(confidence * 100)}%</span>
      </div>
      <div className="md-layer-track">
        <i className="md-layer-mid" />
        <div
          className={`md-layer-fill ${positive ? "up" : "down"}`}
          style={{ width: `${half}%`, left: positive ? "50%" : `${50 - half}%` }}
        />
      </div>
      <div className="md-layer-hint">{hint}</div>
    </div>
  );
}

function FusionPanel({
  fusion,
  now,
  expanded,
}: {
  fusion: FusionResult;
  now: Date;
  expanded: boolean;
}) {
  const macroOnly = fusion.mode === "macro-only";
  const blackout = fusion.events.activeBlackout;
  const nextStart = fusion.events.nextBlackoutStart
    ? Date.parse(fusion.events.nextBlackoutStart)
    : null;
  const countdown = blackout
    ? {
        tone: "danger" as const,
        text: `블랙아웃 진행 · ${fmtDur(Date.parse(blackout.blackoutEnd) - now.getTime())} 후 해제`,
      }
    : nextStart && nextStart > now.getTime()
      ? {
          tone: (nextStart - now.getTime() < 90 * 60_000 ? "warn" : "muted") as
            | "warn"
            | "muted",
          text: `다음 블랙아웃까지 ${fmtDur(nextStart - now.getTime())}`,
        }
      : null;

  const topMacro = fusion.macro.factors.slice(0, 3);
  const macroHint = topMacro.length
    ? topMacro.map((factor) => factor.label).join(" · ")
    : "매크로 팩터 없음";
  const techHint = fusion.technical.timeframes.length
    ? fusion.technical.timeframes
        .map((read) => `${read.tf} ${read.score > 0 ? "+" : ""}${read.score.toFixed(1)}`)
        .join(" · ")
    : "차트 데이터 없음";

  return (
    <div className="md-fusion">
      <div className="md-fusion-top">
        <span className={`md-regime ${REGIME_CLASS[fusion.regime]}`}>
          {regimeLabel(fusion.regime, fusion.mode)}
        </span>
        <div className="md-conviction">
          <div className="md-conviction-track">
            <div
              className={`md-conviction-fill ${REGIME_CLASS[fusion.regime]}`}
              style={{ width: `${fusion.conviction}%` }}
            />
          </div>
          <span className="md-conviction-value">확신도 {fusion.conviction}</span>
        </div>
      </div>

      <div className="md-layers">
        {!macroOnly && (
          <LayerBar
            label="차트"
            score={fusion.technical.score}
            confidence={fusion.technical.confidence}
            hint={techHint}
          />
        )}
        <LayerBar
          label={macroOnly ? "외부요인 편향" : "매크로"}
          score={fusion.macro.score}
          confidence={fusion.macro.confidence}
          hint={macroHint}
        />
      </div>

      <p className="md-playbook">{fusion.playbook}</p>

      {countdown && <div className={`md-countdown ${countdown.tone}`}>{countdown.text}</div>}

      <div className="md-levels">
        {macroOnly ? (
          <>
            {fusion.levels?.last !== undefined && (
              <span>
                기준가 <b>{fusion.levels.last}</b>
              </span>
            )}
            {!!fusion.levels?.support?.length && (
              <span>
                지지 <b>{fusion.levels.support.join(" / ")}</b>
              </span>
            )}
            {!!fusion.levels?.resistance?.length && (
              <span>
                저항 <b>{fusion.levels.resistance.join(" / ")}</b>
              </span>
            )}
            {!fusion.levels && <span className="md-levels-empty">관측 레벨 미수집</span>}
          </>
        ) : (
          <>
            {fusion.technical.lastPrice !== null && (
              <span>
                현재 <b>{fusion.technical.lastPrice}</b>
              </span>
            )}
            {fusion.technical.invalidation.long !== null && (
              <span>
                롱 무효화 <b>{fusion.technical.invalidation.long}</b>
              </span>
            )}
            {fusion.technical.invalidation.short !== null && (
              <span>
                숏 무효화 <b>{fusion.technical.invalidation.short}</b>
              </span>
            )}
            {fusion.technical.rangeUsage !== null && (
              <span>
                레인지 소진 <b>{Math.round(fusion.technical.rangeUsage * 100)}%</b>
              </span>
            )}
          </>
        )}
      </div>

      {expanded && (
        <div className="md-fusion-detail">
          <div className="md-sub-title">매크로 팩터 · 기여도순</div>
          <div className="md-factor-list">
            {fusion.macro.factors.map((factor) => (
              <div className="md-factor" key={factor.key}>
                <span className={`md-factor-read ${readClass(stanceRead(factor.stance))}`}>
                  {factor.stance > 0 ? "+" : ""}
                  {factor.stance}
                </span>
                <span className="md-factor-body">
                  <b>
                    {factor.label}
                    <em>가중 {Math.round(factor.weight * 100)}%</em>
                  </b>
                  <span>{factor.note}</span>
                </span>
              </div>
            ))}
            {!fusion.macro.factors.length && (
              <div className="md-empty">수집된 매크로 팩터가 없습니다</div>
            )}
          </div>

          {!macroOnly && <div className="md-sub-title">타임프레임</div>}
          {!macroOnly && <div className="md-tf-list">
            {fusion.technical.timeframes.map((read) => (
              <div className="md-tf" key={read.tf}>
                <span className="md-tf-name">{read.tf}</span>
                <span className={`md-tf-score ${read.score >= 0 ? "up" : "down"}`}>
                  {read.score > 0 ? "+" : ""}
                  {read.score.toFixed(2)}
                </span>
                <span className="md-tf-note">{read.note}</span>
              </div>
            ))}
            {!fusion.technical.timeframes.length && (
              <div className="md-empty">차트 데이터가 없습니다</div>
            )}
          </div>}

          {fusion.reanalyzeTriggers.length > 0 && (
            <>
              <div className="md-sub-title">재분석 트리거</div>
              <ul className="md-triggers">
                {fusion.reanalyzeTriggers.map((trigger) => (
                  <li key={trigger}>{trigger}</li>
                ))}
              </ul>
            </>
          )}

          {fusion.flags.length > 0 && (
            <div className="md-flags">
              {fusion.flags.map((flag) => (
                <span key={flag}>{flag}</span>
              ))}
            </div>
          )}

          <div className="md-weights">
            {macroOnly
              ? "외부요인 전용 · 차트 미사용(확신도 상한 70)"
              : `융합 가중 차트 ${Math.round(fusion.weights.technical * 100)}% · 매크로 ${Math.round(fusion.weights.macro * 100)}%`}
            {fusion.events.maxTier > 0 && ` · 이벤트 ${fusion.events.maxTier}티어 상한 ${fusion.events.convictionCap}`}
          </div>
        </div>
      )}
    </div>
  );
}

function pct(rate: number | null) {
  return rate === null ? "—" : `${Math.round(rate * 100)}%`;
}

/** 예측이 실제로 맞았는지. 이 표가 없으면 가중치는 영원히 추측으로 남는다. */
function ScoreboardPanel({ board }: { board: Scoreboard }) {
  const assets = Object.entries(board.byAsset);
  const buckets = Object.entries(board.byConviction).filter(([, b]) => b.n > 0);
  return (
    <section className="md-scoreboard">
      <div className="md-section-title">
        방향 적중률 <span>최근 {board.window}건 기준 · 8시간 구간</span>
      </div>
      {board.total.n === 0 ? (
        <p className="md-scoreboard-empty">
          아직 채점된 예측이 없습니다. 스냅샷이 두 번 이상 쌓이면 집계가 시작됩니다.
        </p>
      ) : (
        <>
          <div className="md-scoreboard-total">
            <b>{pct(board.total.rate)}</b>
            <span>
              {board.total.hit}/{board.total.n}건 적중
            </span>
          </div>
          <div className="md-scoreboard-grid">
            {assets.map(([asset, bucket]) => (
              <div className="md-score-row" key={asset}>
                <span className="md-score-name">{asset}</span>
                <span className="md-score-rate">{pct(bucket.rate)}</span>
                <span className="md-score-note">
                  {bucket.n}건
                  {bucket.neutralN > 0 &&
                    ` · 중립 ${bucket.neutralN}건 중 ${bucket.neutralMoved}건은 실제로 움직임`}
                </span>
              </div>
            ))}
          </div>
          {buckets.length > 0 && (
            <div className="md-scoreboard-grid">
              {buckets.map(([id, bucket]) => (
                <div className="md-score-row" key={id}>
                  <span className="md-score-name">확신도 {id}</span>
                  <span className="md-score-rate">{pct(bucket.rate)}</span>
                  <span className="md-score-note">{bucket.n}건</span>
                </div>
              ))}
            </div>
          )}
          <p className="md-scoreboard-note">
            확신도가 높은 구간의 적중률이 더 낮다면 확신도 공식이 틀린 것입니다.
          </p>
        </>
      )}
    </section>
  );
}

function stanceRead(stance: number): Driver["read"] {
  if (stance > 0.25) return "상승";
  if (stance < -0.25) return "하락";
  return "중립";
}

export default function App() {
  const [now, setNow] = useState(new Date());
  const [payload, setPayload] = useState<MacroPayload>(EMPTY_PAYLOAD);
  const [overrides, setOverrides] = useState<Overrides>(() => {
    try {
      return JSON.parse(localStorage.getItem(STORE_KEY) || "{}") as Overrides;
    } catch {
      return {};
    }
  });
  const [expanded, setExpanded] = useState<Partial<Record<AssetId, boolean>>>({});
  const [showEvents, setShowEvents] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadedOnce = useRef(false);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(overrides));
  }, [overrides]);

  async function loadRemote() {
    if (loadedOnce.current) setRefreshing(true);
    setError(null);
    try {
      const response = await fetch(
        `${import.meta.env.BASE_URL}macro.json?t=${Date.now()}`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`데이터 연결 실패 (${response.status})`);
      setPayload(normalizePayload(await response.json()));
      loadedOnce.current = true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "데이터를 불러오지 못했습니다");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    void loadRemote();
  }, []);

  const boundaries = useMemo(
    () => buildBoundaries(now),
    [Math.floor(now.getTime() / 60_000)],
  );
  const sessions = useMemo(
    () => activeSessions(now),
    [Math.floor(now.getTime() / 60_000)],
  );
  const activeNow = sessions.filter((s) => s.active).map((s) => s.label);
  const nowK = kstHourFloat(now);

  function mergedBias(id: AssetId): Bias {
    return { ...payload.assets[id], ...(overrides[id] || {}) };
  }

  function setDirection(id: AssetId, direction: Direction) {
    setOverrides((prev) => ({
      ...prev,
      [id]: {
        ...(prev[id] || {}),
        direction,
        setAt: new Date().toISOString(),
        source: "manual",
        confidence: null,
        drivers: [],
        event: "없음",
        asof: null,
        fusion: undefined,
      },
    }));
  }

  function clearOverride(id: AssetId) {
    setOverrides((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  function setNote(id: AssetId, note: string) {
    setOverrides((prev) => ({
      ...prev,
      [id]: { ...(prev[id] || {}), note },
    }));
  }

  return (
    <div className="md-root">
      <header className="md-head">
        <div className="md-head-top">
          <span className="md-eyebrow">MACRO DESK</span>
          <span className="md-tzpill">KST · UTC+9</span>
        </div>
        <div className="md-clock">{fmtClock(now.getTime())}</div>
        <div className="md-date">{fmtDate(now.getTime())}</div>

        <div className="md-sessions">
          {sessions.map((session) => (
            <span
              key={session.label}
              className={`md-session ${session.active ? "on" : ""}`}
            >
              <i />
              {session.label}
              <em>
                {String(Math.floor(session.open)).padStart(2, "0")}–
                {String(Math.floor(session.close)).padStart(2, "0")}
              </em>
            </span>
          ))}
        </div>
        <div className="md-live">
          {activeNow.length
            ? `${activeNow.join(" · ")} 세션 진행 중`
            : "메이저 세션 공백 구간"}
        </div>

        <button
          className="md-refresh"
          onClick={() => void loadRemote()}
          disabled={refreshing}
        >
          <span className={refreshing ? "spin" : ""}>⟳</span>
          {refreshing ? "예약 분석 불러오는 중…" : "최신 예약 분석 불러오기"}
        </button>
        <div className="md-refresh-note">
          매일 {payload.schedule} 자동 갱신 · 매크로 + 차트 융합 · 레이어별 근거 보존
        </div>
        {error && <div className="md-global-error">{error}</div>}
      </header>

      <main className="md-cards" aria-busy={loading}>
        {ASSETS.map((asset) => {
          const bias = mergedBias(asset.id);
          const setAt = bias.setAt ? Date.parse(bias.setAt) : null;
          const fresh = freshness(bias.setAt, now, boundaries);
          const selected = DIRS.find((d) => d.v === bias.direction);
          const isSet = bias.direction !== null;
          const isManual = bias.source === "manual";
          const isExpanded = !!expanded[asset.id];
          const hasEvent = bias.event && bias.event !== "없음";
          const barColor =
            !isSet || fresh.state === "unset"
              ? "#39435a"
              : fresh.state === "stale"
                ? "#f0546a"
                : fresh.state === "review"
                  ? "#f0a93c"
                  : fresh.frac > 0.5
                    ? "#3bb68c"
                    : "#e4b455";

          return (
            <section
              key={asset.id}
              className={`md-card ${isSet ? fresh.state : "unset"}`}
            >
              <div className="md-drain">
                <div
                  className="md-drain-fill"
                  style={{
                    width: `${isSet ? fresh.frac * 100 : 0}%`,
                    background: barColor,
                  }}
                />
              </div>

              <div className="md-card-head">
                <div className="md-asset">
                  <span className="md-asset-name">{asset.name}</span>
                  <span className="md-asset-sub">{asset.sub}</span>
                </div>
                <div className="md-badges">
                  {isSet && (
                    <span className={`md-source ${isManual ? "manual" : ""}`}>
                      {isManual ? "수동" : "예약"}
                    </span>
                  )}
                  {!isSet && <span className="md-badge unset">미설정</span>}
                  {isSet && fresh.state === "fresh" && (
                    <span className="md-badge fresh">
                      <b>{selected?.label}</b>
                      {selected && selected.v > 0
                        ? " ▲"
                        : selected && selected.v < 0
                          ? " ▼"
                          : " ●"}
                    </span>
                  )}
                  {isSet && fresh.state === "review" && (
                    <span className="md-badge review">세션 전환 · 재확인</span>
                  )}
                  {isSet && fresh.state === "stale" && (
                    <span className="md-badge stale">만료 · 재분석</span>
                  )}
                  {overrides[asset.id] && (
                    <button
                      className="md-reset"
                      onClick={() => clearOverride(asset.id)}
                      title="예약 분석으로 복원"
                      aria-label={`${asset.name} 예약 분석으로 복원`}
                    >
                      ⟲
                    </button>
                  )}
                </div>
              </div>

              <div className="md-gauge" role="group" aria-label={`${asset.name} 방향`}>
                {DIRS.map((direction) => {
                  const active = direction.v === bias.direction;
                  return (
                    <button
                      key={direction.v}
                      className={`md-segment ${active ? "selected" : ""}`}
                      style={
                        active
                          ? {
                              background: direction.color,
                              borderColor: direction.color,
                              color: "#0b0e14",
                            }
                          : undefined
                      }
                      onClick={() => setDirection(asset.id, direction.v)}
                    >
                      {direction.short}
                    </button>
                  );
                })}
              </div>

              <div className="md-meta">
                {isSet && setAt ? (
                  <>
                    <span>
                      기준 <b>{fmtKST(setAt)}</b> ·{" "}
                      {fresh.elapsed !== undefined
                        ? `${fmtDur(fresh.elapsed)} 전`
                        : "시간 확인 필요"}
                    </span>
                    {!isManual && bias.confidence && (
                      <span className="ai">컨피던스 {bias.confidence}</span>
                    )}
                    {hasEvent && <span className="event">⚡ {bias.event}</span>}
                    {fresh.state === "fresh" && fresh.validUntil && (
                      <span className="ok">
                        유효 ~{fmtKST(fresh.validUntil)}
                      </span>
                    )}
                    {fresh.state === "review" && (
                      <span className="warn">세션 경계 통과 — 다시 볼 시점</span>
                    )}
                    {fresh.state === "stale" && (
                      <span className="danger">이전 세션 데이터</span>
                    )}
                  </>
                ) : (
                  <span className="hint">
                    첫 예약 분석 대기 · 방향 버튼으로 수동 설정 가능
                  </span>
                )}
              </div>

              {bias.fusion && !isManual && (
                <FusionPanel fusion={bias.fusion} now={now} expanded={isExpanded} />
              )}

              {(bias.drivers.length > 0 || (bias.fusion && !isManual)) && (
                <div className="md-detail">
                  <button
                    className="md-detail-toggle"
                    onClick={() =>
                      setExpanded((prev) => ({
                        ...prev,
                        [asset.id]: !prev[asset.id],
                      }))
                    }
                  >
                    {isExpanded ? "▾" : "▸"} 근거 상세
                    <span>
                      {bias.fusion && !isManual
                        ? bias.fusion.mode === "macro-only"
                          ? `팩터 ${bias.fusion.macro.factors.length}개`
                          : `팩터 ${bias.fusion.macro.factors.length} · TF ${bias.fusion.technical.timeframes.length}`
                        : `${bias.drivers.length}개 드라이버`}
                    </span>
                  </button>
                  {isExpanded && !(bias.fusion && !isManual) && (
                    <div className="md-driver-list">
                      {bias.drivers.map((driver, index) => (
                        <div className="md-driver" key={`${driver.name}-${index}`}>
                          <span className={`md-driver-read ${readClass(driver.read)}`}>
                            {readLabel(driver.read)}
                          </span>
                          <span className="md-driver-body">
                            <b>{driver.name}</b>
                            <span>{driver.note}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              <input
                className="md-note"
                value={bias.note ?? bias.rationale}
                placeholder="근거 메모"
                onChange={(event) => setNote(asset.id, event.target.value)}
                aria-label={`${asset.name} 근거 메모`}
              />
              <div className="md-driver-names">{asset.drivers}</div>
            </section>
          );
        })}
      </main>

      {payload.scoreboard && <ScoreboardPanel board={payload.scoreboard} />}

      <section className="md-timeline">
        <div className="md-section-title">
          세션 타임라인 <span>KST · DST 자동반영</span>
        </div>
        <div className="md-timeline-grid">
          {sessions.map((session) => (
            <div className="md-timeline-row" key={session.label}>
              <span className="md-timeline-label">{session.label}</span>
              <div className="md-timeline-track">
                {segsFor(session.open, session.close).map((segment, index) => (
                  <div
                    key={index}
                    className={`md-timeline-bar ${session.active ? "on" : ""}`}
                    style={{ left: `${segment.left}%`, width: `${segment.width}%` }}
                  />
                ))}
              </div>
            </div>
          ))}
          <div className="md-now" style={{ left: `${(nowK / 24) * 100}%` }}>
            <span>now</span>
          </div>
        </div>
        <div className="md-axis">
          {[0, 6, 12, 18, 24].map((hour) => (
            <span key={hour} style={{ left: `${(hour / 24) * 100}%` }}>
              {String(hour % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
      </section>

      <section className="md-events">
        <button
          className="md-events-toggle"
          onClick={() => setShowEvents((value) => !value)}
        >
          {showEvents ? "▾" : "▸"} 주요 지표 시각 (KST 환산)
          <span>바이어스 재검토 시점</span>
        </button>
        {showEvents && (
          <div className="md-event-list">
            {EVENTS.map((event) => {
              const off = tzOffsetHours(event.tz, now);
              const mins =
                Math.round(mod24(event.h + (9 - off)) * 60 + event.m) % 1440;
              const hh = String(Math.floor(mins / 60) % 24).padStart(2, "0");
              const mm = String(mins % 60).padStart(2, "0");
              return (
                <div className="md-event" key={event.label}>
                  <span className="md-event-time">
                    {hh}:{mm}
                  </span>
                  <span className="md-event-label">{event.label}</span>
                  <span className="md-event-note">{event.note}</span>
                </div>
              );
            })}
            <p>각 이벤트는 해당 발표일에만 유효 · 서머타임 자동환산</p>
          </div>
        )}
      </section>

      <footer className="md-footer">
        예약 분석은 <b>매크로·차트 융합 초안</b> · 체결과 시세 정본은 <b>MT5</b> · 방향은
        분석 좌표이며 주문·사이즈 결정을 대신하지 않음
        {payload.generatedAt && (
          <small>마지막 자동 갱신 {fmtKST(payload.generatedAt)}</small>
        )}
      </footer>
    </div>
  );
}
