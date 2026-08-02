/** 세션 경계 계산 (App.tsx와 동일한 규칙: 각 도시 현지 08:00 개장 / 17:00 폐장) */

export const SESSION_CITIES = [
  ["Asia/Tokyo", "아시아"],
  ["Europe/London", "런던"],
  ["America/New_York", "뉴욕"],
] as const;

export function tzOffsetHours(tz: string, date: Date): number {
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
  const parts: Record<string, string> = {};
  dtf.formatToParts(date).forEach((part) => {
    parts[part.type] = part.value;
  });
  const hour = parts.hour === "24" ? "00" : parts.hour;
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(hour),
    Number(parts.minute),
    Number(parts.second),
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
  const parts: Record<string, string> = {};
  dtf.formatToParts(date).forEach((part) => {
    parts[part.type] = part.value;
  });
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day) };
}

function instantFromCity(tz: string, y: number, m: number, d: number, hh: number, mm: number) {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  return guess - tzOffsetHours(tz, new Date(guess)) * 3_600_000;
}

export interface SessionBoundary {
  t: number;
  label: string;
  kind: "개장" | "폐장";
}

export function sessionBoundaries(now: Date): SessionBoundary[] {
  const out: SessionBoundary[] = [];
  for (let offset = -1; offset <= 2; offset += 1) {
    const base = new Date(now.getTime() + offset * 86_400_000);
    for (const [tz, label] of SESSION_CITIES) {
      const { y, m, d } = ymdInTz(tz, base);
      out.push({ t: instantFromCity(tz, y, m, d, 8, 0), label, kind: "개장" });
      out.push({ t: instantFromCity(tz, y, m, d, 17, 0), label, kind: "폐장" });
    }
  }
  return out
    .sort((a, b) => a.t - b.t)
    .filter((item, index, arr) => index === 0 || Math.abs(item.t - arr[index - 1].t) > 60_000);
}

export function nextSessionBoundary(now: Date): SessionBoundary | null {
  return sessionBoundaries(now).find((boundary) => boundary.t > now.getTime()) ?? null;
}
