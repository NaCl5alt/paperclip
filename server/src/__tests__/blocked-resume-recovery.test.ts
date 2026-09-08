import { randomUUID } from "node:crypto";
import { eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  approvals,
  companies,
  createDb,
  environmentLeases,
  environments,
  heartbeatRunEvents,
  heartbeatRuns,
  issueApprovals,
  issueComments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issueTreeHolds,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentFirstHeartbeat = vi.hoisted(() => vi.fn());
const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Resumed blocked work.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return { ...actual, trackAgentFirstHeartbeat: mockTrackAgentFirstHeartbeat };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({ supportsLocalAgentJwt: false, execute: mockAdapterExecute })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { issueService } from "../services/issues.ts";
import {
  MAX_BLOCKED_RESUMES_PER_ISSUE,
  MIN_BLOCKED_PARK_AGE_MS,
  classifyBlockedWait,
  decideBlockedResume,
  isResumableBlockedWait,
  statusChangeActivityFields,
  type BlockedWaitSignals,
} from "../services/recovery/blocked-wait.ts";

const NOW = new Date("2026-09-08T00:00:00.000Z");

function signals(overrides: Partial<BlockedWaitSignals> = {}): BlockedWaitSignals {
  return {
    unresolvedBlockerCount: 0,
    pendingInteractionCount: 0,
    pendingApprovalCount: 0,
    monitorNextCheckAt: null,
    hasActiveRecoveryAction: false,
    hasActiveExecutionPath: false,
    isPauseHeld: false,
    now: NOW,
    ...overrides,
  };
}

describe("classifyBlockedWait", () => {
  it("treats an issue with no wait path at all as resumable", () => {
    const kind = classifyBlockedWait(signals());
    expect(kind).toBe("none");
    expect(isResumableBlockedWait(kind)).toBe(true);
  });

  it("does not resume any wait that still has an event coming", () => {
    const cases: Array<[string, Partial<BlockedWaitSignals>]> = [
      ["hold", { isPauseHeld: true }],
      ["execution", { hasActiveExecutionPath: true }],
      ["recovery", { hasActiveRecoveryAction: true }],
      ["approval", { pendingInteractionCount: 1 }],
      ["approval", { pendingApprovalCount: 1 }],
      ["dependency", { unresolvedBlockerCount: 1 }],
      ["observation", { monitorNextCheckAt: new Date(NOW.getTime() + 60_000) }],
    ];
    for (const [expected, override] of cases) {
      const kind = classifyBlockedWait(signals(override));
      expect(kind).toBe(expected);
      expect(isResumableBlockedWait(kind)).toBe(false);
    }
  });

  it("ignores a monitor check that is already due, because that wake has come and gone", () => {
    expect(classifyBlockedWait(signals({ monitorNextCheckAt: new Date(NOW.getTime() - 1) }))).toBe("none");
  });

  it("reports the strongest reason first so the recorded reason is the one that would be violated", () => {
    expect(
      classifyBlockedWait(
        signals({ isPauseHeld: true, hasActiveExecutionPath: true, unresolvedBlockerCount: 3 }),
      ),
    ).toBe("hold");
    expect(classifyBlockedWait(signals({ pendingApprovalCount: 1, unresolvedBlockerCount: 3 }))).toBe("approval");
  });
});

describe("statusChangeActivityFields", () => {
  it("reports a park only when the write actually parked the issue", () => {
    expect(statusChangeActivityFields({ previousStatus: "in_progress", writtenStatus: "blocked" })).toEqual({
      status: "blocked",
      previousStatus: "in_progress",
      currentStatus: "blocked",
    });
  });

  it("does not re-announce a park on an issue that was already blocked", () => {
    // readBlockedResumeHistory picks park rows out of activity by `details.status`, so a row
    // claiming a park that did not happen restarts the settling window and hands back that
    // park's resume allowance. Escalations that only add a blocker must not claim one.
    const fields = statusChangeActivityFields({ previousStatus: "blocked", writtenStatus: "blocked" });
    expect(fields).not.toHaveProperty("status");
    expect(fields).not.toHaveProperty("previousStatus");
    expect(fields).toEqual({ currentStatus: "blocked" });
  });

  it("reports where the issue is even when the write left the status alone", () => {
    const fields = statusChangeActivityFields({ previousStatus: "blocked" });
    expect(fields).not.toHaveProperty("status");
    expect(fields).toEqual({ currentStatus: "blocked" });
  });
});

describe("decideBlockedResume", () => {
  const parkedAt = new Date("2026-09-01T00:00:00.000Z");
  const later = new Date(parkedAt.getTime() + MIN_BLOCKED_PARK_AGE_MS + 60_000);

  function history(overrides: Partial<Parameters<typeof decideBlockedResume>[0]> = {}) {
    return {
      resumeAts: [],
      lastBlockedEntryAt: parkedAt,
      issueUpdatedAt: parkedAt,
      now: later,
      ...overrides,
    };
  }

  it("resumes a fresh park", () => {
    expect(decideBlockedResume(history())).toEqual({ resume: true });
  });

  it("is idempotent across duplicate events within one park", () => {
    const resumedAt = new Date(parkedAt.getTime() + 1_000);
    expect(decideBlockedResume(history({ resumeAts: [resumedAt] }))).toEqual({
      resume: false,
      reason: "already_resumed_this_park",
    });
  });

  it("allows one resume per park after the issue is parked again", () => {
    const firstResume = new Date(parkedAt.getTime() + 1_000);
    const reparkedAt = new Date(parkedAt.getTime() + 2_000);
    expect(
      decideBlockedResume(history({ resumeAts: [firstResume], lastBlockedEntryAt: reparkedAt })),
    ).toEqual({ resume: true });
  });

  it("stops the ping-pong after exactly three lifetime resumes", () => {
    // Literal counts on purpose: deriving them from MAX_BLOCKED_RESUMES_PER_ISSUE would make this
    // test follow the constant anywhere, pinning the branch but never the value.
    expect(MAX_BLOCKED_RESUMES_PER_ISSUE).toBe(3);
    const resumeAt = (index: number) => new Date(parkedAt.getTime() - (index + 1) * 1_000);
    const reparkedAt = new Date(parkedAt.getTime() + 5_000);

    expect(
      decideBlockedResume(
        history({ resumeAts: [resumeAt(0), resumeAt(1)], lastBlockedEntryAt: reparkedAt }),
      ),
    ).toEqual({ resume: true });

    expect(
      decideBlockedResume(
        history({ resumeAts: [resumeAt(0), resumeAt(1), resumeAt(2)], lastBlockedEntryAt: reparkedAt }),
      ),
    ).toEqual({ resume: false, reason: "resume_budget_exhausted" });
  });

  it("fails safe when the park time is unknown but a resume already happened", () => {
    expect(decideBlockedResume(history({ resumeAts: [parkedAt], lastBlockedEntryAt: null }))).toEqual({
      resume: false,
      reason: "already_resumed_this_park",
    });
  });

  it("waits out the settling window so it cannot undo a park that just happened", () => {
    const justParked = new Date(later.getTime() - 1_000);
    expect(decideBlockedResume(history({ lastBlockedEntryAt: justParked }))).toEqual({
      resume: false,
      reason: "parked_too_recently",
    });
    // With no activity row recording the park, the issue's own updatedAt has to bound the age.
    expect(
      decideBlockedResume(history({ lastBlockedEntryAt: null, issueUpdatedAt: justParked })),
    ).toEqual({ resume: false, reason: "parked_too_recently" });
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

/**
 * Resumes enqueue real wakes, so the heartbeat starts dispatching runs against the test
 * database. Park them before truncating, otherwise cleanup races live queries.
 */
async function retryCleanup(step: () => Promise<void>, attempts = 6) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await step();
      return;
    } catch (error) {
      if (attempt === attempts - 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function cancelActiveRunsForCleanup(db: ReturnType<typeof createDb>, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const activeRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(or(eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.status, "running")));
    if (activeRuns.length === 0) return;
    const now = new Date();
    await db
      .update(heartbeatRuns)
      .set({
        status: "cancelled",
        finishedAt: now,
        updatedAt: now,
        errorCode: "test_cleanup",
        error: "Cancelled by blocked-resume test cleanup",
        processPid: null,
        processGroupId: null,
      })
      .where(inArray(heartbeatRuns.id, activeRuns.map((run) => run.id)));
    const wakeupRequestIds = activeRuns
      .map((run) => run.wakeupRequestId)
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (wakeupRequestIds.length > 0) {
      await db
        .update(agentWakeupRequests)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now })
        .where(inArray(agentWakeupRequests.id, wakeupRequestIds));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describeEmbeddedPostgres("blocked issue resume mechanism", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-blocked-resume-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 20_000);

  afterEach(async () => {
    vi.clearAllMocks();
    await cancelActiveRunsForCleanup(db);
    // Everything seeded here hangs off `companies`, and dispatch may still be finalizing a run,
    // so truncate the whole company subtree in one statement with a short retry instead of
    // hand-ordering a dozen deletes.
    await retryCleanup(async () => {
      await db.execute(sql`truncate table companies, activity_log cascade`);
    });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  describe("cancelled blockers resolve their dependents", () => {
  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedAgent(companyId: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  it("reports a cancelled blocker as resolved and names it separately", async () => {
    const companyId = await seedCompany();
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      { id: dependentId, companyId, title: "Dependent", status: "blocked", priority: "medium" },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      unresolvedBlockerCount: 1,
      cancelledBlockerIssueIds: [],
      isDependencyReady: false,
    });

    await svc.update(blockerId, { status: "cancelled" });

    await expect(svc.getDependencyReadiness(dependentId)).resolves.toMatchObject({
      blockerIssueIds: [blockerId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      cancelledBlockerIssueIds: [blockerId],
      isDependencyReady: true,
    });
  });

  it("lets a dependent start once its only blocker is cancelled", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "cancelled", priority: "medium" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // Before the fix this threw `Issue is blocked by unresolved blockers`, and since a cancelled
    // blocker can never reach `done` the dependent could never start again.
    await expect(svc.update(dependentId, { status: "in_progress" })).resolves.toMatchObject({
      status: "in_progress",
    });
  });

  it("wakes dependents of a blocker that is cancelled rather than completed", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([]);

    await svc.update(blockerId, { status: "cancelled" });

    await expect(svc.listWakeableBlockedDependents(blockerId)).resolves.toEqual([
      expect.objectContaining({
        id: dependentId,
        assigneeAgentId: agentId,
        blockerIssueIds: [blockerId],
        cancelledBlockerIssueIds: [blockerId],
      }),
    ]);
  });

  it("keeps blocker relations when an update omits blockedByIssueIds", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);
    const blockerId = randomUUID();
    const dependentId = randomUUID();
    await db.insert(issues).values([
      { id: blockerId, companyId, title: "Blocker", status: "todo", priority: "medium" },
      {
        id: dependentId,
        companyId,
        title: "Dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: agentId,
      },
    ]);
    await svc.update(dependentId, { blockedByIssueIds: [blockerId] });

    // A comment-only / title-only write must not be read as "this issue now has no blockers".
    await svc.update(dependentId, { title: "Dependent (renamed)" });
    await expect(svc.getRelationSummaries(dependentId)).resolves.toMatchObject({
      blockedBy: [expect.objectContaining({ id: blockerId })],
    });

    // An explicit empty array is still an explicit instruction to clear them.
    await svc.update(dependentId, { blockedByIssueIds: [] });
    await expect(svc.getRelationSummaries(dependentId)).resolves.toMatchObject({ blockedBy: [] });
  });
});

  describe("reconcileResumableBlockedIssues", () => {
  async function seedParkedIssue(overrides: Partial<typeof issues.$inferInsert> = {}) {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Engineer",
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Parked with no wait path",
      status: "blocked",
      priority: "medium",
      assigneeAgentId: agentId,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
      ...overrides,
    });
    // Park it well outside the settling window; a freshly parked issue is deliberately left alone.
    await db
      .update(issues)
      .set({ updatedAt: new Date(Date.now() - MIN_BLOCKED_PARK_AGE_MS - 60_000) })
      .where(eq(issues.id, issueId));
    return { companyId, agentId, issueId };
  }

  async function statusOf(issueId: string) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0]?.status ?? null);
  }

  async function resumeActivityCount(issueId: string) {
    return db
      .select({ details: activityLog.details })
      .from(activityLog)
      .where(eq(activityLog.entityId, issueId))
      .then((rows) =>
        rows.filter(
          (row) =>
            (row.details as Record<string, unknown> | null)?.source ===
            "recovery.reconcile_resumable_blocked_issue",
        ).length,
      );
  }

  it("returns an issue with no wait path to todo and wakes its assignee", async () => {
    const { issueId, agentId } = await seedParkedIssue();

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(1);
    expect(result.issueIds).toContain(issueId);
    expect(await statusOf(issueId)).toBe("todo");
    expect(await resumeActivityCount(issueId)).toBe(1);

    const wakes = await db
      .select({ agentId: agentWakeupRequests.agentId, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests);
    expect(wakes.some((wake) => wake.agentId === agentId)).toBe(true);

    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => (comment.body ?? "").includes("no wait path remained"))).toBe(true);
  });

  it("does not resume twice for the same park, including across a restart", async () => {
    const { issueId } = await seedParkedIssue();

    await heartbeatService(db).reconcileStrandedAssignedIssues();
    // Park it again by hand WITHOUT recording a new blocked entry, i.e. the resume is still the
    // most recent event. A fresh service instance stands in for a server restart: the decision
    // must come from durable history, not in-memory bookkeeping.
    // Retire the first resume's dispatch so neither a live run nor a queued wake can be what
    // stops the second sweep — the durable resume history has to be the thing doing the work.
    await cancelActiveRunsForCleanup(db);
    await db.update(agentWakeupRequests).set({ status: "cancelled", finishedAt: new Date() });
    // Backdate again so the settling window is not what stops the second sweep either.
    await db
      .update(issues)
      .set({ status: "blocked", updatedAt: new Date(Date.now() - MIN_BLOCKED_PARK_AGE_MS - 60_000) })
      .where(eq(issues.id, issueId));

    const second = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(second.resumableBlockedResumed).toBe(0);
    expect(second.issueIds).not.toContain(issueId);
    expect(await resumeActivityCount(issueId)).toBe(1);
  });

  it("leaves an issue alone while a first-class blocker is unresolved", async () => {
    const { companyId, issueId } = await seedParkedIssue();
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Live blocker",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerId,
      relatedIssueId: issueId,
      type: "blocks",
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("repairs a lost blocker-resolved wake once every blocker is terminal", async () => {
    const { companyId, issueId } = await seedParkedIssue();
    const issuePrefix = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]!.issuePrefix);
    const doneBlockerId = randomUUID();
    const cancelledBlockerId = randomUUID();
    await db.insert(issues).values([
      {
        id: doneBlockerId,
        companyId,
        title: "Done blocker",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
      {
        id: cancelledBlockerId,
        companyId,
        title: "Cancelled blocker",
        status: "cancelled",
        priority: "medium",
        issueNumber: 3,
        identifier: `${issuePrefix}-3`,
      },
    ]);
    await db.insert(issueRelations).values([
      { companyId, issueId: doneBlockerId, relatedIssueId: issueId, type: "blocks" },
      { companyId, issueId: cancelledBlockerId, relatedIssueId: issueId, type: "blocks" },
    ]);

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(1);
    expect(await statusOf(issueId)).toBe("todo");

    // The resume must not clear the blocker relations: `blockerAttention` and
    // `blocked_by_cancelled_issue` are derived from these rows, so deleting them would erase the
    // "a premise died, re-check it" signal the resume is handing over.
    const survivingBlockers = await db
      .select({ blockerIssueId: issueRelations.issueId })
      .from(issueRelations)
      .where(eq(issueRelations.relatedIssueId, issueId));
    expect(survivingBlockers.map((row) => row.blockerIssueId).sort()).toEqual(
      [doneBlockerId, cancelledBlockerId].sort(),
    );

    // ...and the comment has to name the cancelled blocker, since scheduling silently stopped
    // waiting on work that never actually happened.
    const comments = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comments.some((comment) => (comment.body ?? "").includes(`${issuePrefix}-3`))).toBe(true);
  });

  it("leaves an unanswered interaction waiting", async () => {
    const { companyId, agentId, issueId } = await seedParkedIssue();
    await db.insert(issueThreadInteractions).values({
      id: randomUUID(),
      companyId,
      issueId,
      kind: "request_confirmation",
      status: "pending",
      payload: { version: 1, prompt: "Ship it?" },
      createdByAgentId: agentId,
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("leaves an unanswered approval waiting", async () => {
    const { companyId, issueId } = await seedParkedIssue();
    const approvalId = randomUUID();
    await db.insert(approvals).values({
      id: approvalId,
      companyId,
      type: "request_board_approval",
      status: "pending",
      payload: { prompt: "Ship the migration?" },
    });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("leaves an issue under a pause hold alone", async () => {
    const { companyId, issueId } = await seedParkedIssue();
    await db.insert(issueTreeHolds).values({
      id: randomUUID(),
      companyId,
      rootIssueId: issueId,
      mode: "pause",
      status: "active",
      reason: "board paused this subtree by hand",
      releasePolicy: { strategy: "manual" },
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("leaves an issue owned by an active recovery action alone", async () => {
    const { companyId, agentId, issueId } = await seedParkedIssue();
    await db.insert(issueRecoveryActions).values({
      id: randomUUID(),
      companyId,
      sourceIssueId: issueId,
      kind: "stranded_issue_recovery",
      status: "active",
      ownerType: "agent",
      ownerAgentId: agentId,
      cause: "stranded_assigned_issue",
      fingerprint: `stranded_assigned_issue:${issueId}`,
      nextAction: "restore a live execution path",
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("leaves a scheduled observation waiting", async () => {
    const { issueId } = await seedParkedIssue({
      monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("does not race a live run that is already holding the issue", async () => {
    const { companyId, agentId, issueId } = await seedParkedIssue();
    await db.insert(heartbeatRuns).values({
      id: randomUUID(),
      companyId,
      agentId,
      status: "running",
      trigger: "automation",
      contextSnapshot: { issueId },
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("counts every past resume, not just the most recent rows", async () => {
    const { companyId, issueId } = await seedParkedIssue();
    // Three resumes already spent, each followed by unrelated chatter. The lifetime budget is
    // only correct if the history read reaches past that chatter to all three; a window that
    // stops early undercounts and hands out a fourth resume.
    for (let index = 0; index < 3; index += 1) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "todo", source: "recovery.reconcile_resumable_blocked_issue" },
      });
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "system",
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details: { status: "blocked" },
      });
    }
    // Re-park older than the settling window so only the budget can be what stops the resume.
    await db
      .update(issues)
      .set({ updatedAt: new Date(Date.now() - MIN_BLOCKED_PARK_AGE_MS - 60_000) })
      .where(eq(issues.id, issueId));
    await db
      .update(activityLog)
      .set({ createdAt: new Date(Date.now() - MIN_BLOCKED_PARK_AGE_MS - 30_000) })
      .where(eq(activityLog.entityId, issueId));

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("sees a park recorded under any activity action, not just issue.updated", async () => {
    const { companyId, issueId } = await seedParkedIssue();
    // Some escalations record the park under their own action name (e.g.
    // `issue.successful_run_handoff_escalated`). If park detection keys off the action name it
    // misses these, reads the park as much older than it is, and resumes inside the window.
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.successful_run_handoff_escalated",
      entityType: "issue",
      entityId: issueId,
      details: { status: "blocked", _previous: { status: "in_progress" } },
    });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("leaves an approval waiting in every non-terminal approval status", async () => {
    for (const status of ["pending", "revision_requested"]) {
      const { companyId, issueId } = await seedParkedIssue();
      const approvalId = randomUUID();
      await db.insert(approvals).values({
        id: approvalId,
        companyId,
        type: "request_board_approval",
        status,
        payload: { prompt: "Ship it?" },
      });
      await db.insert(issueApprovals).values({ companyId, issueId, approvalId });

      const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

      expect(result.resumableBlockedResumed, `approval status ${status}`).toBe(0);
      expect(await statusOf(issueId), `approval status ${status}`).toBe("blocked");
      await cancelActiveRunsForCleanup(db);
      await db.execute(sql`truncate table companies, activity_log cascade`);
    }
  });

  it("leaves a recovery action waiting in every non-terminal action status", async () => {
    for (const status of ["active", "escalated"]) {
      const { companyId, agentId, issueId } = await seedParkedIssue();
      await db.insert(issueRecoveryActions).values({
        id: randomUUID(),
        companyId,
        sourceIssueId: issueId,
        kind: "stranded_issue_recovery",
        status,
        ownerType: "agent",
        ownerAgentId: agentId,
        cause: "stranded_assigned_issue",
        fingerprint: `stranded_assigned_issue:${issueId}`,
        nextAction: "restore a live execution path",
      });

      const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

      expect(result.resumableBlockedResumed, `recovery status ${status}`).toBe(0);
      expect(await statusOf(issueId), `recovery status ${status}`).toBe("blocked");
      await cancelActiveRunsForCleanup(db);
      await db.execute(sql`truncate table companies, activity_log cascade`);
    }
  });

  it("leaves a freshly parked issue alone until the settling window passes", async () => {
    const { issueId } = await seedParkedIssue();
    await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("skips issues with no assignee agent", async () => {
    const { issueId } = await seedParkedIssue({ assigneeAgentId: null });

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });
});
});
