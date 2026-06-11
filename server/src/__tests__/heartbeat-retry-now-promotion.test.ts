import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  budgetPolicies,
  companies,
  createDb,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres retry-now promotion tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("scheduled retry immediate promotion (VANA-751 Fix A+B)", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-now-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
  }, 20_000);

  afterEach(async () => {
    await db.delete(heartbeatRunEvents);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedScheduledRetryFixture(input?: {
    withIssue?: boolean;
  }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = input?.withIssue === false ? null : randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-06-11T09:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      finishedAt: now,
      contextSnapshot: {
        ...(issueId ? { issueId } : {}),
        wakeReason: issueId ? "issue_assigned" : "scheduled",
      },
      updatedAt: now,
      createdAt: now,
    });

    if (issueId) {
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Retry now promotion",
        status: "in_progress",
        priority: "medium",
        assigneeAgentId: agentId,
        executionRunId: sourceRunId,
        executionAgentNameKey: "claudecoder",
        executionLockedAt: now,
        issueNumber: 1,
        identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
      });
    }

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") throw new Error("fixture: retry not scheduled");

    // Keep the agent's queue from auto-claiming/executing during this unit test
    // so a promoted run observably stays "queued".
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "automation" as const,
        triggerDetail: "system" as const,
        status: "running" as const,
        contextSnapshot: {
          issueId: randomUUID(),
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    return { companyId, agentId, issueId, sourceRunId, now, retryRun: scheduled.run };
  }

  async function getRun(runId: string) {
    return db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
  }

  it("promotes a user-initiated issue wake that coalesces into a scheduled retry (Fix A, issue scope)", async () => {
    const fixture = await seedScheduledRetryFixture();

    const result = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "issue_comment",
      payload: { issueId: fixture.issueId },
      contextSnapshot: { issueId: fixture.issueId!, source: "issue.comment" },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(fixture.retryRun.id);
    expect(result?.status).toBe("queued");

    const stored = await getRun(fixture.retryRun.id);
    expect(stored?.status).toBe("queued");
    const context = stored?.contextSnapshot as Record<string, unknown>;
    expect(context.retryNowRequestedByActorType).toBe("user");
    expect(context.retryNowRequestedAt).toBeTruthy();
  });

  it("keeps a system-initiated issue wake coalesced without promoting the scheduled retry (issue scope)", async () => {
    const fixture = await seedScheduledRetryFixture();
    const originalScheduledRetryAt = fixture.retryRun.scheduledRetryAt;

    const result = await heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_updated",
      payload: { issueId: fixture.issueId },
      contextSnapshot: { issueId: fixture.issueId!, source: "issue.update" },
      requestedByActorType: "system",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(fixture.retryRun.id);
    expect(result?.status).toBe("scheduled_retry");

    const stored = await getRun(fixture.retryRun.id);
    expect(stored?.status).toBe("scheduled_retry");
    expect(stored?.scheduledRetryAt?.toISOString()).toBe(originalScheduledRetryAt?.toISOString());
    const context = stored?.contextSnapshot as Record<string, unknown>;
    expect(context.retryNowRequestedAt).toBeUndefined();
  });

  it("keeps an actorless issue wake coalesced without promoting the scheduled retry (issue scope)", async () => {
    const fixture = await seedScheduledRetryFixture();

    const result = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand",
      triggerDetail: "ping",
      reason: "agent_ping",
      payload: { issueId: fixture.issueId },
      contextSnapshot: { issueId: fixture.issueId!, source: "agent.ping" },
    });

    expect(result).not.toBeNull();
    expect(result?.status).toBe("scheduled_retry");
    const stored = await getRun(fixture.retryRun.id);
    expect(stored?.status).toBe("scheduled_retry");
  });

  it("promotes a user-initiated wake that coalesces into a scheduled retry without an issue (Fix A, task scope)", async () => {
    const fixture = await seedScheduledRetryFixture({ withIssue: false });

    const result = await heartbeat.wakeup(fixture.agentId, {
      source: "on_demand",
      triggerDetail: "manual",
      reason: "manual_wake",
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(fixture.retryRun.id);
    expect(result?.status).toBe("queued");

    const stored = await getRun(fixture.retryRun.id);
    expect(stored?.status).toBe("queued");
    const context = stored?.contextSnapshot as Record<string, unknown>;
    expect(context.retryNowRequestedByActorType).toBe("user");
  });

  it("keeps a system-initiated wake coalesced without promoting the scheduled retry (task scope)", async () => {
    const fixture = await seedScheduledRetryFixture({ withIssue: false });
    const originalScheduledRetryAt = fixture.retryRun.scheduledRetryAt;

    const result = await heartbeat.wakeup(fixture.agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "automation_wake",
      requestedByActorType: "system",
    });

    expect(result).not.toBeNull();
    expect(result?.id).toBe(fixture.retryRun.id);
    expect(result?.status).toBe("scheduled_retry");

    const stored = await getRun(fixture.retryRun.id);
    expect(stored?.status).toBe("scheduled_retry");
    expect(stored?.scheduledRetryAt?.toISOString()).toBe(originalScheduledRetryAt?.toISOString());
  });

  it("retry-now promotes the scheduled retry and reports it for immediate dispatch (Fix B)", async () => {
    const fixture = await seedScheduledRetryFixture();

    const result = await heartbeat.retryScheduledRetryNow({
      issueId: fixture.issueId!,
      actor: { actorType: "user", actorId: "local-board" },
    });

    expect(result.outcome).toBe("promoted");
    expect(result.scheduledRetry?.runId).toBe(fixture.retryRun.id);
    expect(result.scheduledRetry?.status).toBe("queued");

    const stored = await getRun(fixture.retryRun.id);
    expect(stored?.status).toBe("queued");
    const context = stored?.contextSnapshot as Record<string, unknown>;
    expect(context.retryNowRequestedByActorType).toBe("user");
  });
});
