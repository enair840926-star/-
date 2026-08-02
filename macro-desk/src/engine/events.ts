import type { AssetId, EventLayer, EventTier, EventWindow, MacroEventInput } from "./types";
import { EVENT_TIERS, MAX_VALID_HOURS } from "./weights";

const MINUTE = 60_000;
/** 화면 표기용으로 끌고 오는 최대 선행 시간 (확신도 상한 계산에는 쓰지 않는다) */
const DISPLAY_LOOKAHEAD_HOURS = 48;

/**
 * 이벤트 레이어. 티어별 블랙아웃 창을 만들고 유효구간 내 최고 티어로 컨피던스 상한을 정한다.
 * 방향 자체는 바꾸지 않는다 — 확신도와 진입 가능 시간대만 제한한다.
 */
export function computeEvents(
  asset: AssetId,
  events: MacroEventInput[],
  now: Date,
  horizonHours = MAX_VALID_HOURS,
): EventLayer {
  const flags: string[] = [];
  const horizonEnd = now.getTime() + horizonHours * 60 * MINUTE;
  const displayEnd = now.getTime() + DISPLAY_LOOKAHEAD_HOURS * 60 * MINUTE;
  const lookback = now.getTime() - 2 * 60 * MINUTE;
  const windows: EventWindow[] = [];

  for (const event of events ?? []) {
    if (event.assets?.length && !event.assets.includes(asset)) continue;
    const time = Date.parse(event.time);
    if (!Number.isFinite(time)) {
      flags.push(`EVENT_BAD_TIME:${event.label}`);
      continue;
    }
    const tier = ([1, 2, 3] as EventTier[]).includes(event.tier) ? event.tier : 1;
    const spec = EVENT_TIERS[tier];
    const blackoutStart = time - spec.before * MINUTE;
    const blackoutEnd = time + spec.after * MINUTE;
    if (blackoutEnd < lookback || blackoutStart > displayEnd) continue;
    windows.push({
      label: event.label,
      time: new Date(time).toISOString(),
      tier,
      note: event.note,
      blackoutStart: new Date(blackoutStart).toISOString(),
      blackoutEnd: new Date(blackoutEnd).toISOString(),
      minutesUntil: Math.round((time - now.getTime()) / MINUTE),
      active: now.getTime() >= blackoutStart && now.getTime() <= blackoutEnd,
    });
  }

  windows.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

  const activeBlackout = windows.find((window) => window.active) ?? null;
  // 확신도 상한은 유효구간(horizonHours) 안에 걸리는 이벤트만 반영한다.
  const relevant = windows.filter(
    (window) =>
      window.active ||
      (Date.parse(window.blackoutStart) >= now.getTime() &&
        Date.parse(window.blackoutStart) <= horizonEnd),
  );
  const maxTier = relevant.reduce<0 | EventTier>(
    (max, window) => (window.tier > max ? window.tier : max),
    0,
  );
  const convictionCap = maxTier === 0 ? 100 : EVENT_TIERS[maxTier].cap;

  const upcoming = windows
    .filter((window) => Date.parse(window.blackoutStart) > now.getTime())
    .map((window) => window.blackoutStart);

  if (activeBlackout) flags.push(`BLACKOUT_ACTIVE:${activeBlackout.label}`);
  if (maxTier === 3) flags.push("TIER1_EVENT_AHEAD");

  return {
    windows,
    headline: windows.find((window) => window.minutesUntil >= -30) ?? null,
    maxTier,
    activeBlackout,
    nextBlackoutStart: upcoming.length ? upcoming[0] : null,
    convictionCap,
    flags,
  };
}
