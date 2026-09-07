import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projects,
  projectWorkspaces,
  sharedWorkspaceClaims,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const run = promisify(execFile);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared checkout isolation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

/**
 * End-to-end proof that two concurrent runs never share one on-disk checkout.
 *
 * The service-level tests pin the claim and the policy in isolation; this drives
 * the real heartbeat path so the *ordering* (claim before checkout) and the
 * wiring into `heartbeat.ts` are exercised together against a real git repo.
 */
describeEmbeddedPostgres("heartbeat shared checkout single-writer enforcement", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempRoots: string[] = [];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-shared-checkout-");
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
    for (const dir of tempRoots) await rm(dir, { recursive: true, force: true });
  });

  async function makeGitCheckout(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-shared-checkout-"));
    tempRoots.push(root);
    await run("git", ["init", "-b", "main", root]);
    await run("git", ["-C", root, "config", "user.email", "test@example.com"]);
    await run("git", ["-C", root, "config", "user.name", "test"]);
    await writeFile(path.join(root, "README.md"), "shared checkout\n");
    await run("git", ["-C", root, "add", "README.md"]);
    await run("git", ["-C", root, "commit", "-m", "初期コミット"]);
    return root;
  }

  async function seedProject(workspaceRoot: string) {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      status: "active",
      requireBoardApprovalForNewAgents: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared Checkout",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      cwd: workspaceRoot,
      isPrimary: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return { companyId, projectId, projectWorkspaceId };
  }

  async function seedAgent(companyId: string, name: string, sleepMs: number) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", `setTimeout(() => process.exit(0), ${sleepMs})`],
      },
      runtimeConfig: {},
      permissions: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    return agentId;
  }

  function sharedWorkspaceContext(contextSnapshot: unknown) {
    const snapshot = (contextSnapshot ?? {}) as Record<string, unknown>;
    return (snapshot.paperclipSharedWorkspace ?? null) as
      | { mode?: string; claimedCwd?: string; contention?: Record<string, unknown> }
      | null;
  }

  async function waitForRun(
    heartbeat: ReturnType<typeof heartbeatService>,
    runId: string,
    timeoutMs = 30_000,
  ) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await heartbeat.getRun(runId);
      if (found && !["queued", "running"].includes(found.status)) return found;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  it("gives two concurrent runs of one project different checkouts", async () => {
    const workspaceRoot = await makeGitCheckout();
    const { companyId, projectId } = await seedProject(workspaceRoot);
    // Holder stays running long enough that the second run must contend.
    const holderId = await seedAgent(companyId, "Holder", 4_000);
    const contenderId = await seedAgent(companyId, "Contender", 0);

    const heartbeat = heartbeatService(db);
    const holderRun = await heartbeat.wakeup(holderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    expect(holderRun).not.toBeNull();

    // Wait until the holder actually owns the checkout, so the second run is a
    // genuine contender rather than a lucky sequential reuse.
    const deadline = Date.now() + 20_000;
    let held = false;
    while (Date.now() < deadline && !held) {
      const active = await db
        .select()
        .from(sharedWorkspaceClaims)
        .where(eq(sharedWorkspaceClaims.status, "active"));
      held = active.some((row) => row.heartbeatRunId === holderRun!.id);
      if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(held).toBe(true);

    const contenderRun = await heartbeat.wakeup(contenderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    expect(contenderRun).not.toBeNull();

    const finishedContender = await waitForRun(heartbeat, contenderRun!.id);
    const finishedHolder = await waitForRun(heartbeat, holderRun!.id);

    const holderShared = sharedWorkspaceContext(finishedHolder?.contextSnapshot);
    const contenderShared = sharedWorkspaceContext(finishedContender?.contextSnapshot);

    expect(holderShared?.mode).toBe("exclusive");
    expect(contenderShared?.mode).toBe("isolated");
    // The actual invariant: no two live runs write the same directory.
    expect(contenderShared?.claimedCwd).not.toBe(holderShared?.claimedCwd);
    expect(contenderShared?.contention?.ownerLeaseRunId).toBe(holderRun!.id);

    // The isolated run got a real, separate git worktree off the same repo.
    const { stdout } = await run("git", ["-C", workspaceRoot, "worktree", "list", "--porcelain"]);
    expect(stdout).toContain(String(contenderShared?.claimedCwd));

    // Both claims are handed back once the runs end.
    const stillActive = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(stillActive).toHaveLength(0);
  }, 60_000);

  it("leaves the contended issue and its shared workspace row untouched when isolating", async () => {
    const workspaceRoot = await makeGitCheckout();
    const { companyId, projectId, projectWorkspaceId } = await seedProject(workspaceRoot);
    const holderId = await seedAgent(companyId, "Holder", 4_000);
    const contenderId = await seedAgent(companyId, "Contender", 0);

    // The contender's issue is pinned to the shared checkout and asks to reuse
    // it, which is the configuration that makes isolation a *detour*: the issue
    // still belongs on the shared workspace once the collision passes.
    // Without this flag `issues.update` silently drops executionWorkspaceId, so
    // the re-homing this test guards against could never happen and the test
    // would pass no matter what the wiring does.
    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });
    expect((await instanceSettingsService(db).getExperimental()).enableIsolatedWorkspaces).toBe(true);

    const sharedExecutionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: sharedExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Shared checkout",
      status: "active",
      cwd: workspaceRoot,
      providerType: "local_fs",
      providerRef: workspaceRoot,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Shared checkout contender",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: contenderId,
      identifier: "PAP-4055",
      executionWorkspaceId: sharedExecutionWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const heartbeat = heartbeatService(db);
    const holderRun = await heartbeat.wakeup(holderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    expect(holderRun).not.toBeNull();

    const deadline = Date.now() + 20_000;
    let held = false;
    while (Date.now() < deadline && !held) {
      const active = await db
        .select()
        .from(sharedWorkspaceClaims)
        .where(eq(sharedWorkspaceClaims.status, "active"));
      held = active.some((row) => row.heartbeatRunId === holderRun!.id);
      if (!held) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(held).toBe(true);

    const contenderRun = await heartbeat.wakeup(contenderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId, issueId },
    });
    const finishedContender = await waitForRun(heartbeat, contenderRun!.id);
    await waitForRun(heartbeat, holderRun!.id);

    expect(sharedWorkspaceContext(finishedContender?.contextSnapshot)?.mode).toBe("isolated");

    // The shared row belongs to the run that legitimately holds the checkout;
    // retiring it here would pull the workspace out from under a live writer.
    const sharedRow = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, sharedExecutionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(sharedRow?.status).toBe("active");

    // A transient collision must not permanently re-home the issue onto a
    // run-scoped worktree.
    const issueRow = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBe(sharedExecutionWorkspaceId);
  }, 60_000);
});
