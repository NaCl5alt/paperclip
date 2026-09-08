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
