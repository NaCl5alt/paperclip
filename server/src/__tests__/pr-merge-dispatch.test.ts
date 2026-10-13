import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  dispatchPrMergeWake,
  PR_LINKS_DOCUMENT_KEY,
  type PrMergeDispatchDeps,
} from "../services/pr-merge-dispatch.js";

// Service-layer unit tests (design §9). These exercise the system-action path directly: the
// real `queueIssueAssignmentWakeup` runs against a mocked `heartbeat.wakeup`, so cross-agent /
// unassigned targets are woken (or escalated) WITHOUT passing through the HTTP route guard that
// returns 403/409. The route guard regression tests (issue-agent-mutation-ownership-routes,
// issue-comment-reopen-routes) remain unchanged and continue to enforce 403/no-wake for agent
// actors.

const companyId = "11111111-1111-4111-8111-111111111111";
const targetIssueId = "22222222-2222-4222-8222-222222222222";
const assigneeAgentId = "33333333-3333-4333-8333-333333333333";
const otherGroupAgentId = "44444444-4444-4444-8444-444444444444";
const managerAgentId = "55555555-5555-4555-8555-555555555555";
const baseRevisionId = "66666666-6666-4666-8666-666666666666";

type LinkRecord = {
  repo: string;
  prNumber: number;
  prUrl?: string;
  headSha?: string;
  processedMergeShas?: string[];
};

function prLinksBody(records: LinkRecord[]): string {
  return ["# PR links", "", "```json", JSON.stringify({ links: records }, null, 2), "```", ""].join("\n");
}

function makeIssue(overrides: Partial<{ assigneeAgentId: string | null; status: string }> = {}) {
  return {
    id: targetIssueId,
    companyId,
    identifier: "TEST-99",
    title: "target",
    assigneeAgentId: "assigneeAgentId" in overrides ? overrides.assigneeAgentId ?? null : assigneeAgentId,
    status: overrides.status ?? "in_progress",
  };
}

function makeDeps(opts: {
  issue?: ReturnType<typeof makeIssue> | null;
  records?: LinkRecord[];
  prLinksDoc?: unknown;
  resolveEscalationTargets?: PrMergeDispatchDeps["resolveEscalationTargets"];
} = {}) {
  const issue = opts.issue === undefined ? makeIssue() : opts.issue;
  const records = opts.records ?? [{ repo: "owner/name", prNumber: 123, prUrl: "https://github.com/owner/name/pull/123", processedMergeShas: [] }];
  const prLinksDoc =
    opts.prLinksDoc === undefined
      ? {
          id: "doc-1",
          title: "pr-links",
          format: "markdown",
          body: prLinksBody(records),
          latestRevisionId: baseRevisionId,
        }
      : opts.prLinksDoc;

  const getById = vi.fn(async () => issue);
  const addComment = vi.fn(async () => ({ id: "comment-1" }));
  const getIssueDocumentByKey = vi.fn(async () => prLinksDoc);
  const upsertIssueDocument = vi.fn(async () => ({ created: false }));
  const wakeup = vi.fn(async () => undefined);
  const logActivity = vi.fn(async () => undefined);

  const deps = {
    issues: { getById, addComment },
    documents: { getIssueDocumentByKey, upsertIssueDocument },
    heartbeat: { wakeup },
    logActivity,
    resolveEscalationTargets: opts.resolveEscalationTargets,
  } as unknown as PrMergeDispatchDeps;

  return { deps, mocks: { getById, addComment, getIssueDocumentByKey, upsertIssueDocument, wakeup, logActivity } };
}

const baseKey = {
  repo: "owner/name",
  prNumber: 123,
  prUrl: "https://github.com/owner/name/pull/123",
  mergeCommitSha: "merge-sha-abc",
  merged: true,
};

describe("dispatchPrMergeWake", () => {
  beforeEach(() => vi.clearAllMocks());

  it("happy path: wakes the assignee via the system path, posts a system comment, writes back the SHA, audits", async () => {
    const { deps, mocks } = makeDeps();

    const result = await dispatchPrMergeWake(deps, {
      targetIssueId,
      prNaturalKey: baseKey,
      source: "webhook",
      routineRunId: "run-1",
      triggerId: "trigger-1",
    });

    expect(result.outcome).toBe("woken");

    // system-authored comment: actor is the empty object {} (→ authorType "system", guard 非経由).
    expect(mocks.addComment).toHaveBeenCalledTimes(1);
    const [commentIssueId, commentBody, commentActor, commentOptions] = mocks.addComment.mock.calls[0];
    expect(commentIssueId).toBe(targetIssueId);
    expect(commentActor).toEqual({});
    expect(commentOptions).toMatchObject({ authorType: "system" });
    expect(commentBody).toContain("paperclip:pr-merge-wake");

    // assignee wake carries system actor type.
    expect(mocks.wakeup).toHaveBeenCalledTimes(1);
    const [wokenAgentId, wakeOpts] = mocks.wakeup.mock.calls[0];
    expect(wokenAgentId).toBe(assigneeAgentId);
    expect(wakeOpts.requestedByActorType).toBe("system");

    // idempotency writeback (system authored: no createdBy*) with optimistic lock on baseRevisionId.
    expect(mocks.upsertIssueDocument).toHaveBeenCalledTimes(1);
    const writeArg = mocks.upsertIssueDocument.mock.calls[0][0];
    expect(writeArg.key).toBe(PR_LINKS_DOCUMENT_KEY);
    expect(writeArg.baseRevisionId).toBe(baseRevisionId);
    expect(writeArg.createdByAgentId ?? null).toBeNull();
    expect(writeArg.createdByUserId ?? null).toBeNull();
    expect(writeArg.body).toContain("merge-sha-abc");

    // audit fired from system actor.
    expect(mocks.logActivity).toHaveBeenCalledTimes(1);
    const auditArg = mocks.logActivity.mock.calls[0][0];
    expect(auditArg).toMatchObject({
      companyId,
      actorType: "system",
      actorId: "pr-merge-dispatcher",
      action: "dispatch.pr_merge_wake",
      entityType: "issue",
      entityId: targetIssueId,
    });
    expect(auditArg.details).toMatchObject({ outcome: "woken", source: "webhook", mergeCommitSha: "merge-sha-abc" });
  });

  it("redelivery: idempotent no-op when the merge SHA is already processed", async () => {
    const { deps, mocks } = makeDeps({
      records: [{ repo: "owner/name", prNumber: 123, prUrl: baseKey.prUrl, processedMergeShas: ["merge-sha-abc"] }],
    });

    const result = await dispatchPrMergeWake(deps, { targetIssueId, prNaturalKey: baseKey, source: "webhook" });

    expect(result.outcome).toBe("duplicate");
    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
    expect(mocks.upsertIssueDocument).not.toHaveBeenCalled();
    expect(mocks.logActivity.mock.calls[0][0].action).toBe("dispatch.pr_merge_duplicate");
  });

  it("closed-unmerged: ignored, no wake", async () => {
    const { deps, mocks } = makeDeps();

    const result = await dispatchPrMergeWake(deps, {
      targetIssueId,
      prNaturalKey: { ...baseKey, merged: false },
      source: "webhook",
    });

    expect(result.outcome).toBe("ignored_unmerged");
    expect(mocks.getIssueDocumentByKey).not.toHaveBeenCalled();
    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
    expect(mocks.logActivity.mock.calls[0][0].action).toBe("dispatch.pr_merge_ignored_unmerged");
  });

  // A late merge must not resurrect a closed or abandoned target.
  it.each(["done", "cancelled"])("terminal target (%s): ignored, no comment and no wake", async (status) => {
    const { deps, mocks } = makeDeps({ issue: makeIssue({ status }) });

    const result = await dispatchPrMergeWake(deps, { targetIssueId, prNaturalKey: baseKey, source: "webhook" });

    expect(result.outcome).toBe("ignored_terminal");
    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
    // No writeback: the decision is re-evaluated from scratch on redelivery (same as ignored_unmerged).
    expect(mocks.upsertIssueDocument).not.toHaveBeenCalled();
    const auditArg = mocks.logActivity.mock.calls[0][0];
    expect(auditArg.action).toBe("dispatch.pr_merge_ignored_terminal");
    expect(auditArg.actorType).toBe("system");
    expect(auditArg.details).toMatchObject({ outcome: "ignored_terminal", issueStatus: status });
  });

  it("merged PR with neither mergeCommitSha nor headSha: throws before any mutation", async () => {
    const { deps, mocks } = makeDeps();

    await expect(
      dispatchPrMergeWake(deps, {
        targetIssueId,
        prNaturalKey: { ...baseKey, mergeCommitSha: null, headSha: null },
        source: "webhook",
      }),
    ).rejects.toThrow(/missing both mergeCommitSha and headSha/);

    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
    expect(mocks.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("unmatched: null candidate performs no mutation", async () => {
    const { deps, mocks } = makeDeps();

    const result = await dispatchPrMergeWake(deps, { targetIssueId: null, prNaturalKey: baseKey, source: "webhook" });

    expect(result.outcome).toBe("unmatched");
    expect(mocks.getById).not.toHaveBeenCalled();
    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
    expect(mocks.logActivity).not.toHaveBeenCalled();
  });

  it("cross-group assigned-other: wakes without hitting the 403 guard", async () => {
    const { deps, mocks } = makeDeps({ issue: makeIssue({ assigneeAgentId: otherGroupAgentId }) });

    const result = await dispatchPrMergeWake(deps, { targetIssueId, prNaturalKey: baseKey, source: "webhook" });

    expect(result.outcome).toBe("woken");
    expect(mocks.addComment).toHaveBeenCalledTimes(1);
    expect(mocks.wakeup).toHaveBeenCalledTimes(1);
    expect(mocks.wakeup.mock.calls[0][0]).toBe(otherGroupAgentId);
    expect(mocks.wakeup.mock.calls[0][1].requestedByActorType).toBe("system");
  });

  it("unassigned: posts a system comment + manager mention, escalates via system wake, still writes back idempotency", async () => {
    const resolveEscalationTargets = vi.fn(async () => [{ agentId: managerAgentId, name: "Platform統括" }]);
    const { deps, mocks } = makeDeps({
      issue: makeIssue({ assigneeAgentId: null }),
      resolveEscalationTargets,
    });

    const result = await dispatchPrMergeWake(deps, { targetIssueId, prNaturalKey: baseKey, source: "webhook" });

    expect(result.outcome).toBe("unassigned_escalated");
    expect(result.escalatedAgentIds).toEqual([managerAgentId]);

    // marker comment posted with the manager mention.
    expect(mocks.addComment).toHaveBeenCalledTimes(1);
    expect(mocks.addComment.mock.calls[0][1]).toContain(`agent://${managerAgentId}`);

    // queueIssueAssignmentWakeup early-returns for an unassigned issue; only the manager escalation wake fires.
    expect(mocks.wakeup).toHaveBeenCalledTimes(1);
    expect(mocks.wakeup.mock.calls[0][0]).toBe(managerAgentId);
    expect(mocks.wakeup.mock.calls[0][1].requestedByActorType).toBe("system");

    // idempotency still written back so webhook redelivery does not re-mention.
    expect(mocks.upsertIssueDocument).toHaveBeenCalledTimes(1);
    expect(mocks.logActivity.mock.calls[0][0].action).toBe("dispatch.pr_merge_unassigned_escalated");
  });

  it("re-verify failure: PR record absent on pr-links → throws, no wake (Fail Securely)", async () => {
    const { deps, mocks } = makeDeps({
      records: [{ repo: "owner/name", prNumber: 999, processedMergeShas: [] }],
    });

    await expect(
      dispatchPrMergeWake(deps, { targetIssueId, prNaturalKey: baseKey, source: "webhook" }),
    ).rejects.toThrow(/re-verify failed/i);

    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
    expect(mocks.upsertIssueDocument).not.toHaveBeenCalled();
  });

  it("re-verify failure: missing pr-links document → throws, no wake", async () => {
    const { deps, mocks } = makeDeps({ prLinksDoc: null });

    await expect(
      dispatchPrMergeWake(deps, { targetIssueId, prNaturalKey: baseKey, source: "webhook" }),
    ).rejects.toThrow(/pr-links/i);

    expect(mocks.addComment).not.toHaveBeenCalled();
    expect(mocks.wakeup).not.toHaveBeenCalled();
  });
});
