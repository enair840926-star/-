/**
 * 스냅샷 예약 시각.
 *
 * 푸시 알림이 오지 않는 환경에서는 화면이 유일한 전달 경로다. 그러면 가장 위험한 건
 * **낡은 화면과 최신 화면이 똑같아 보이는 것**이다. 어제 것을 오늘 것으로 읽으면
 * 방향을 반대로 잡는다.
 *
 * 그래서 화면이 직접 말해야 한다 — 지금 보는 게 언제 기준인지, 예정된 갱신이 밀리지는
 * 않았는지. 판정은 여기서 결정적으로 한다.
 */

/** KST 기준 스냅샷 시각. 예약 루틴의 크론과 같아야 한다. */
export const SNAPSHOT_HOURS_KST = [8, 16, 22] as const;

/** 예약은 분산(stagger) 때문에 정시보다 몇 분 늦게 시작한다. */
export const SNAPSHOT_MINUTE = 2;

/**
 * 예정 시각 이후 이만큼은 기다려준다. 세션이 데이터를 모으고 커밋·배포까지 하는 데
 * 시간이 걸리므로, 이 안에 들어오면 정상이다.
 */
export const SNAPSHOT_GRACE_MS = 45 * 60_000;

const DAY_MS = 86_400_000;
const KST_OFFSET_MS = 9 * 3_600_000;

/**
 * `now` 전후 하루치 예약 시각을 UTC ms로 돌려준다 (오름차순).
 *
 * KST는 서머타임이 없어 UTC+9 고정이므로 오프셋 계산만으로 충분하다.
 */
export function snapshotSlots(now: Date | number): number[] {
  const nowMs = typeof now === "number" ? now : now.getTime();
  const kstMidnight =
    Math.floor((nowMs + KST_OFFSET_MS) / DAY_MS) * DAY_MS - KST_OFFSET_MS;
  const slots: number[] = [];
  for (let day = -1; day <= 1; day += 1) {
    for (const hour of SNAPSHOT_HOURS_KST) {
      slots.push(
        kstMidnight + day * DAY_MS + (hour * 60 + SNAPSHOT_MINUTE) * 60_000,
      );
    }
  }
  return slots.sort((a, b) => a - b);
}

export interface SnapshotStatus {
  /** 스냅샷 기준 시각 (UTC ms) */
  at: number;
  /** 지금까지 경과 (음수가 되지 않게 클램프) */
  elapsedMs: number;
  /** 다음 예정 시각. 없으면 null */
  next: number | null;
  /**
   * 유예 시간까지 지났는데 스냅샷이 그보다 오래된 예정 시각.
   * null이 아니면 그 회차 실행이 실패했거나 누락된 것이다.
   */
  missed: number | null;
}

/**
 * 스냅샷이 예정대로 갱신되고 있는지 판정한다.
 *
 * `generatedAt`이 비었거나 파싱할 수 없으면 null — 호출부가 "알 수 없음"으로 다룬다.
 */
export function snapshotStatus(
  generatedAt: string | number | null | undefined,
  now: Date | number,
): SnapshotStatus | null {
  if (generatedAt === null || generatedAt === undefined || generatedAt === "") {
    return null;
  }
  const at = typeof generatedAt === "number" ? generatedAt : Date.parse(generatedAt);
  if (!Number.isFinite(at)) return null;

  const nowMs = typeof now === "number" ? now : now.getTime();
  const slots = snapshotSlots(nowMs);

  const next = slots.find((slot) => slot > nowMs) ?? null;

  // 유예까지 지난 마지막 예정 시각. 스냅샷이 그보다 오래됐으면 그 회차를 놓친 것이다.
  let lastDue: number | null = null;
  for (const slot of slots) {
    if (slot + SNAPSHOT_GRACE_MS <= nowMs) lastDue = slot;
  }
  const missed = lastDue !== null && at < lastDue ? lastDue : null;

  return { at, elapsedMs: Math.max(0, nowMs - at), next, missed };
}
