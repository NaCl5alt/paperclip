import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

  /**
   * A shared checkout that is NOT a git repository.
   *
   * This is the fail-close configuration: the directory is still a shared
   * checkout (`project_primary`, so a claim is taken on it), but there is no
   * repo to cut an isolation worktree from, so `resolveExecutionWorktreeTarget`
   * throws for every candidate and the contender has nowhere to move.
   */
  async function makeNonGitCheckout(): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-nongit-checkout-"));
    tempRoots.push(root);
    await writeFile(path.join(root, "README.md"), "not a repo\n");
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

  async function waitForClaim(runId: string, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const active = await db
        .select()
        .from(sharedWorkspaceClaims)
        .where(eq(sharedWorkspaceClaims.status, "active"));
      if (active.some((row) => row.heartbeatRunId === runId)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return false;
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
    expect(await waitForClaim(holderRun!.id)).toBe(true);

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
    // A shared checkout is claimed before any checkout work runs for it. If this
    // ever flips false, git touched the directory before the writer was decided.
    expect(holderShared?.claimedBeforeCheckout).toBe(true);
    expect(contenderShared?.claimedBeforeCheckout).toBe(true);
    // The actual invariant: no two live runs write the same directory.
    expect(contenderShared?.claimedCwd).not.toBe(holderShared?.claimedCwd);
    expect(contenderShared?.contention?.ownerLeaseRunId).toBe(holderRun!.id);

    // The isolated run got a real, separate git worktree off the same repo.
    const { stdout } = await run("git", ["-C", workspaceRoot, "worktree", "list", "--porcelain"]);
    expect(stdout).toContain(String(contenderShared?.claimedCwd));

    // The detour worktree is self-describing, so an operator sweeping stray
    // directories can tell why it exists and which collision produced it.
    const isolatedRow = await db
      .select()
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.cwd, String(contenderShared?.claimedCwd)))
      .then((rows) => rows[0] ?? null);
    const isolationMeta = (isolatedRow?.metadata ?? {}) as Record<string, unknown>;
    expect((isolationMeta.sharedWorkspaceIsolation as Record<string, unknown> | undefined)?.ownerLeaseRunId)
      .toBe(holderRun!.id);

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

    expect(await waitForClaim(holderRun!.id)).toBe(true);

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
    // Reusing the shared row for an isolated run would silently repoint the
    // shared checkout at the detour worktree.
    expect(sharedRow?.cwd).toBe(workspaceRoot);

    // A transient collision must not permanently re-home the issue onto a
    // run-scoped worktree.
    const issueRow = await db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issueRow?.executionWorkspaceId).toBe(sharedExecutionWorkspaceId);
  }, 60_000);

  it("claims the workspace the run will actually reuse, not the project default", async () => {
    // The issue reuses a checkout that is *not* the project primary. Predicting
    // the project primary instead would make this run contend with the holder
    // over a directory it never touches, and isolate for no reason.
    const projectRoot = await makeGitCheckout();
    const reusedRoot = await makeGitCheckout();
    const { companyId, projectId, projectWorkspaceId } = await seedProject(projectRoot);
    const holderId = await seedAgent(companyId, "Holder", 4_000);
    const contenderId = await seedAgent(companyId, "Contender", 0);

    await instanceSettingsService(db).updateExperimental({ enableIsolatedWorkspaces: true });

    const reusedExecutionWorkspaceId = randomUUID();
    await db.insert(executionWorkspaces).values({
      id: reusedExecutionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode: "shared_workspace",
      strategyType: "project_primary",
      name: "Reused checkout",
      status: "active",
      cwd: reusedRoot,
      providerType: "local_fs",
      providerRef: reusedRoot,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      projectWorkspaceId,
      title: "Reuses a non-default checkout",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: contenderId,
      identifier: "PAP-4055B",
      executionWorkspaceId: reusedExecutionWorkspaceId,
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
    await waitForClaim(holderRun!.id);

    const contenderRun = await heartbeat.wakeup(contenderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId, issueId },
    });
    const finished = await waitForRun(heartbeat, contenderRun!.id);
    await waitForRun(heartbeat, holderRun!.id);

    const shared = sharedWorkspaceContext(finished?.contextSnapshot);
    expect(shared?.mode).toBe("exclusive");
    expect(shared?.claimedCwd).toBe(await realpath(reusedRoot));
  }, 60_000);

  it("gives three simultaneous runs three different checkouts", async () => {
    // Two contenders at once: if every isolation candidate rendered the same
    // branch, the second contender would land in the first one's worktree (or
    // fail closed). The run-scoped final candidate is what prevents both.
    const workspaceRoot = await makeGitCheckout();
    const { companyId, projectId } = await seedProject(workspaceRoot);
    const holderId = await seedAgent(companyId, "Holder", 6_000);
    const firstContenderId = await seedAgent(companyId, "ContenderOne", 3_000);
    const secondContenderId = await seedAgent(companyId, "ContenderTwo", 3_000);

    const heartbeat = heartbeatService(db);
    const holderRun = await heartbeat.wakeup(holderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    await waitForClaim(holderRun!.id);

    const [first, second] = await Promise.all([
      heartbeat.wakeup(firstContenderId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { projectId },
      }),
      heartbeat.wakeup(secondContenderId, {
        source: "on_demand",
        triggerDetail: "manual",
        contextSnapshot: { projectId },
      }),
    ]);

    // Prove the three really were writing at the same time. Without this the
    // test can silently degrade into three sequential runs, which any wiring
    // passes — including one where every isolation candidate is the same branch.
    const overlapDeadline = Date.now() + 30_000;
    let peakConcurrentClaims = 0;
    while (Date.now() < overlapDeadline && peakConcurrentClaims < 3) {
      const active = await db
        .select()
        .from(sharedWorkspaceClaims)
        .where(eq(sharedWorkspaceClaims.status, "active"));
      peakConcurrentClaims = Math.max(peakConcurrentClaims, active.length);
      if (peakConcurrentClaims < 3) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(peakConcurrentClaims).toBe(3);

    const finished = await Promise.all([
      waitForRun(heartbeat, holderRun!.id),
      waitForRun(heartbeat, first!.id),
      waitForRun(heartbeat, second!.id),
    ]);

    for (const finishedRun of finished) {
      expect(finishedRun?.status).toBe("succeeded");
    }
    const cwds = finished.map((r) => sharedWorkspaceContext(r?.contextSnapshot)?.claimedCwd);
    expect(cwds.every((cwd) => typeof cwd === "string" && cwd.length > 0)).toBe(true);
    expect(new Set(cwds).size).toBe(3);
  }, 90_000);
  // ── fail-close path (VANA-4067 B-I2) ───────────────────────────────────────
  //
  // Every case above is a *successful* isolation. The branch that decides what
  // happens when isolation is impossible had no end-to-end coverage at all,
  // which is how the run record for a fail-close came to be indistinguishable
  // from an adapter fault: `SharedWorkspaceIsolationError.code` existed but was
  // never copied onto `heartbeat_runs.error_code`, so the throw landed on the
  // hardcoded `adapter_failed` in the setup-failure handler.
  //
  // The code is not cosmetic. `adapter_failed` is a member of
  // ADAPTER_FAILURE_ERROR_CODES, so recovery reads a local directory conflict
  // as "this adapter is broken" and re-homes the issue onto a different
  // adapter, which neither frees the directory nor is undone when it frees.

  it("records a fail-closed isolation under its own error code, not adapter_failed", async () => {
    const workspaceRoot = await makeNonGitCheckout();
    const { companyId, projectId } = await seedProject(workspaceRoot);
    const holderId = await seedAgent(companyId, "Holder", 4_000);
    const contenderId = await seedAgent(companyId, "Contender", 0);

    const heartbeat = heartbeatService(db);
    const holderRun = await heartbeat.wakeup(holderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    expect(holderRun).not.toBeNull();
    // The contender must arrive while the checkout is genuinely held; without
    // this the run would simply succeed and the assertions below would be
    // asserting nothing.
    expect(await waitForClaim(holderRun!.id)).toBe(true);

    const contenderRun = await heartbeat.wakeup(contenderId, {
      source: "on_demand",
      triggerDetail: "manual",
      contextSnapshot: { projectId },
    });
    expect(contenderRun).not.toBeNull();

    const finishedContender = await waitForRun(heartbeat, contenderRun!.id);
    await waitForRun(heartbeat, holderRun!.id);

    // Fail-close: the run is failed rather than allowed to share the directory.
    expect(finishedContender?.status).toBe("failed");
    expect(finishedContender?.error).toContain("could not be isolated");
    // The point of the test. Asserting the positive code alone would still pass
    // if the code were merely renamed, so pin the wrong value out explicitly.
    expect(finishedContender?.errorCode).toBe("shared_workspace_isolation_failed");
    expect(finishedContender?.errorCode).not.toBe("adapter_failed");

    // The stop metadata written alongside the run record has to agree, since
    // that is the copy operational queries read.
    const stopMetadata = (finishedContender?.resultJson ?? {}) as Record<string, unknown>;
    expect(JSON.stringify(stopMetadata)).toContain("shared_workspace_isolation_failed");

    // A fail-close must not leak the directory it could not use.
    const stillActive = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(stillActive.some((row) => row.heartbeatRunId === contenderRun!.id)).toBe(false);
  }, 60_000);
});
