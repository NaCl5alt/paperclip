import { describe, expect, it } from "vitest";
import { classifyBlockedWaitReason } from "../services/recovery/blocked-wait-reason.ts";

// nowMs anchor: 2026-09-08T00:00:00Z.
const NOW = Date.UTC(2026, 8, 8);

describe("classifyBlockedWaitReason", () => {
  it("classifies a year-less M/D reference as a future due_date", () => {
    const r = classifyBlockedWaitReason({
      description: "## 9/25 Step2 申し送り\n9/28 オーナーズV(個人) の原資戻し振替",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
    if (r.kind !== "due_date") throw new Error("unreachable");
    // Earliest future date wins: 9/25 before 9/28.
    expect(r.at.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("classifies an ISO date", () => {
    const r = classifyBlockedWaitReason({
      description: "2026-09-25 の期日待ち",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
    if (r.kind !== "due_date") throw new Error("unreachable");
    expect(r.at.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("classifies a Japanese full date", () => {
    const r = classifyBlockedWaitReason({
      description: "2026年9月25日に再開",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
  });

  it("reads the latest comment as well as the description", () => {
    const r = classifyBlockedWaitReason({
      description: "何らかの申し送り",
      latestComment: "日付待ちで blocked にする。10/01 に再開予定。",
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
    if (r.kind !== "due_date") throw new Error("unreachable");
    expect(r.at.toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it("does not treat a past date as a wait reason", () => {
    const r = classifyBlockedWaitReason({
      description: "2025-01-01 に着手済み",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("unclassifiable");
  });

  it("classifies a prose unblock owner/action marker as external_wait", () => {
    const r = classifyBlockedWaitReason({
      description: "停止中。unblock owner=orch-comm / action=(1)KiCad導入 (2)再実行",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("external_wait");
    if (r.kind !== "external_wait") throw new Error("unreachable");
    expect(r.owner).toBe("orch-comm");
    expect(r.action).toContain("KiCad");
  });

  it("external_wait wins over a bare date when both are present", () => {
    const r = classifyBlockedWaitReason({
      description: "unblock owner=orch-comm / action=install KiCad by 12/31",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("external_wait");
  });

  it("returns unclassifiable for empty text", () => {
    expect(classifyBlockedWaitReason({ description: "", latestComment: "", nowMs: NOW }).kind).toBe(
      "unclassifiable",
    );
  });

  it("returns unclassifiable for prose with no date and no marker", () => {
    const r = classifyBlockedWaitReason({
      description: "作業が詰まっているので一旦 blocked。",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("unclassifiable");
  });

  // Review B1 regression: fractions / ratios / versions / progress markers must NOT be
  // read as dates (they would set a bogus far-future monitor and suppress the nudge).
  it.each([
    ["Progress: 1/2 tasks done, waiting on teammate"],
    ["aspect 4/3 ratio"],
    ["split 2/3 done"],
    ["確率 3/4 で失敗"],
    ["v1/2 draft"],
  ])("does not treat fraction/ratio/version %s as a due_date", (desc) => {
    expect(classifyBlockedWaitReason({ description: desc, latestComment: null, nowMs: NOW }).kind).toBe(
      "unclassifiable",
    );
  });

  it("does not roll a recently-past year-less M/D forward a year (review B1)", () => {
    // 9/1 with now=9/8 must not become 2027-09-01.
    const r = classifyBlockedWaitReason({
      description: "作成 9/1 に blocked",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("unclassifiable");
  });

  it("accepts an ambiguous-day M/D only when a date cue is nearby", () => {
    // 10/3 (day<=12) alone is ambiguous -> unclassifiable...
    expect(
      classifyBlockedWaitReason({ description: "note 10/3 stuff", latestComment: null, nowMs: NOW }).kind,
    ).toBe("unclassifiable");
    // ...but with a cue it is a due_date.
    const r = classifyBlockedWaitReason({
      description: "10/3 予定で再開",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
    if (r.kind !== "due_date") throw new Error("unreachable");
    expect(r.at.toISOString()).toBe("2026-10-03T00:00:00.000Z");
  });

  it("accepts an unambiguous day (>12) M/D without a cue", () => {
    const r = classifyBlockedWaitReason({
      description: "9/25 Step2 申し送り",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
    if (r.kind !== "due_date") throw new Error("unreachable");
    expect(r.at.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });

  it("does not treat a bare owner:/action: pair without `unblock` as external_wait (review N1)", () => {
    const r = classifyBlockedWaitReason({
      description: "config:\n  owner: alice\n  action: refactor module",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("unclassifiable");
  });

  it("does not misread a YYYY/MM/DD as a spurious year-less M/D", () => {
    const r = classifyBlockedWaitReason({
      description: "作成: 2026/09/25 時点のメモ",
      latestComment: null,
      nowMs: NOW,
    });
    expect(r.kind).toBe("due_date");
    if (r.kind !== "due_date") throw new Error("unreachable");
    expect(r.at.toISOString()).toBe("2026-09-25T00:00:00.000Z");
  });
});
