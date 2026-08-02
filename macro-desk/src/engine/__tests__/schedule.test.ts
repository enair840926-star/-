import { describe, expect, it } from "vitest";
import {
  SNAPSHOT_GRACE_MS,
  snapshotSlots,
  snapshotStatus,
} from "../schedule";

const at = (iso: string) => new Date(iso);

/** KST 08:02 · 16:02 · 22:02 는 각각 UTC 23:02(전날) · 07:02 · 13:02 */
describe("snapshotSlots", () => {
  it("KST 08/16/22시를 UTC로 옮긴다", () => {
    const slots = snapshotSlots(at("2026-08-03T10:00:00Z"));
    const iso = slots.map((t) => new Date(t).toISOString());
    expect(iso).toContain("2026-08-03T07:02:00.000Z"); // 8/3 16:02 KST
    expect(iso).toContain("2026-08-03T13:02:00.000Z"); // 8/3 22:02 KST
    expect(iso).toContain("2026-08-02T23:02:00.000Z"); // 8/3 08:02 KST
  });

  it("오름차순이고 하루 3회씩 사흘치를 낸다", () => {
    const slots = snapshotSlots(at("2026-08-03T10:00:00Z"));
    expect(slots).toHaveLength(9);
    expect([...slots].sort((a, b) => a - b)).toEqual(slots);
  });

  it("KST 자정 직후에도 그날 슬롯을 포함한다", () => {
    // 8/3 00:30 KST = 8/2 15:30Z — 경계에서 날짜가 밀리면 안 된다
    const slots = snapshotSlots(at("2026-08-02T15:30:00Z"));
    const iso = slots.map((t) => new Date(t).toISOString());
    expect(iso).toContain("2026-08-02T23:02:00.000Z"); // 8/3 08:02 KST
  });
});

describe("snapshotStatus", () => {
  it("기준 시각이 없으면 null", () => {
    expect(snapshotStatus(null, at("2026-08-03T10:00:00Z"))).toBeNull();
    expect(snapshotStatus("", at("2026-08-03T10:00:00Z"))).toBeNull();
    expect(snapshotStatus("무효", at("2026-08-03T10:00:00Z"))).toBeNull();
  });

  it("방금 갱신됐으면 누락이 없고 다음 예정을 가리킨다", () => {
    // 8/3 16:02 KST 실행 직후, 12분 경과
    const status = snapshotStatus("2026-08-03T07:05:00Z", at("2026-08-03T07:17:00Z"));
    expect(status).not.toBeNull();
    expect(status!.missed).toBeNull();
    expect(status!.elapsedMs).toBe(12 * 60_000);
    expect(new Date(status!.next!).toISOString()).toBe("2026-08-03T13:02:00.000Z");
  });

  it("유예 안에서는 아직 누락으로 보지 않는다", () => {
    // 16:02 예정, 30분 지났고 스냅샷은 직전 회차(08:02) 것
    const status = snapshotStatus("2026-08-02T23:10:00Z", at("2026-08-03T07:32:00Z"));
    expect(status!.missed).toBeNull();
  });

  it("유예를 넘기면 그 회차를 누락으로 표시한다", () => {
    // 16:02 예정, 유예 45분을 넘긴 시점인데 스냅샷은 여전히 08:02 것
    const status = snapshotStatus("2026-08-02T23:10:00Z", at("2026-08-03T07:50:00Z"));
    expect(status!.missed).not.toBeNull();
    expect(new Date(status!.missed!).toISOString()).toBe("2026-08-03T07:02:00.000Z");
  });

  it("유예 경계에서 정확히 뒤집힌다", () => {
    const slot = Date.parse("2026-08-03T07:02:00Z");
    const stale = "2026-08-02T23:10:00Z";
    expect(snapshotStatus(stale, slot + SNAPSHOT_GRACE_MS - 1)!.missed).toBeNull();
    expect(snapshotStatus(stale, slot + SNAPSHOT_GRACE_MS)!.missed).toBe(slot);
  });

  it("여러 회차를 놓치면 가장 최근 예정 시각을 가리킨다", () => {
    // 8/2 22:09 이후 아무것도 안 돌고 8/3 16:02+유예까지 지났다
    const status = snapshotStatus("2026-08-02T13:09:00Z", at("2026-08-03T08:00:00Z"));
    expect(new Date(status!.missed!).toISOString()).toBe("2026-08-03T07:02:00.000Z");
  });

  it("기준 시각이 미래여도 경과는 음수가 되지 않는다", () => {
    const status = snapshotStatus("2026-08-03T09:00:00Z", at("2026-08-03T08:00:00Z"));
    expect(status!.elapsedMs).toBe(0);
  });
});
