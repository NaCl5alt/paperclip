import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
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
  buildIsolationBranchNames,
  SharedWorkspaceIsolationError,
  STABLE_ISOLATION_SLOTS,
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
      resolveIsolationCandidateCwd: async () => { throw new Error("must not isolate"); },
      realizeIsolated: async () => { throw new Error("must not isolate"); },
      isolationAttempts: 1,
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
      resolveIsolationCandidateCwd: async () => isolated,
      realizeIsolated: async () => workspaceAt(isolated, "git_worktree"),
      isolationAttempts: 1,
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
      resolveIsolationCandidateCwd: async () => isolated,
      realizeIsolated: async () => workspaceAt(isolated, "git_worktree"),
      isolationAttempts: 1,
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
      resolveIsolationCandidateCwd: async () => { throw new Error("not a git checkout"); },
      realizeIsolated: async () => { throw new Error("not a git checkout"); },
      isolationAttempts: 1,
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
      resolveIsolationCandidateCwd: async () => isolated,
      realizeIsolated: async () => workspaceAt(isolated, "git_worktree"),
      isolationAttempts: 1,
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
      resolveIsolationCandidateCwd: async () => { throw new Error("must not isolate"); },
      realizeIsolated: async () => { throw new Error("must not isolate"); },
      isolationAttempts: 1,
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
      resolveIsolationCandidateCwd: async () => { throw new Error("must not isolate"); },
      realizeIsolated: async () => { throw new Error("must not isolate"); },
      isolationAttempts: 1,
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
        resolveIsolationCandidateCwd: async () => isolatedFor[runId]!,
        realizeIsolated: async () => workspaceAt(isolatedFor[runId]!, "git_worktree"),
        isolationAttempts: 1,
      }),
    ));

    // End state is what matters: every run got a directory, and no two runs got
    // the same one.
    const cwds = results.map((r) => r.workspace.cwd);
    expect(new Set(cwds).size).toBe(2);
    expect(results.filter((r) => r.mode === "exclusive")).toHaveLength(1);
    expect(results.filter((r) => r.mode === "isolated")).toHaveLength(1);
  });

  it("reuses the first isolation slot when nobody else holds it", async () => {
    // The reason slots are stable rather than run-scoped: routine contention must
    // not leave a fresh worktree behind on every single collision.
    const { companyId, agentId, runIds } = await seed(3);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");
    const slot1 = await makeDir("slot-1");
    const slots = [slot0, slot1];

    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    const first = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => slots[attempt] ?? null,
      realizeIsolated: async (attempt) => workspaceAt(slots[attempt]!, "git_worktree"),
      isolationAttempts: slots.length,
    });
    expect(first.workspace.cwd).toBe(slot0);

    // Once that run ends, the next contender takes the same slot back rather than
    // creating another directory.
    await claims.releaseForRun(runIds[1]!);
    const second = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[2]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => slots[attempt] ?? null,
      realizeIsolated: async (attempt) => workspaceAt(slots[attempt]!, "git_worktree"),
      isolationAttempts: slots.length,
    });
    expect(second.workspace.cwd).toBe(slot0);
  });

  it("moves to the next slot when the first is held by another live run", async () => {
    const { companyId, agentId, runIds } = await seed(3);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");
    const slot1 = await makeDir("slot-1");
    const slots = [slot0, slot1];

    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });
    await claims.claim({
      identity: await claims.resolveIdentity(slot0),
      companyId, agentId, heartbeatRunId: runIds[1]!,
    });

    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[2]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => slots[attempt] ?? null,
      realizeIsolated: async (attempt) => workspaceAt(slots[attempt]!, "git_worktree"),
      isolationAttempts: slots.length,
    });

    expect(result.mode).toBe("isolated");
    expect(result.workspace.cwd).toBe(slot1);
  });

  it("fails closed when every isolation slot is held by a live run", async () => {
    const { companyId, agentId, runIds } = await seed(3);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");

    for (const [index, dir] of [shared, slot0].entries()) {
      await claims.claim({
        identity: await claims.resolveIdentity(dir),
        companyId, agentId, heartbeatRunId: runIds[index]!,
      });
    }

    await expect(acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[2]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async () => slot0,
      realizeIsolated: async () => workspaceAt(slot0, "git_worktree"),
      isolationAttempts: 1,
    })).rejects.toBeInstanceOf(SharedWorkspaceIsolationError);
  });

  it("never realizes an isolation slot held by another live run", async () => {
    // Realizing a git worktree is not read-only: an existing worktree at the
    // target path is *reused*, which runs the configured provisionCommand inside
    // it. A stub that merely returns a path cannot show that, so this one records
    // the write the real code would perform.
    const { companyId, agentId, runIds } = await seed(3);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");
    const slot1 = await makeDir("slot-1");
    const slots = [slot0, slot1];
    const realizedInto: string[] = [];

    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });
    // Another live run is already working in slot 0.
    await claims.claim({
      identity: await claims.resolveIdentity(slot0),
      companyId, agentId, heartbeatRunId: runIds[1]!,
    });

    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[2]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => slots[attempt] ?? null,
      realizeIsolated: async (attempt) => {
        realizedInto.push(slots[attempt]!);
        return workspaceAt(slots[attempt]!, "git_worktree");
      },
      isolationAttempts: slots.length,
    });

    expect(result.workspace.cwd).toBe(slot1);
    // The point of the test: slot 0 was skipped without ever being realized.
    expect(realizedInto).toEqual([slot1]);
    expect(realizedInto).not.toContain(slot0);
    expect(result.claimedBeforeCheckout).toBe(true);
  });

  it("gives the slot back when realizing it fails", async () => {
    const { companyId, agentId, runIds } = await seed(3);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");
    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    await expect(acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async () => slot0,
      realizeIsolated: async () => { throw new Error("worktree add failed"); },
      isolationAttempts: 1,
    })).rejects.toBeInstanceOf(SharedWorkspaceIsolationError);

    // A slot reserved and then not used must not stay locked for the rest of the
    // failed run, or one bad realization would poison the slot for everyone.
    const slotIdentity = await claims.resolveIdentity(slot0);
    const stillHeld = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(stillHeld.some((row) => row.claimKey === slotIdentity.key)).toBe(false);

    // And the incumbent keeps the checkout it was legitimately using.
    expect(stillHeld.map((row) => row.heartbeatRunId)).toEqual([runIds[0]]);
  });

  it("still holds the claim when the slot did not exist until it was realized", async () => {
    // Production order: the candidate is claimed *before* it exists, so it is
    // keyed `path:<cwd>`; realization then creates it and the same directory
    // resolves to `inode:<dev>:<ino>`. Treating that key change as "the target
    // moved" would release the run's own claim and leave it writing an
    // unclaimed worktree — which the next contender would then find free.
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    // A realpath-canonical parent, matching production where the worktree path
    // is derived from `git rev-parse --show-toplevel`.
    const slotParent = await realpath(await makeDir("slots"));
    const slot0 = path.join(slotParent, "isolated-slot");

    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    const result = await acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => (attempt === 0 ? slot0 : null),
      realizeIsolated: async () => {
        await mkdir(slot0, { recursive: true });
        return workspaceAt(slot0, "git_worktree");
      },
      isolationAttempts: 2,
    });

    expect(result.mode).toBe("isolated");
    expect(result.workspace.cwd).toBe(slot0);

    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    const mine = active.filter((row) => row.heartbeatRunId === runIds[1]);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.cwd).toBe(slot0);
    // And it is keyed by the inode now, so a later contender computing the
    // identity of the realized directory collides with it.
    expect(mine[0]?.claimKey).toBe((await claims.resolveIdentity(slot0)).key);
  });

  it("refuses to hand back a directory this run does not hold", async () => {
    // Post-condition guard: whatever the bookkeeping does, a run must never be
    // released to write a worktree it cannot demonstrate ownership of.
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");
    const elsewhere = await makeDir("elsewhere");

    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });
    // Another live run owns wherever realization is going to land.
    await claims.claim({
      identity: await claims.resolveIdentity(elsewhere),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    await expect(acquireSharedWorkspaceWriter({
      claims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => (attempt === 0 ? slot0 : null),
      // Realization lands somewhere other than the claimed candidate, and that
      // somewhere is already owned.
      realizeIsolated: async () => workspaceAt(elsewhere, "git_worktree"),
      isolationAttempts: 1,
    })).rejects.toBeInstanceOf(SharedWorkspaceIsolationError);

    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active.every((row) => row.heartbeatRunId === runIds[0])).toBe(true);
  });

  it("fails closed if the ownership post-condition cannot be confirmed", async () => {
    // Pins the post-condition guard on its own. The `cwd`-comparison and the
    // same-row release guard are alternative fixes for the same hole, so neither
    // dies to a mutation of the other; this asserts the last line of defence
    // independently by forcing the ownership check to report false.
    const { companyId, agentId, runIds } = await seed(2);
    const shared = await makeDir("shared");
    const slot0 = await makeDir("slot-0");

    await claims.claim({
      identity: await claims.resolveIdentity(shared),
      companyId, agentId, heartbeatRunId: runIds[0]!,
    });

    const blindClaims = {
      ...claims,
      holdsActiveClaim: async () => false,
    } as typeof claims;

    await expect(acquireSharedWorkspaceWriter({
      claims: blindClaims, companyId, agentId, heartbeatRunId: runIds[1]!, issueId: null,
      expectSharedCheckout: true,
      predictedCwd: shared,
      realizeConfigured: async () => workspaceAt(shared, "project_primary"),
      resolveIsolationCandidateCwd: async (attempt) => (attempt === 0 ? slot0 : null),
      realizeIsolated: async () => workspaceAt(slot0, "git_worktree"),
      isolationAttempts: 1,
    })).rejects.toBeInstanceOf(SharedWorkspaceIsolationError);
  });
});

describe("buildIsolationBranchNames", () => {
  // Mirrors sanitizeBranchName in workspace-runtime.ts, whose 120-character
  // truncation is the hazard these names are shaped around.
  function sanitizeBranchName(value: string): string {
    return value
      .trim()
      .replace(/[^A-Za-z0-9._/-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-/.]+|[-/.]+$/g, "")
      .slice(0, 120) || "paperclip-work";
  }

  it("produces distinct candidates ending in a run-scoped one", () => {
    const names = buildIsolationBranchNames({ label: "PAP-4055", runId: "abcdef12-3456-7890-abcd-ef1234567890" });
    expect(names).toHaveLength(STABLE_ISOLATION_SLOTS + 1);
    expect(new Set(names).size).toBe(names.length);
    // The last candidate must always be free, or a fully occupied set of stable
    // slots would fail the run instead of isolating it.
    expect(names.at(-1)).toContain("abcdef12");
  });

  it("keeps two runs distinct after branch-name truncation", () => {
    // A label long enough to push a trailing suffix past 120 characters. If the
    // run id were appended rather than prefixed, both runs would sanitize to the
    // same branch and land in the same worktree.
    const label = "X".repeat(200);
    const a = buildIsolationBranchNames({ label, runId: "aaaaaaaa-0000-0000-0000-000000000000" });
    const b = buildIsolationBranchNames({ label, runId: "bbbbbbbb-0000-0000-0000-000000000000" });
    expect(sanitizeBranchName(a.at(-1)!)).not.toBe(sanitizeBranchName(b.at(-1)!));

    // The same must hold between the stable slots of a single run.
    const sanitized = a.map(sanitizeBranchName);
    expect(new Set(sanitized).size).toBe(sanitized.length);
  });
});
