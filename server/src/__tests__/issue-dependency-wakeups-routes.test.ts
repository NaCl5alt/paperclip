import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockWakeup = vi.hoisted(() => vi.fn(async () => undefined));
const mockFindExistingIssueBlockersResolvedWake = vi.hoisted(() => vi.fn(async () => null));
const mockIssueService = vi.hoisted(() => ({
  getAncestors: vi.fn(),
  getById: vi.fn(),
  getByIdForUpdate: vi.fn(),
  getByIdentifier: vi.fn(async () => null),
  getComment: vi.fn(),
  getCommentCursor: vi.fn(),
  getRelationSummaries: vi.fn(),
  update: vi.fn(),
  getDependencyReadiness: vi.fn(),
  listWakeableBlockedDependents: vi.fn(),
  getWakeableParentAfterChildCompletion: vi.fn(),
  getDependencyReadiness: vi.fn(),
  findMentionedAgents: vi.fn(async () => []),
}));

function readiness(overrides: Record<string, unknown> = {}) {
  return {
    issueId: "issue-2",
    blockerIssueIds: [],
    unresolvedBlockerIssueIds: [],
    unresolvedBlockerCount: 0,
    pendingFinalizeBlockerIssueIds: [],
    cancelledBlockerIssueIds: [],
    allBlockersDone: true,
    isDependencyReady: true,
    ...overrides,
  };
}

vi.mock("../services/index.js", () => ({
  companyService: () => ({
    getById: vi.fn(async () => ({ id: "company-1", attachmentMaxBytes: 10 * 1024 * 1024 })),
  }),
  accessService: () => ({
    canUser: vi.fn(),
    hasPermission: vi.fn(),
  }),
  agentService: () => ({
    getById: vi.fn(),
  }),
  companySkillService: () => ({
    completeTestRunForIssue: vi.fn(async () => null),
  }),
  documentAnnotationService: () => ({ remapOpenThreadsForDocument: async () => [] }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(),
  }),
  feedbackService: () => ({}),
  goalService: () => ({
    getById: vi.fn(),
    getDefaultCompanyGoal: vi.fn(),
  }),
  heartbeatService: () => ({
    wakeup: mockWakeup,
    reportRunActivity: vi.fn(async () => undefined),
    // Cancelling an issue makes the route look for a run to stop first.
    getRun: vi.fn(async () => null),
    getActiveRunForAgent: vi.fn(async () => null),
    cancelRun: vi.fn(async () => null),
  }),
  getIssueContinuationSummaryDocument: vi.fn(async () => null),
  instanceSettingsService: () => ({
    get: vi.fn(),
    listCompanyIds: vi.fn(),
  }),
  issueApprovalService: () => ({}),
  issueReferenceService: () => ({
    deleteDocumentSource: async () => undefined,
    diffIssueReferenceSummary: () => ({
      addedReferencedIssues: [],
      removedReferencedIssues: [],
      currentReferencedIssues: [],
    }),
    emptySummary: () => ({ outbound: [], inbound: [] }),
    listIssueReferenceSummary: async () => ({ outbound: [], inbound: [] }),
    syncComment: async () => undefined,
    syncDocument: async () => undefined,
    syncIssue: async () => undefined,
  }),
  issueRecoveryActionService: () => ({
    getActiveForIssue: vi.fn(async () => null),
    listActiveForIssues: vi.fn(async () => new Map()),
  }),
  issueThreadInteractionService: () => ({
    listForIssue: vi.fn(async () => []),
    expirePendingInteractionsForTerminalIssue: vi.fn(async () => []),
    expireRequestConfirmationsSupersededByComment: vi.fn(async () => []),
    expireStaleRequestConfirmationsForIssueDocument: vi.fn(async () => []),
  }),
  issueService: () => mockIssueService,
  logActivity: vi.fn(async () => undefined),
  projectService: () => ({
    getById: vi.fn(),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => ({
    listForIssue: vi.fn(async () => []),
  }),
}));

vi.mock("../services/issue-dependency-wakeups.js", async () => {
  const actual = await vi.importActual<typeof import("../services/issue-dependency-wakeups.js")>(
    "../services/issue-dependency-wakeups.js",
  );
  return {
    ...actual,
    findExistingIssueBlockersResolvedWake: mockFindExistingIssueBlockersResolvedWake,
  };
});

async function createApp() {
  const emptyRows: unknown[] = [];
  const whereResult = {
    limit: vi.fn(async () => emptyRows),
    then: async (resolve: (rows: unknown[]) => unknown) => resolve(emptyRows),
  };
  const query: Record<string, unknown> = {};
  query.innerJoin = vi.fn(() => query);
  query.where = vi.fn(() => whereResult);
  const routeDb = {
    select: vi.fn(() => ({
      from: vi.fn(() => query),
    })),
    transaction: async (callback: (tx: Record<string, never>) => Promise<unknown>) => callback({}),
  };
  const [{ issueRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/issues.js")>("../routes/issues.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes(routeDb as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("issue dependency wakeups in issue routes", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../routes/issues.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    vi.clearAllMocks();
    mockFindExistingIssueBlockersResolvedWake.mockResolvedValue(null);
    mockIssueService.getAncestors.mockResolvedValue([]);
    mockIssueService.getByIdForUpdate.mockImplementation(async () => mockIssueService.getById());
    mockIssueService.getComment.mockResolvedValue(null);
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockIssueService.getRelationSummaries.mockResolvedValue({ blockedBy: [], blocks: [] });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: "issue-1",
      blockerIssueIds: [],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([]);
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue(null);
    mockIssueService.getDependencyReadiness.mockResolvedValue(readiness());
  });

  it("wakes dependents when the final blocker transitions to done", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-100",
      title: "Finish blocker",
      description: null,
      status: "done",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-3"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
          }),
        }),
      );
    });
  });

  it("wakes an assigned blocked issue when blockers are applied after the blocker is already done", async () => {
    const parentIssueId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const childIssueId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    mockIssueService.getById.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "todo",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: parentIssueId,
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Blocked after completion",
      description: null,
      status: "blocked",
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getDependencyReadiness.mockResolvedValue({
      issueId: parentIssueId,
      blockerIssueIds: [childIssueId],
      unresolvedBlockerIssueIds: [],
      unresolvedBlockerCount: 0,
      pendingFinalizeBlockerIssueIds: [],
      allBlockersDone: true,
      isDependencyReady: true,
    });

    const res = await request(await createApp())
      .patch(`/api/issues/${parentIssueId}`)
      .send({
        status: "blocked",
        blockedByIssueIds: [childIssueId],
        unblockDescriptor: { owner: "board", action: "Review the restored dependency" },
      });

    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: parentIssueId,
            resolvedBlockerIssueId: childIssueId,
            mutation: "blocked_dependency_restored",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blockers_restored",
          }),
        }),
      );
    });
  });

  it("wakes the parent when all direct children become terminal", async () => {
    mockIssueService.getById.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "in_progress",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.update.mockResolvedValue({
      id: "child-1",
      companyId: "company-1",
      identifier: "PAP-101",
      title: "Last child",
      description: null,
      status: "done",
      priority: "medium",
      parentId: "parent-1",
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    });
    mockIssueService.getWakeableParentAfterChildCompletion.mockResolvedValue({
      id: "parent-1",
      assigneeAgentId: "agent-9",
      childIssueIds: ["child-0", "child-1"],
      childIssueSummaries: [
        {
          id: "child-0",
          identifier: "PAP-100",
          title: "First child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:00:00.000Z"),
          summary: "First child finished.",
        },
        {
          id: "child-1",
          identifier: "PAP-101",
          title: "Last child",
          status: "done",
          priority: "medium",
          assigneeAgentId: "agent-1",
          assigneeUserId: null,
          updatedAt: new Date("2026-04-18T12:05:00.000Z"),
          summary: "Last child finished.",
        },
      ],
      childIssueSummaryTruncated: false,
    });

    const res = await request(await createApp()).patch("/api/issues/child-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-9",
        expect.objectContaining({
          reason: "issue_children_completed",
          payload: expect.objectContaining({
            issueId: "parent-1",
            completedChildIssueId: "child-1",
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-101", summary: "Last child finished." }),
            ]),
          }),
          contextSnapshot: expect.objectContaining({
            childIssueSummaries: expect.arrayContaining([
              expect.objectContaining({ identifier: "PAP-100", summary: "First child finished." }),
            ]),
          }),
        }),
      );
    });
  });

  function blockedTransitionIssue(status: "in_progress" | "blocked") {
    return {
      id: "issue-2",
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Dependent",
      description: null,
      status,
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-2",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    };
  }

  it("re-arms the blockers-resolved wake when a dependent is set to blocked while its blocker is already done", async () => {
    mockIssueService.getById.mockResolvedValue(blockedTransitionIssue("in_progress"));
    mockIssueService.update.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue(
      readiness({ blockerIssueIds: ["issue-1"], isDependencyReady: true, allBlockersDone: true }),
    );

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
            backstop: "blocked_transition",
          }),
        }),
      );
    });
  });

  it("reports the cancellation when the backstop re-arms behind a cancelled blocker", async () => {
    // Readiness is now satisfied by `cancelled` blockers too, which made this backstop
    // newly reachable for a dependent whose premise died. It hand-built its payload, so it woke the
    // owner with "your blockers resolved" and no cancellation fields at all. Both producers must
    // speak through buildBlockersResolvedWakeFields or the owner is told the wrong thing.
    mockIssueService.getById.mockResolvedValue(blockedTransitionIssue("in_progress"));
    mockIssueService.update.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue(
      readiness({
        blockerIssueIds: ["issue-1"],
        cancelledBlockerIssueIds: ["issue-1"],
        isDependencyReady: true,
        allBlockersDone: true,
      }),
    );

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
            resolvedBlockerStatus: "cancelled",
            resolvedByCancellation: true,
            cancelledBlockerIssueIds: ["issue-1"],
            backstop: "blocked_transition",
          }),
          contextSnapshot: expect.objectContaining({
            source: "issue.blocked_transition_backstop",
            resolvedBlockerStatus: "cancelled",
            cancelledBlockerIssueIds: ["issue-1"],
            backstop: "blocked_transition",
          }),
        }),
      );
    });
  });

  it("reports a done blocker as done, not as a cancellation", async () => {
    // Opposite pole, so a mutant that hardcodes "cancelled" (or always sets resolvedByCancellation)
    // cannot survive the pair.
    mockIssueService.getById.mockResolvedValue(blockedTransitionIssue("in_progress"));
    mockIssueService.update.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue(
      readiness({ blockerIssueIds: ["issue-1"], isDependencyReady: true, allBlockersDone: true }),
    );

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          payload: expect.objectContaining({ resolvedBlockerStatus: "done" }),
        }),
      );
    });
    const call = mockWakeup.mock.calls.find(([, wake]) => wake.reason === "issue_blockers_resolved");
    expect(call?.[1].payload).not.toHaveProperty("resolvedByCancellation");
    expect(call?.[1].payload).not.toHaveProperty("cancelledBlockerIssueIds");
  });

  it("does not re-arm when a blocker is still unresolved", async () => {
    mockIssueService.getById.mockResolvedValue(blockedTransitionIssue("in_progress"));
    mockIssueService.update.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue(
      readiness({
        blockerIssueIds: ["issue-1"],
        unresolvedBlockerIssueIds: ["issue-1"],
        unresolvedBlockerCount: 1,
        allBlockersDone: false,
        isDependencyReady: false,
      }),
    );

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("does not re-arm when the blocked issue has no blocker relations", async () => {
    mockIssueService.getById.mockResolvedValue(blockedTransitionIssue("in_progress"));
    mockIssueService.update.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue(readiness({ blockerIssueIds: [] }));

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("does not re-arm when the issue was already blocked (no into-blocked transition)", async () => {
    mockIssueService.getById.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.update.mockResolvedValue(blockedTransitionIssue("blocked"));
    mockIssueService.getDependencyReadiness.mockResolvedValue(
      readiness({ blockerIssueIds: ["issue-1"], isDependencyReady: true, allBlockersDone: true }),
    );

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockWakeup).not.toHaveBeenCalledWith(
      "agent-2",
      expect.objectContaining({ reason: "issue_blockers_resolved" }),
    );
  });

  it("does not re-arm when the blocked issue has no assignee", async () => {
    const unassigned = { ...blockedTransitionIssue("in_progress"), assigneeAgentId: null };
    const unassignedBlocked = { ...blockedTransitionIssue("blocked"), assigneeAgentId: null };
    mockIssueService.getById.mockResolvedValue(unassigned);
    mockIssueService.update.mockResolvedValue(unassignedBlocked);
    mockIssueService.getDependencyReadiness.mockResolvedValue(
      readiness({ blockerIssueIds: ["issue-1"], isDependencyReady: true, allBlockersDone: true }),
    );

    const res = await request(await createApp()).patch("/api/issues/issue-2").send({ status: "blocked" });
    expect(res.status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Assert across every call (including a null-agent call) so dropping the
    // assignee guard — which would wake a null agent — is caught.
    const firedBlockersResolved = mockWakeup.mock.calls.some(
      ([, wakeup]) => (wakeup as { reason?: string } | undefined)?.reason === "issue_blockers_resolved",
    );
    expect(firedBlockersResolved).toBe(false);
  });

  it("wakes dependents when the final blocker is cancelled instead of completed", async () => {
    const base = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-200",
      title: "Abandoned blocker",
      description: null,
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    };
    mockIssueService.getById.mockResolvedValue({ ...base, status: "todo" });
    mockIssueService.update.mockResolvedValue({ ...base, status: "cancelled" });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1"],
        cancelledBlockerIssueIds: ["issue-1"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "cancelled" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          reason: "issue_blockers_resolved",
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerIssueId: "issue-1",
            // The dependent has to be told the premise died rather than completed.
            resolvedBlockerStatus: "cancelled",
            resolvedByCancellation: true,
            cancelledBlockerIssueIds: ["issue-1"],
          }),
        }),
      );
    });
  });

  it("still reports a cancelled blocker when a different blocker is the one that completes", async () => {
    // The ordinary shape for a dependent with two blockers: one was cancelled earlier, and the
    // wake only fires when the LAST one reaches `done`. The owner must still be told that a
    // premise died, so `cancelledBlockerIssueIds` cannot be gated on the resolving blocker.
    const base = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-202",
      title: "Second blocker",
      description: null,
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    };
    mockIssueService.getById.mockResolvedValue({ ...base, status: "in_progress" });
    mockIssueService.update.mockResolvedValue({ ...base, status: "done" });
    mockIssueService.listWakeableBlockedDependents.mockResolvedValue([
      {
        id: "issue-2",
        assigneeAgentId: "agent-2",
        blockerIssueIds: ["issue-1", "issue-9"],
        cancelledBlockerIssueIds: ["issue-9"],
      },
    ]);

    const res = await request(await createApp()).patch("/api/issues/issue-1").send({ status: "done" });
    expect(res.status).toBe(200);
    await vi.waitFor(() => {
      expect(mockWakeup).toHaveBeenCalledWith(
        "agent-2",
        expect.objectContaining({
          payload: expect.objectContaining({
            issueId: "issue-2",
            resolvedBlockerStatus: "done",
            cancelledBlockerIssueIds: ["issue-9"],
          }),
        }),
      );
    });
    // ...but this resolution was not itself a cancellation.
    const wake = mockWakeup.mock.calls.find(([agentId]) => agentId === "agent-2")?.[1] as
      | { payload: Record<string, unknown> }
      | undefined;
    expect(wake?.payload).not.toHaveProperty("resolvedByCancellation");
  });

  it("does not touch blockers on an update that omits blockedByIssueIds", async () => {
    // The service layer only clears relations when `blockedByIssueIds` is present, so the route
    // must not synthesise one. See blocked-resume-recovery.test.ts for the persisted-state half.
    const base = {
      id: "issue-1",
      companyId: "company-1",
      identifier: "PAP-201",
      title: "Still blocked",
      description: null,
      priority: "medium",
      parentId: null,
      assigneeAgentId: "agent-1",
      assigneeUserId: null,
      createdByAgentId: null,
      createdByUserId: null,
      executionWorkspaceId: null,
      labels: [],
      labelIds: [],
    };
    mockIssueService.getById.mockResolvedValue({ ...base, status: "blocked" });
    mockIssueService.update.mockResolvedValue({ ...base, status: "blocked" });
    mockIssueService.getRelationSummaries.mockResolvedValue({
      blockedBy: [{ id: "issue-9", identifier: "PAP-9", title: "Blocker", status: "todo", priority: "medium" }],
      blocks: [],
    });

    const res = await request(await createApp())
      .patch("/api/issues/issue-1")
      .send({ priority: "high" });

    expect(res.status).toBe(200);
    expect(mockIssueService.update).toHaveBeenCalled();
    for (const call of mockIssueService.update.mock.calls) {
      expect(call[1]).not.toHaveProperty("blockedByIssueIds");
    }
  });
});
