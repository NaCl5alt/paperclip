import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  sharedWorkspaceClaims,
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
    `Skipping account gate enforcement tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * VANA-4041 integration coverage for the account failure gate.
 *
 * The unit tests in `services/recovery/account-failure-gate.test.ts` pin the
 * pure classifier. They cannot see the enforcement site, and that site is the
 * part that actually stops the fan-out: `getActiveAccountFailureGate` is wrapped
 * in `try { ... } catch { return null }`, so ANY throw inside it (a missing
 * import, a renamed column) degrades the gate to a permanent no-op while every
 * classifier test stays green. That failure mode is not hypothetical — it
 * already shipped once and had to be fixed by 5d725821d ("未importのgteを追加し
 * コンパイルエラーとゲート常時fail-openを解消する").
 *
 * These tests therefore drive `heartbeat.wakeup` end to end and assert on runs
 * actually created, plus the two cross-change interactions with the shared
 * checkout single-writer work merged alongside it.
 */
describeEmbeddedPostgres("heartbeat account failure gate enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-account-gate-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "shared_workspace_claims",
        "environment_leases",
        "environments",
        "issues",
        "execution_workspaces",
        "activity_log",
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "agent_runtime_state",
        "company_skills",
        "project_workspaces",
        "projects",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return companyId;
  }

  // A claude agent bound to an explicit credential dir; agents sharing that dir
  // share an account and must gate together.
  async function seedClaudeAgent(companyId: string, name: string, configDir: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", "process.exit(0)"],
        env: { CLAUDE_CONFIG_DIR: configDir },
      },
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return agentId;
  }

  async function recordTerminalRun(
    companyId: string,
    agentId: string,
    opts: { status: string; errorCode: string | null; finishedAt: Date },
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: opts.status,
      startedAt: new Date(opts.finishedAt.getTime() - 1_000),
      finishedAt: opts.finishedAt,
      errorCode: opts.errorCode,
      createdAt: new Date(opts.finishedAt.getTime() - 1_000),
      updatedAt: opts.finishedAt,
    });
    return runId;
  }

  async function runsFor(agentId: string) {
    const rows = await db.select().from(heartbeatRuns);
    return rows.filter((row) => row.agentId === agentId);
  }

  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

  it("suppresses an automated wake to an agent sharing a dead account", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      finishedAt: minutesAgo(5),
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(sibling, {
      source: "automation",
      triggerDetail: "issue_assigned",
    });

    // The gate returns null from enqueueWakeup, before any run row exists.
    expect(queued).toBeNull();
    expect(await runsFor(sibling)).toHaveLength(0);
  });

  it("does not suppress an agent on a different account", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const other = await seedClaudeAgent(companyId, "Other", "/tmp/acct-b");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      finishedAt: minutesAgo(5),
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(other, {
      source: "automation",
      triggerDetail: "issue_assigned",
    });

    expect(queued).not.toBeNull();
  });

  it("never suppresses a user-initiated wake, so an operator can always break in", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      finishedAt: minutesAgo(5),
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(dead, {
      source: "on_demand",
      triggerDetail: "manual",
      requestedByActorType: "user",
    });

    expect(queued).not.toBeNull();
  });

  it("releases the gate once a newer successful run is observed", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      finishedAt: minutesAgo(10),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();

    // Recovery is observed, not waited out: a newer success on the same account
    // clears the gate without any time passing.
    await recordTerminalRun(companyId, dead, {
      status: "succeeded",
      errorCode: null,
      finishedAt: minutesAgo(1),
    });

    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).not.toBeNull();
  });

  // ── cross-change interaction with the shared-checkout single-writer work ────

  it("leaves no shared workspace claim behind when it suppresses a wake", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      finishedAt: minutesAgo(5),
    });

    const heartbeat = heartbeatService(db);
    const queued = await heartbeat.wakeup(sibling, {
      source: "automation",
      triggerDetail: "issue_assigned",
    });

    // Assert the suppression itself, not only the absence of a claim: without
    // this the test passes vacuously under a permanently fail-open gate (the
    // wake proceeds, and no claim exists simply because nothing was seeded).
    expect(queued).toBeNull();

    // The gate sits at the enqueue choke point, upstream of checkout, so a
    // suppressed wake must never have taken (or leaked) a writer claim.
    const claims = await db.select().from(sharedWorkspaceClaims);
    expect(claims).toHaveLength(0);
  });

  it("does not arm the gate on a shared-workspace isolation failure", async () => {
    const companyId = await seedCompany();
    const contended = await seedClaudeAgent(companyId, "Contended", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    // Isolation fails closed and fails the run. That is a workspace contention
    // outcome, not a credential outcome, so it must not suppress the whole
    // account — otherwise a checkout storm would masquerade as an auth outage.
    await recordTerminalRun(companyId, contended, {
      status: "failed",
      errorCode: "shared_workspace_isolation_failed",
      finishedAt: minutesAgo(1),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).not.toBeNull();
  });
});
