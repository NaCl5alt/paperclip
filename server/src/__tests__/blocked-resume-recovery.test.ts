import { randomUUID } from "node:crypto";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  approvals,
  companies,
  companyMemberships,
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
import { buildBlockedResumeComment, recoveryService } from "../services/recovery/service.ts";
import {
  BLOCKED_RESUME_RULE_VERSION,
  BLOCKED_RESUME_WINDOW_MS,
  MAX_BLOCKED_RESUMES_PER_ISSUE,
  MAX_BLOCKED_RESUMES_PER_WINDOW,
  MIN_BLOCKED_PARK_AGE_MS,
  classifyBlockedWait,
  decideBlockedResume,
  decideBlockedResumeBatch,
  isResumableBlockedWait,
  quoteAsReference,
  statusChangeActivityFields,
  type BlockedWaitSignals,
} from "../services/recovery/blocked-wait.ts";

const NOW = new Date("2026-09-08T00:00:00.000Z");

function signals(overrides: Partial<BlockedWaitSignals> = {}): BlockedWaitSignals {
  return {
    unresolvedBlockerCount: 0,
    // Default the baseline issue INTO dependency-resume's domain: it has a blocker relation row
    // whose blocker is terminal (unresolvedBlockerCount 0), the shape that must stay
    // resumable. Cases that exercise the silent-sink boundary override this to 0 explicitly.
    blockerRelationRowCount: 1,
    pendingInteractionCount: 0,
    pendingApprovalCount: 0,
    monitorNextCheckAt: null,
    hasExternalWaitMarker: false,
    hasActiveRecoveryAction: false,
    hasActiveExecutionPath: false,
    isPauseHeld: false,
    now: NOW,
    ...overrides,
  };
}

describe("classifyBlockedWait", () => {
  it("treats an issue whose only blocker relation is terminal, with no other wait path, as resumable", () => {
    // shape: one blocker relation row, but its blocker is cancelled/done so nothing live
    // remains. This is dependency-resume's distinctive value (a permanent deadlock left by a
    // cancelled blocker) and must stay `none`/resumable.
    const kind = classifyBlockedWait(signals({ blockerRelationRowCount: 1, unresolvedBlockerCount: 0 }));
    expect(kind).toBe("none");
    expect(isResumableBlockedWait(kind)).toBe(true);
  });

  it("excludes an issue with no blocker relation row as the silent-sink recovery's domain", () => {
    // Responsibility boundary: an issue that never had a first-class blocker relation
    // belongs to recoverBlockedSilentSinks, NOT dependency-resume — whether it is still
    // an unstructured prose park or one 4085 already structured (e.g. an External owner/action
    // marker, for which there is no BlockedWaitSignal field). Either way it must not be resumed here.
    const kind = classifyBlockedWait(signals({ blockerRelationRowCount: 0 }));
    expect(kind).toBe("no_blocker_relation");
    expect(isResumableBlockedWait(kind)).toBe(false);
  });

  it("draws the boundary at the relation ROW count, not the unresolved-blocker count", () => {
    // A single all-terminal blocker row (unresolved 0, rows 1) stays resumable; drop the row and the
    // same unresolved-0 issue flips to the silent-sink domain. This is the exact distinction that
    // must not collapse to `unresolvedBlockerCount === 0`, or would be wrongly excluded.
    expect(classifyBlockedWait(signals({ blockerRelationRowCount: 1, unresolvedBlockerCount: 0 }))).toBe("none");
    expect(classifyBlockedWait(signals({ blockerRelationRowCount: 0, unresolvedBlockerCount: 0 }))).toBe(
      "no_blocker_relation",
    );
  });

  it("holds an issue that declares an external wait even when it still has a blocker relation row", () => {
    // The combination the row-count boundary alone cannot see: a blocker relation row exists (so
    // recoverBlockedSilentSinks never considers this issue) AND the description declares an
    // external wait. Without the marker signal this lands on `none` and gets resumed with a
    // comment asserting no wait path remains, which the marker disproves.
    const kind = classifyBlockedWait(
      signals({ blockerRelationRowCount: 1, unresolvedBlockerCount: 0, hasExternalWaitMarker: true }),
    );
    expect(kind).toBe("external_wait");
    expect(isResumableBlockedWait(kind)).toBe(false);
  });

  it("resumes the same issue once the external wait marker is gone", () => {
    // Opposite pole of the test above, so a mutant that hardcodes `external_wait` cannot survive:
    // the marker is what holds the issue, not the shape it shares with the case.
    const kind = classifyBlockedWait(
      signals({ blockerRelationRowCount: 1, unresolvedBlockerCount: 0, hasExternalWaitMarker: false }),
    );
    expect(kind).toBe("none");
    expect(isResumableBlockedWait(kind)).toBe(true);
  });

  it("keeps a future monitor as observation even when no blocker relation row exists", () => {
    // shape after 4085 structured a due date: rows 0 but a future monitor. observation is
    // checked before the no-blocker-relation boundary, so the more specific structured wait wins;
    // either way it is not resumable.
    const kind = classifyBlockedWait(
      signals({ blockerRelationRowCount: 0, monitorNextCheckAt: new Date(NOW.getTime() + 60_000) }),
    );
    expect(kind).toBe("observation");
    expect(isResumableBlockedWait(kind)).toBe(false);
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

  it("names the declared external wait ahead of the relation-row boundary when both apply", () => {
    // Both kinds are non-resumable, so swapping these two checks changes no resume decision
    // today and no other assertion here notices it. It is pinned anyway because the kind is a
    // reported reason, not just a boolean: `reconcileResumableBlockedIssues` already writes
    // `blockedWaitKind` into the activity row — only on the resume path, so today that field is
    // always "none" and never actually carries either of these two — and the moment a skip
    // records its reason too, an issue that declares `External owner:`/`External action:`
    // would be reported as merely lacking a blocker relation — which sends whoever reads it to
    // the silent-sink recovery instead of to the external owner holding the issue.
    expect(
      classifyBlockedWait(signals({ hasExternalWaitMarker: true, blockerRelationRowCount: 0 })),
    ).toBe("external_wait");
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

describe("approved resume rule", () => {
  it("pins every value of the approved rule so a change cannot ride along under the old approval", () => {
    expect(
      {
        version: BLOCKED_RESUME_RULE_VERSION,
        maxResumesPerIssue: MAX_BLOCKED_RESUMES_PER_ISSUE,
        minParkAgeMs: MIN_BLOCKED_PARK_AGE_MS,
        maxResumesPerWindow: MAX_BLOCKED_RESUMES_PER_WINDOW,
        windowMs: BLOCKED_RESUME_WINDOW_MS,
      },
      "the resume rule changed: bump BLOCKED_RESUME_RULE_VERSION and report the change for approval",
    ).toEqual({
      version: "2026-09-11.v1",
      maxResumesPerIssue: 3,
      minParkAgeMs: 900_000,
      maxResumesPerWindow: 5,
      windowMs: 3_600_000,
    });

    // One signal at a time against the resumable baseline — the classification half of C2–C6.
    const future = new Date(NOW.getTime() + 60_000);
    expect(
      {
        baseline: classifyBlockedWait(signals()),
        isPauseHeld: classifyBlockedWait(signals({ isPauseHeld: true })),
        hasActiveExecutionPath: classifyBlockedWait(signals({ hasActiveExecutionPath: true })),
        hasActiveRecoveryAction: classifyBlockedWait(signals({ hasActiveRecoveryAction: true })),
        pendingInteractionCount: classifyBlockedWait(signals({ pendingInteractionCount: 1 })),
        pendingApprovalCount: classifyBlockedWait(signals({ pendingApprovalCount: 1 })),
        unresolvedBlockerCount: classifyBlockedWait(signals({ unresolvedBlockerCount: 1 })),
        monitorNextCheckAt: classifyBlockedWait(signals({ monitorNextCheckAt: future })),
        hasExternalWaitMarker: classifyBlockedWait(signals({ hasExternalWaitMarker: true })),
        blockerRelationRowCount: classifyBlockedWait(signals({ blockerRelationRowCount: 0 })),
      },
      "the resume rule changed: bump BLOCKED_RESUME_RULE_VERSION and report the change for approval",
    ).toEqual({
      baseline: "none",
      isPauseHeld: "hold",
      hasActiveExecutionPath: "execution",
      hasActiveRecoveryAction: "recovery",
      pendingInteractionCount: "approval",
      pendingApprovalCount: "approval",
      unresolvedBlockerCount: "dependency",
      monitorNextCheckAt: "observation",
      hasExternalWaitMarker: "external_wait",
      blockerRelationRowCount: "no_blocker_relation",
    });
  });
});

describe("decideBlockedResumeBatch", () => {
  it("resumes a batch that fits the limit exactly", () => {
    expect(decideBlockedResumeBatch({ eligibleCount: 5, resumedInWindow: 0, holdOpen: false })).toEqual({
      resume: true,
    });
    expect(decideBlockedResumeBatch({ eligibleCount: 2, resumedInWindow: 3, holdOpen: false })).toEqual({
      resume: true,
    });
  });

  it("resumes none of a batch that would take the window past the limit", () => {
    expect(decideBlockedResumeBatch({ eligibleCount: 6, resumedInWindow: 0, holdOpen: false })).toEqual({
      resume: false,
      reason: "over_limit",
    });
    // Resumes already made in the window count, so a burst cannot drain a few per sweep.
    expect(decideBlockedResumeBatch({ eligibleCount: 3, resumedInWindow: 3, holdOpen: false })).toEqual({
      resume: false,
      reason: "over_limit",
    });
  });

  it("resumes nothing while a hold is open, however small the batch", () => {
    expect(decideBlockedResumeBatch({ eligibleCount: 1, resumedInWindow: 0, holdOpen: true })).toEqual({
      resume: false,
      reason: "hold_open",
    });
  });
});

describe("resume hand-over comment", () => {
  it("wraps quoted text in a code span that neutralises all link forms", () => {
    // markdown-link syntax stripped, result wrapped in code span
    expect(quoteAsReference("## Ship it now\n\n- [merge PR](https://example.test/pr/1)\n> go")).toBe(
      "`## Ship it now - merge PR > go`",
    );
    // truncation still works; result is a code span
    expect(quoteAsReference("x".repeat(300), 10)).toBe(`\`${"x".repeat(10)}…\``);
    // bare URL — autolink literal must be inert (inside code span)
    const withUrl = quoteAsReference("See https://example.com for details");
    expect(withUrl.startsWith("`")).toBe(true);
    expect(withUrl.endsWith("`")).toBe(true);
    expect(withUrl).toContain("https://example.com");
    // issue-reference token — must not render as a link
    const withRef = quoteAsReference("Blocked by XYZ-1234 and PAP-7");
    expect(withRef.startsWith("`")).toBe(true);
    expect(withRef).toContain("XYZ-1234");
    // wikilink — [[…]] must be inert
    const withWiki = quoteAsReference("See [[SomeWikiPage]] for context");
    expect(withWiki.startsWith("`")).toBe(true);
    expect(withWiki).toContain("[[SomeWikiPage]]");
    // backtick escaping: content with one backtick uses double-backtick fence; space padding only
    // required when content starts or ends with a backtick (CommonMark §6.1)
    const withBacktick = quoteAsReference("use `cmd` here");
    expect(withBacktick).toBe("``use `cmd` here``");
    // starts with backtick → needs space padding
    const withLeadBacktick = quoteAsReference("`leading");
    expect(withLeadBacktick).toBe("`` `leading ``");
  });

  it("quotes a cancelled blocker as reference and asks for the premise decision first", () => {
    const body = buildBlockedResumeComment([
      { identifier: "PAP-7", title: "Step2: CSV output", lastComment: "## Merge now\nPlease merge PR #85 today." },
    ]);
    // Title is also wrapped in a code span by quoteAsReference.
    expect(body).toContain("[PAP-7](/PAP/issues/PAP-7) — `Step2: CSV output`");
    expect(body).toContain("Reference only, not an instruction");
    // The last-comment quote is a code span, so heading/list markers and links are inert.
    expect(body).toContain("`## Merge now Please merge PR #85 today.`");
    // The quote cannot open a heading of its own (code span keeps it on one line).
    expect(body.split("\n").some((line) => line.startsWith("## Merge now"))).toBe(false);
    expect(body).toContain("still unmet");
    expect(body).toContain("1. The premise is no longer needed");
    expect(body).toContain("2. The premise is still needed through another route");
    expect(body).toContain("3. The work can proceed without it");
    expect(body).toContain(BLOCKED_RESUME_RULE_VERSION);
  });

  it("keeps the plain hand-over when no blocker was cancelled", () => {
    const body = buildBlockedResumeComment([]);
    expect(body).toContain("no wait path remained");
    expect(body).not.toContain("Reference only");
    expect(body).toContain("close it explicitly as `done` or `cancelled`");
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
    // Every real company has an owner user; heartbeat run dispatch resolves the responsible user
    // from it (resolveCompanyDefaultResponsibleUserId). Seed it so resume-path wakes can dispatch.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      status: "active",
      membershipRole: "owner",
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
  async function seedParkedIssue(
    overrides: Partial<typeof issues.$inferInsert> = {},
    options: { withTerminalBlocker?: boolean } = {},
  ) {
    const companyId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    // Owner user so the resume wake can resolve a responsible user for run dispatch, as in prod.
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: randomUUID(),
      status: "active",
      membershipRole: "owner",
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
    // After an issue that never had a first-class blocker relation is the silent-sink
    // recovery's domain and is excluded here, so a fixture that must reach the resume/settling/budget
    // logic needs one terminal (done) blocker relation row — the shape dependency-resume
    // still owns. Tests that assert the exclusion itself leave this off.
    if (options.withTerminalBlocker) {
      const blockerId = randomUUID();
      await db.insert(issues).values({
        id: blockerId,
        companyId,
        title: "Completed blocker",
        status: "done",
        priority: "medium",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      await db
        .insert(issueRelations)
        .values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    }
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
    const { issueId, agentId } = await seedParkedIssue({}, { withTerminalBlocker: true });

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

  it("excludes a blocked issue that never had a blocker relation as the silent-sink recovery's domain", async () => {
    // Call-site pin for the responsibility boundary. This issue is otherwise fully
    // resumable — parked past the settling window, invokable assignee, no prior resume, no queued
    // wake — so the ONLY thing keeping it in `blocked` is the zero-blocker-relation exclusion.
    // Disabling that exclusion anywhere on the path (classifyBlockedWait, the collected signal, or
    // the reconcile call site) would flip this issue back to `todo`, which this test then catches.
    const { issueId } = await seedParkedIssue();

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("leaves an issue that declares an external wait alone even though it has a blocker relation row", async () => {
    // Call-site pin for the marker gap the row-count boundary cannot close. `withTerminalBlocker`
    // gives this issue a blocker relation row, so it is NOT excluded by `no_blocker_relation` and
    // recoverBlockedSilentSinks never considers it either — the description marker is the sole
    // remaining hold. Dropping the `hasExternalWaitMarker` signal at the call site or its
    // precedence entry in classifyBlockedWait resumes this issue, which this test then catches.
    const { issueId } = await seedParkedIssue(
      { description: "Waiting on the vendor.\n\nExternal owner: Vendor X\nExternal action: signed quote" },
      { withTerminalBlocker: true },
    );

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(result.issueIds).not.toContain(issueId);
    expect(await statusOf(issueId)).toBe("blocked");
    expect(await resumeActivityCount(issueId)).toBe(0);
  });

  it("still resumes an otherwise identical issue whose description carries no external wait marker", async () => {
    // Opposite pole of the test above: same shape, same terminal blocker row, prose that merely
    // mentions a vendor without the sanctioned marker. Proves the hold above comes from the marker
    // and not from the fixture, so a mutant that never resumes cannot pass both tests.
    const { issueId } = await seedParkedIssue(
      { description: "Waiting on the vendor to send a signed quote." },
      { withTerminalBlocker: true },
    );

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(1);
    expect(await statusOf(issueId)).toBe("todo");
  });

  it("does not resume twice for the same park, including across a restart", async () => {
    const { issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });

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
    // withTerminalBlocker so the pending interaction is the ONLY thing keeping this blocked — a bare
    // issue would be held by no_blocker_relation instead, leaving the interaction query unpinned.
    const { companyId, agentId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    // withTerminalBlocker so the pending approval is the sole hold; a bare issue would be caught by
    // no_blocker_relation and pass even if the approval query were broken.
    const { companyId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    // withTerminalBlocker so the pause hold is the sole hold, not no_blocker_relation.
    const { companyId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    // withTerminalBlocker so the recovery action is the sole hold, not no_blocker_relation.
    const { companyId, agentId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    // withTerminalBlocker so the future monitor is the sole hold; a bare issue would fall to
    // no_blocker_relation and pass even if the monitor signal were dropped.
    const { issueId } = await seedParkedIssue(
      { monitorNextCheckAt: new Date(Date.now() + 60 * 60 * 1000) },
      { withTerminalBlocker: true },
    );

    const result = await heartbeatService(db).reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusOf(issueId)).toBe("blocked");
  });

  it("does not race a live run that is already holding the issue", async () => {
    // withTerminalBlocker so the live run is the sole hold, not no_blocker_relation.
    const { companyId, agentId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    const { companyId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    const { companyId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
      // withTerminalBlocker so the approval is the sole hold across every status, not no_blocker_relation.
      const { companyId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
      // withTerminalBlocker so the recovery action is the sole hold across every status.
      const { companyId, agentId, issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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
    const { issueId } = await seedParkedIssue({}, { withTerminalBlocker: true });
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

  describe("resume limit, hold and re-check", () => {
  const RESUME_SOURCE = "recovery.reconcile_resumable_blocked_issue";
  const HOLD_ORIGIN_KIND = "blocked_resume_hold";

  /** `count` resumable issues in one company, each with a single completed blocker. */
  async function seedParkedBatch(count: number) {
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
    const issueIds: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const issueId = randomUUID();
      const blockerId = randomUUID();
      await db.insert(issues).values([
        {
          id: issueId,
          companyId,
          title: `Parked ${index}`,
          status: "blocked",
          priority: "medium",
          assigneeAgentId: agentId,
          issueNumber: 2 * index + 1,
          identifier: `${issuePrefix}-${2 * index + 1}`,
        },
        {
          id: blockerId,
          companyId,
          title: `Blocker ${index}`,
          status: "done",
          priority: "medium",
          issueNumber: 2 * index + 2,
          identifier: `${issuePrefix}-${2 * index + 2}`,
        },
      ]);
      await db
        .insert(issueRelations)
        .values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
      issueIds.push(issueId);
    }
    await db
      .update(issues)
      .set({ updatedAt: new Date(Date.now() - MIN_BLOCKED_PARK_AGE_MS - 60_000) })
      .where(inArray(issues.id, issueIds));
    return { companyId, agentId, issueIds };
  }

  /** Recovery with a recording wake stub, so resumes are counted without dispatching real runs. */
  function stubbedRecovery(onWake?: (issueId: string) => Promise<void>) {
    const wokenIssueIds: string[] = [];
    const recovery = recoveryService(db, {
      enqueueWakeup: async (_agentId, opts) => {
        const issueId = String((opts?.payload as Record<string, unknown> | null | undefined)?.issueId ?? "");
        wokenIssueIds.push(issueId);
        await onWake?.(issueId);
        return { id: randomUUID() } as unknown as typeof heartbeatRuns.$inferSelect;
      },
    });
    return { recovery, wokenIssueIds };
  }

  async function statusesOf(issueIds: string[]) {
    return db
      .select({ status: issues.status })
      .from(issues)
      .where(inArray(issues.id, issueIds))
      .then((rows) => rows.map((row) => row.status));
  }

  async function holdsOf(companyId: string) {
    return db
      .select({ id: issues.id, status: issues.status, assigneeAgentId: issues.assigneeAgentId })
      .from(issues)
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, HOLD_ORIGIN_KIND)));
  }

  async function activityDetailsBySource(source: string) {
    return db
      .select({ entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(sql`${activityLog.details} ->> 'source' = ${source}`)
      .then((rows) => rows.map((row) => ({ entityId: row.entityId, ...(row.details as Record<string, unknown>) })));
  }

  it("resumes a batch that fits the limit and records the rule version on each resume", async () => {
    const { issueIds } = await seedParkedBatch(MAX_BLOCKED_RESUMES_PER_WINDOW);
    const { recovery, wokenIssueIds } = stubbedRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(MAX_BLOCKED_RESUMES_PER_WINDOW);
    expect(await statusesOf(issueIds)).toEqual(issueIds.map(() => "todo"));
    expect([...wokenIssueIds].sort()).toEqual([...issueIds].sort());
    const resumes = await activityDetailsBySource(RESUME_SOURCE);
    expect(resumes.map((row) => row.ruleVersion)).toEqual(issueIds.map(() => BLOCKED_RESUME_RULE_VERSION));
  });

  it("resumes none of a batch over the limit and opens a hold instead", async () => {
    const { companyId, issueIds } = await seedParkedBatch(MAX_BLOCKED_RESUMES_PER_WINDOW + 1);
    const { recovery, wokenIssueIds } = stubbedRecovery();

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(0);
    expect(await statusesOf(issueIds)).toEqual(issueIds.map(() => "blocked"));
    expect(wokenIssueIds).toEqual([]);
    expect(await activityDetailsBySource(RESUME_SOURCE)).toEqual([]);

    const holds = await holdsOf(companyId);
    expect(holds).toHaveLength(1);
    expect(holds[0]).toMatchObject({ status: "todo", assigneeAgentId: null });
    const [opened] = await activityDetailsBySource("recovery.blocked_resume_hold_opened");
    expect(opened).toMatchObject({
      entityId: holds[0]!.id,
      ruleVersion: BLOCKED_RESUME_RULE_VERSION,
      resumedInWindow: 0,
      limit: MAX_BLOCKED_RESUMES_PER_WINDOW,
    });
    expect([...(opened!.heldIssueIds as string[])].sort()).toEqual([...issueIds].sort());
  });

  it("keeps holding on later sweeps, and closing the hold does not let an unchanged backlog through", async () => {
    const { companyId, issueIds } = await seedParkedBatch(MAX_BLOCKED_RESUMES_PER_WINDOW + 1);
    const { recovery } = stubbedRecovery();
    await recovery.reconcileStrandedAssignedIssues();

    // The next sweep resumes nothing and does not pile up a second hold.
    expect((await recovery.reconcileStrandedAssignedIssues()).resumableBlockedResumed).toBe(0);
    const [firstHold] = await holdsOf(companyId);
    expect(await holdsOf(companyId)).toHaveLength(1);

    // Closing the hold with the backlog unchanged stops again under a new hold.
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, firstHold!.id));
    expect((await recovery.reconcileStrandedAssignedIssues()).resumableBlockedResumed).toBe(0);
    expect((await holdsOf(companyId)).filter((hold) => hold.status !== "done")).toHaveLength(1);
    expect(await statusesOf(issueIds)).toEqual(issueIds.map(() => "blocked"));

    // Once a person has brought the backlog under the limit, closing the hold releases it.
    await db.update(issues).set({ status: "cancelled" }).where(eq(issues.id, issueIds[0]!));
    await db
      .update(issues)
      .set({ status: "done" })
      .where(and(eq(issues.companyId, companyId), eq(issues.originKind, HOLD_ORIGIN_KIND)));
    expect((await recovery.reconcileStrandedAssignedIssues()).resumableBlockedResumed).toBe(
      MAX_BLOCKED_RESUMES_PER_WINDOW,
    );
  });

  it("counts resumes already made in the window against the limit, and only those", async () => {
    const pastResume = (companyId: string, createdAt: Date) => ({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "issue.updated",
      entityType: "issue",
      entityId: randomUUID(),
      details: { status: "todo", source: RESUME_SOURCE },
      createdAt,
    });
    const insideWindow = new Date(Date.now() - 5 * 60_000);
    const outsideWindow = new Date(Date.now() - BLOCKED_RESUME_WINDOW_MS - 60_000);

    // 2 in the window + 3 now = 5 fits; the 5 older resumes must not count.
    const fits = await seedParkedBatch(3);
    await db.insert(activityLog).values([
      ...[0, 1].map(() => pastResume(fits.companyId, insideWindow)),
      ...[0, 1, 2, 3, 4].map(() => pastResume(fits.companyId, outsideWindow)),
    ]);
    // 3 in the window + 3 now = 6 does not.
    const over = await seedParkedBatch(3);
    await db.insert(activityLog).values([0, 1, 2].map(() => pastResume(over.companyId, insideWindow)));

    const result = await stubbedRecovery().recovery.reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(3);
    expect(await statusesOf(fits.issueIds)).toEqual(fits.issueIds.map(() => "todo"));
    expect(await statusesOf(over.issueIds)).toEqual(over.issueIds.map(() => "blocked"));
    expect(await holdsOf(fits.companyId)).toHaveLength(0);
    expect(await holdsOf(over.companyId)).toHaveLength(1);
  });

  it("does not let overlapping sweeps exceed the limit or resume an issue twice", async () => {
    const { issueIds } = await seedParkedBatch(MAX_BLOCKED_RESUMES_PER_WINDOW);
    const { recovery } = stubbedRecovery();

    await Promise.all([
      recovery.reconcileStrandedAssignedIssues(),
      recovery.reconcileStrandedAssignedIssues(),
      stubbedRecovery().recovery.reconcileStrandedAssignedIssues(),
    ]);

    const resumes = await activityDetailsBySource(RESUME_SOURCE);
    expect(resumes).toHaveLength(MAX_BLOCKED_RESUMES_PER_WINDOW);
    expect(new Set(resumes.map((row) => row.entityId))).toEqual(new Set(issueIds));
  });

  it("re-checks every condition immediately before the write, not only when the batch was built", async () => {
    const { companyId, agentId, issueIds } = await seedParkedBatch(2);
    // The first resume's wake attaches a pending interaction to the other issue — after the batch
    // was evaluated as fully resumable, before that issue's own turn comes.
    const { recovery, wokenIssueIds } = stubbedRecovery(async (wokenIssueId) => {
      const other = issueIds.find((id) => id !== wokenIssueId)!;
      await db.insert(issueThreadInteractions).values({
        id: randomUUID(),
        companyId,
        issueId: other,
        kind: "request_confirmation",
        status: "pending",
        payload: { version: 1, prompt: "Arrived mid-sweep" },
        createdByAgentId: agentId,
      });
    });

    const result = await recovery.reconcileStrandedAssignedIssues();

    expect(result.resumableBlockedResumed).toBe(1);
    expect(wokenIssueIds).toHaveLength(1);
    const other = issueIds.find((id) => id !== wokenIssueIds[0])!;
    expect(await statusesOf([other])).toEqual(["blocked"]);
    expect((await activityDetailsBySource(RESUME_SOURCE)).map((row) => row.entityId)).toEqual([wokenIssueIds[0]]);
  });

  it("puts the issue back when a wait lands between the check and the write", async () => {
    const { issueIds } = await seedParkedBatch(1);
    const issueId = issueIds[0]!;
    // Stands in for a concurrent writer: the interaction commits together with the status write,
    // so the check before the write cannot have seen it.
    await db.execute(sql`
      create or replace function test_attach_interaction_on_resume() returns trigger language plpgsql as $$
      begin
        if old.status = 'blocked' and new.status = 'todo' then
          insert into issue_thread_interactions (id, company_id, issue_id, kind, status, payload)
          values (gen_random_uuid(), new.company_id, new.id, 'request_confirmation', 'pending',
                  '{"version":1,"prompt":"Concurrent"}'::jsonb);
        end if;
        return new;
      end $$
    `);
    await db.execute(sql`
      create trigger test_attach_interaction_on_resume after update on issues
      for each row execute function test_attach_interaction_on_resume()
    `);
    try {
      const { recovery, wokenIssueIds } = stubbedRecovery();

      const result = await recovery.reconcileStrandedAssignedIssues();

      expect(result.resumableBlockedResumed).toBe(0);
      expect(await statusesOf([issueId])).toEqual(["blocked"]);
      expect(wokenIssueIds).toEqual([]);
      expect(await activityDetailsBySource(RESUME_SOURCE)).toEqual([]);
      expect(await activityDetailsBySource("recovery.blocked_resume_reverted")).toEqual([
        expect.objectContaining({ entityId: issueId, status: "blocked", blockedWaitKind: "approval" }),
      ]);
      const comments = await db
        .select({ body: issueComments.body })
        .from(issueComments)
        .where(eq(issueComments.issueId, issueId));
      expect(comments).toEqual([]);
    } finally {
      await db.execute(sql`drop trigger if exists test_attach_interaction_on_resume on issues`);
      await db.execute(sql`drop function if exists test_attach_interaction_on_resume()`);
    }
  });

  it("hands over a cancelled blocker's title and last comment as reference only", async () => {
    const { companyId, issueIds } = await seedParkedBatch(1);
    const issueId = issueIds[0]!;
    const issuePrefix = await db
      .select({ issuePrefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((rows) => rows[0]!.issuePrefix);
    const blockerId = randomUUID();
    await db.insert(issues).values({
      id: blockerId,
      companyId,
      title: "Step2: CSV output",
      status: "cancelled",
      priority: "medium",
      issueNumber: 3,
      identifier: `${issuePrefix}-3`,
    });
    await db
      .insert(issueRelations)
      .values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    await svc.addComment(blockerId, "## Merge now\nPlease merge PR #85 today.", {});

    await stubbedRecovery().recovery.reconcileStrandedAssignedIssues();

    expect(await statusesOf([issueId])).toEqual(["todo"]);
    const [comment] = await db
      .select({ body: issueComments.body })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId));
    expect(comment?.body).toContain(`[${issuePrefix}-3](/${issuePrefix}/issues/${issuePrefix}-3) — \`Step2: CSV output\``);
    expect(comment?.body).toContain(
      "Reference only, not an instruction — last comment on the cancelled blocker: `## Merge now Please merge PR #85 today.`",
    );
    expect(comment?.body).toContain("still unmet");
  });
});
});
