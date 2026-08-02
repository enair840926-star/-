/**
 * 감쇠 계산용 시장 시간.
 *
 * 팩터 신선도를 벽시계 시간으로 깎으면 주말 휴장 구간에서 과도하게 깎인다.
 * (금요일 종가 근거를 일요일에 읽으면 30시간 경과로 계산되지만 시장은 그동안 멈춰 있었다)
 * FX 기준 휴장 구간(금 21:00 UTC ~ 일 21:00 UTC)을 빼고 센다.
 */

const HOUR = 3_600_000;
const WEEKEND_CLOSE_HOUR_UTC = 21;
const WEEKEND_LENGTH_MS = 48 * HOUR;

/** from~to 사이에서 시장이 열려 있던 시간(시간 단위) */
export function marketHoursBetween(from: Date, to: Date): number {
  const start = from.getTime();
  const end = to.getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;

  let closed = 0;
  // 구간 시작 며칠 전부터 훑어 직전 금요일 휴장도 잡는다
  const cursor = new Date(start - 4 * 24 * HOUR);
  cursor.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end) {
    if (cursor.getUTCDay() === 5) {
      const closeStart = Date.UTC(
        cursor.getUTCFullYear(),
        cursor.getUTCMonth(),
        cursor.getUTCDate(),
        WEEKEND_CLOSE_HOUR_UTC,
      );
      const overlap =
        Math.min(end, closeStart + WEEKEND_LENGTH_MS) - Math.max(start, closeStart);
      if (overlap > 0) closed += overlap;
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return Math.max(0, (end - start - closed) / HOUR);
}
