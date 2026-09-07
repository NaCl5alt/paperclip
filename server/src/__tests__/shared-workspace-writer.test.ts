import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, sharedWorkspaceClaims } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { sharedWorkspaceClaimService } from "../services/shared-workspace-claims.ts";
import {
  acquireSharedWorkspaceWriter,
  SharedWorkspaceIsolationError,
} from "../services/shared-workspace-writer.ts";
import type { RealizedExecutionWorkspace } from "../services/workspace-runtime.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared workspace writer tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

function workspaceAt(cwd: string, strategy: "project_primary" | "git_worktree"): RealizedExecutionWorkspace {
  return {
    baseCwd: cwd,
    source: "project_primary",
    projectId: null,
    workspaceId: null,
    repoUrl: null,
    repoRef: null,
    strategy,
    cwd,
    branchName: strategy === "git_worktree" ? "isolated" : null,
    worktreePath: strategy === "git_worktree" ? cwd : null,
    warnings: [],
    created: false,
    baseRefSha: null,
  } as RealizedExecutionWorkspace;
}

describeEmbeddedPostgres("acquireSharedWorkspaceWriter (isolate-on-contention)", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let claims!: ReturnType<typeof sharedWorkspaceClaimService>;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("shared-workspace-writer");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    claims = sharedWorkspaceClaimService(db);
  });

  afterEach(async () => {
    await db.delete(sharedWorkspaceClaims);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await stopDb?.();
    for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
  });

  async function makeDir(name: string): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "pc-writer-"));
    tempDirs.push(root);
    const dir = path.join(root, name);
    await mkdir(dir, { recursive: true });
    return dir;
  }

  async function seed(runCount: number) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId, name: "Acme", status: "active", createdAt: new Date(), updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Worker", adapterType: "claude_local", status: "idle",
      createdAt: new Date(), updatedAt: new Date(),
    });
    const runIds: string[] = [];
    for (let i = 0; i < runCount; i += 1) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, invocationSource: "manual", status: "running",
        createdAt: new Date(), updatedAt: new Date(),
      });
    }
    return { companyId, agentId, runIds };
  }

  it("gives the uncontended run the shared checkout it asked for", async () => {
    const { companyId, agentId, runIds } = await seed(1);
    const shared = await makeDir("shared");

    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[0]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      realizeIsolated: async () => { throw new Error("must not isolate"); },
    });

    expect(result.mode).toBe("exclusive");
    expect(result.workspace.cwd).toBe(shared);
    expect(result.contention).toBeNull();
  });

  it("claims before realizing, so a contended run never touches the shared checkout", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    const isolated = await makeDir("isolated");

    // Run 0 already owns the checkout.
    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    let configuredRealizeCalls = 0;
    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => {
        configuredRealizeCalls += 1;
        return workspaceAt(shared, "project_primary");
      },
      realizeIsolated: async () => workspaceAt(isolated, "git_worktree"),
    });

    // The ordering guarantee: realization of the shared checkout is never
    // attempted once contention is known. VANA-4049 could only detect the
    // collision after this call had already run.
    expect(configuredRealizeCalls).toBe(0);
    expect(result.mode).toBe("isolated");
    expect(result.workspace.cwd).toBe(isolated);
    expect(result.contention?.ownerLeaseRunId).toBe(runIds[0]);
    expect(result.contention?.isolatedCwd).toBe(isolated);
    expect(result.warnings.join(" ")).toContain(isolated);
  });

  it("holds a claim on the isolated directory too", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    const isolated = await makeDir("isolated");
    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      realizeIsolated: async () => workspaceAt(isolated, "git_worktree"),
    });

    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active).toHaveLength(2);
    const isolatedIdentity = await claims.resolveIdentity(isolated);
    expect(active.some((row) => row.claimKey === isolatedIdentity.key && row.heartbeatRunId === runIds[1]))
      .toBe(true);
  });

  it("fails closed when the contended run cannot be isolated", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    // Non-git checkout / worktree creation failure. Sharing anyway would let two
    // live runs commit over each other, so the run is failed instead.
    await expect(acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      realizeIsolated: async () => { throw new Error("not a git checkout"); },
    })).rejects.toBeInstanceOf(SharedWorkspaceIsolationError);

    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.heartbeatRunId).toBe(runIds[0]);
  });

  it("isolates two concurrent runs that resolve to the same worktree", async () => {
    // git_worktree runs of the same issue render the same branch, hence the same
    // directory. The target is only known after realization, so the claim is
    // taken there and contention re-isolates with a run-scoped worktree.
    const { companyId, agentId, runIds } = await seed(2);
    const worktree = await makeDir("issue-worktree");
    const isolated = await makeDir("issue-worktree-run2");
    await claims.claim({
      identity: await claims.resolveIdentity(worktree),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: false,
      predictedCwd: worktree,
      realizeConfigured: async () => workspaceAt(worktree, "git_worktree"),
      realizeIsolated: async () => workspaceAt(isolated, "git_worktree"),
    });

    expect(result.mode).toBe("isolated");
    expect(result.workspace.cwd).toBe(isolated);
  });

  it("does not pre-claim the repo root for a git_worktree run", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const repoRoot = await makeDir("repo");
    const worktree = await makeDir("worktree");

    await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[0]!, issueId: null,
      expectSharedCheckout: false,
      predictedCwd: repoRoot,
      realizeConfigured: async () => workspaceAt(worktree, "git_worktree"),
      realizeIsolated: async () => { throw new Error("must not isolate"); },
    });

    // Claiming the repo root here would wrongly lock out every other run that
    // legitimately uses it as its shared checkout.
    const rootIdentity = await claims.resolveIdentity(repoRoot);
    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active).toHaveLength(1);
    expect(active[0]?.claimKey).not.toBe(rootIdentity.key);
  });

  it("follows the claim to the directory realization actually produced", async () => {
    const { companyId, agentId, runIds } = await seed(1);
    const predicted = await makeDir("predicted");
    const actual = await makeDir("actual");

    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[0]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: predicted,
      realizeConfigured: async () => workspaceAt(actual, "git_worktree"),
      realizeIsolated: async () => { throw new Error("must not isolate"); },
    });

    expect(result.mode).toBe("exclusive");
    const actualIdentity = await claims.resolveIdentity(actual);
    expect(result.claimKey).toBe(actualIdentity.key);
  });

  it("admits exactly one of two concurrent runs to the shared checkout and isolates the other", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    const isolatedFor: Record<string, string> = {
      [runIds[0]!]: await makeDir("iso-0"),
      [runIds[1]!]: await makeDir("iso-1"),
    };

    const results = await Promise.all(runIds.map((runId) =>
      acquireSharedWorkspaceWriter({
        claims, companyId, agentId, heartbeatRunId: runId, issueId: null,
        expectSharedCheckout: true,
        predictedCwd: shared,
        realizeConfigured: async () => workspaceAt(shared, "project_primary"),
        realizeIsolated: async () => workspaceAt(isolatedFor[runId]!, "git_worktree"),
      }),
    ));

    // End state is what matters: every run got a directory, and no two runs got
    // the same one.
    const cwds = results.map((r) => r.workspace.cwd);
    expect(new Set(cwds).size).toBe(2);
    expect(results.filter((r) => r.mode === "exclusive")).toHaveLength(1);
    expect(results.filter((r) => r.mode === "isolated")).toHaveLength(1);
  });
});
