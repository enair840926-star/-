/**
 * 휴대폰 알림 문구.
 *
 * 배너에는 앞 한두 줄만 보인다. 그래서 **첫 줄이 결론**이어야 한다 —
 * "오늘 볼 자산이 있나, 없나".
 *
 * 문구를 LLM이 매번 새로 쓰면 형식이 흔들린다. 스냅샷에서 결정적으로 만든다.
 */
import type { AssetId, Scoreboard, Snapshot, SnapshotAsset } from "./types";
import { ASSET_IDS } from "./types";

const MARK: Record<number, string> = {
  2: "▲▲",
  1: "▲",
  0: "·",
  [-1]: "▼",
  [-2]: "▼▼",
};

const WORD: Record<number, string> = {
  2: "강한 상승",
  1: "상승",
  0: "관망",
  [-1]: "하락",
  [-2]: "강한 하락",
};

function fmtKST(iso: string): string {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    hour12: false,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function lean(score: number): string {
  if (score >= 0.35) return "상승 쪽";
  if (score <= -0.35) return "하락 쪽";
  if (score > 0.08) return "미세 상승";
  if (score < -0.08) return "미세 하락";
  return "완전 중립";
}

/** 왜 이 방향인지 한 조각 */
function reason(asset: SnapshotAsset): string {
  const fusion = asset.fusion;
  if (!fusion) return "";
  const positive = fusion.macro.factors.filter((f) => f.contribution > 0);
  const negative = fusion.macro.factors.filter((f) => f.contribution < 0);
  const top = positive.sort((a, b) => b.contribution - a.contribution)[0];
  const bottom = negative.sort((a, b) => a.contribution - b.contribution)[0];

  if (fusion.direction !== 0) {
    const driver = fusion.direction > 0 ? top : bottom;
    const against = fusion.direction > 0 ? bottom : top;
    const parts = [driver ? `${driver.label} 주도` : "복합 요인"];
    if (against) parts.push(`반대 ${against.label}`);
    return parts.join(" · ");
  }
  if (top && bottom) return `${top.label} vs ${bottom.label} 상충`;
  return "주도 요인 없음";
}

/** 가격이 편향에 동의하는지 */
function priceNote(asset: SnapshotAsset): string {
  const position = asset.fusion?.position;
  if (!position || position.movePct === null) return "";
  if (position.relation === "확인") {
    return ` · 가격 ${position.movePct > 0 ? "+" : ""}${position.movePct.toFixed(1)}% 동조`;
  }
  if (position.relation === "반증") {
    return ` · 가격 ${position.movePct > 0 ? "+" : ""}${position.movePct.toFixed(1)}% 역행`;
  }
  return "";
}

/** 무엇을 보고 확인·무효 판단할지 */
function levelLine(asset: SnapshotAsset): string | null {
  const fusion = asset.fusion;
  const levels = fusion?.levels;
  if (!fusion || !levels) return null;
  const resistance = levels.resistance?.length ? Math.min(...levels.resistance) : null;
  const support = levels.support?.length ? Math.max(...levels.support) : null;

  if (fusion.direction > 0) {
    const parts: string[] = [];
    if (resistance !== null) parts.push(`${resistance} 돌파 시 강화`);
    if (support !== null) parts.push(`${support} 이탈 시 무효`);
    return parts.length ? parts.join(" / ") : null;
  }
  if (fusion.direction < 0) {
    const parts: string[] = [];
    if (support !== null) parts.push(`${support} 이탈 시 강화`);
    if (resistance !== null) parts.push(`${resistance} 회복 시 무효`);
    return parts.length ? parts.join(" / ") : null;
  }
  if (support !== null && resistance !== null) return `${support} ~ ${resistance} 이탈 시 재확인`;
  return null;
}

function scoreboardLine(scoreboard: Scoreboard | undefined): string {
  if (!scoreboard || !scoreboard.total.n) return "적중률 집계 전";
  const rate = Math.round((scoreboard.total.rate ?? 0) * 100);
  const mid = scoreboard.byConviction["40-54"];
  const high = scoreboard.byConviction["55-69"];
  const n = (mid?.n ?? 0) + (high?.n ?? 0);
  const hit = (mid?.hit ?? 0) + (high?.hit ?? 0);
  const tail = n > 0 ? ` · 확신 40+ ${Math.round((hit / n) * 100)}%` : "";
  return `적중률 ${scoreboard.total.n}건 ${rate}%${tail}`;
}

/**
 * 알림 본문. 첫 줄은 배너에 그대로 뜨므로 결론만 담는다.
 */
export function renderNotification(snapshot: Snapshot): string {
  const entries = ASSET_IDS.map((id) => ({ id, asset: snapshot.assets[id] })).filter(
    (entry): entry is { id: AssetId; asset: SnapshotAsset } => Boolean(entry.asset),
  );
  if (!entries.length) return "스냅샷에 자산이 없습니다";

  const blackout = entries.find((entry) => entry.asset.fusion?.events.activeBlackout);
  const directional = entries
    .filter((entry) => (entry.asset.direction ?? 0) !== 0)
    .sort((a, b) => (b.asset.fusion?.conviction ?? 0) - (a.asset.fusion?.conviction ?? 0));
  const neutral = entries.filter((entry) => (entry.asset.direction ?? 0) === 0);

  // ── 첫 줄: 결론 ──
  const lines: string[] = [];
  if (blackout) {
    const window = blackout.asset.fusion!.events.activeBlackout!;
    lines.push(`⛔ ${window.label} 영향권 — ${fmtKST(window.blackoutEnd)}까지 판단 보류`);
  } else if (directional.length) {
    const head = directional
      .map(
        (entry) =>
          `${MARK[entry.asset.direction ?? 0]} ${entry.id} ${WORD[entry.asset.direction ?? 0]} ${
            entry.asset.fusion?.conviction ?? 0
          }`,
      )
      .join(" · ");
    lines.push(neutral.length ? `${head} · 나머지 ${neutral.length}종 관망` : head);
  } else {
    lines.push(`· 전 종목 관망 ${entries.length}/${entries.length} — 방향 없음`);
  }
  lines.push("");

  // ── 자산별 ──
  for (const entry of [...directional, ...neutral]) {
    const direction = entry.asset.direction ?? 0;
    const fusion = entry.asset.fusion;
    const conviction = String(fusion?.conviction ?? 0).padStart(2);
    const tail = direction === 0 ? ` (${lean(fusion?.score ?? 0)})` : priceNote(entry.asset);
    lines.push(
      `${MARK[direction]} ${entry.id.padEnd(6)} ${conviction}  ${reason(entry.asset)}${tail}`,
    );
    const level = levelLine(entry.asset);
    if (level) lines.push(`             ${level}`);
  }

  // ── 이벤트 ──
  const headline = entries
    .map((entry) => entry.asset.fusion?.events.headline)
    .filter((window): window is NonNullable<typeof window> => Boolean(window))
    .sort((a, b) => a.minutesUntil - b.minutesUntil)[0];
  if (headline && headline.minutesUntil > 0 && headline.minutesUntil < 36 * 60) {
    const tierWord = headline.tier === 3 ? "1급" : headline.tier === 2 ? "2급" : "3급";
    lines.push("", `⚡ ${fmtKST(headline.time)} ${headline.label} (${tierWord}) — 전후 판단 보류`);
  }

  lines.push("", scoreboardLine(snapshot.scoreboard));
  return lines.join("\n");
}
