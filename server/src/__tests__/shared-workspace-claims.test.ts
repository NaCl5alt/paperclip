import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, sharedWorkspaceClaims } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  resolveSharedWorkspaceIdentity,
  sharedWorkspaceClaimService,
} from "../services/shared-workspace-claims.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared workspace claim tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("sharedWorkspaceClaimService", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof sharedWorkspaceClaimService>;
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const started = await startEmbeddedPostgresTestDatabase("shared-workspace-claims");
    stopDb = started.stop;
    db = createDb(started.connectionString);
    svc = sharedWorkspaceClaimService(db);
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

  async function makeTempCheckout(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), "pc-claim-"));
    tempDirs.push(dir);
    const checkout = path.join(dir, "checkout");
    await mkdir(checkout, { recursive: true });
    return checkout;
  }

  async function seed(runCount = 2, status = "running") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Acme",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Worker",
      adapterType: "claude_local",
      status: "idle",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const runIds: string[] = [];
    for (let i = 0; i < runCount; i += 1) {
      const runId = randomUUID();
      runIds.push(runId);
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "manual",
        status,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }
    return { companyId, agentId, runIds };
  }

  it("admits exactly one of two concurrent claims on the same directory", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const cwd = await makeTempCheckout();
    const identity = await resolveSharedWorkspaceIdentity(cwd);

    // The race the mechanism exists for: two runs realize the same shared
    // checkout at the same instant. Without the partial unique index both of
    // these return claimed: true and the fleet double-writes the directory.
    const [a, b] = await Promise.all(
      runIds.map((runId) =>
        svc.claim({ identity, companyId, agentId, heartbeatRunId: runId }),
      ),
    );

    expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1);
    const loser = a.claimed ? b : a;
    const winner = a.claimed ? a : b;
    expect(loser.owner?.heartbeatRunId).toBe(winner.claim?.heartbeatRunId);

    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active).toHaveLength(1);
  });

  it("admits exactly one writer under an 8-way concurrent claim", async () => {
    const { companyId, agentId, runIds } = await seed(8);
    const cwd = await makeTempCheckout();
    const identity = await resolveSharedWorkspaceIdentity(cwd);

    const results = await Promise.all(
      runIds.map((runId) =>
        svc.claim({ identity, companyId, agentId, heartbeatRunId: runId }),
      ),
    );

    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active).toHaveLength(1);
  });

  it("treats two runs of the same agent as competing writers", async () => {
    // Same agent, two live runs, one shared checkout — the case that motivated
    // enforcement. Agent identity must not be mistaken for writer identity.
    const { companyId, agentId, runIds } = await seed(2);
    const cwd = await makeTempCheckout();
    const identity = await resolveSharedWorkspaceIdentity(cwd);

    const first = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });
    const second = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[1]! });

    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
    expect(second.owner?.heartbeatRunId).toBe(runIds[0]);
  });

  it("is idempotent for the run that already owns the claim", async () => {
    const { companyId, agentId, runIds } = await seed(1);
    const cwd = await makeTempCheckout();
    const identity = await resolveSharedWorkspaceIdentity(cwd);

    const first = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });
    const again = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });

    expect(first.claimed).toBe(true);
    expect(again.claimed).toBe(true);
    expect(again.claim?.id).toBe(first.claim?.id);
  });

  it("keys on the physical directory, so aliased paths contend", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const cwd = await makeTempCheckout();
    const aliasParent = await mkdtemp(path.join(tmpdir(), "pc-alias-"));
    tempDirs.push(aliasParent);
    const alias = path.join(aliasParent, "link");
    await symlink(cwd, alias);

    // Same directory, three spellings: symlink, trailing slash, and a "." hop.
    const direct = await resolveSharedWorkspaceIdentity(cwd);
    const viaSymlink = await resolveSharedWorkspaceIdentity(alias);
    const viaSlash = await resolveSharedWorkspaceIdentity(`${cwd}/./`);

    expect(viaSymlink.key).toBe(direct.key);
    expect(viaSlash.key).toBe(direct.key);
    expect(direct.source).toBe("inode");

    const first = await svc.claim({ identity: direct, companyId, agentId, heartbeatRunId: runIds[0]! });
    const second = await svc.claim({ identity: viaSymlink, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
  });

  it("does not confuse two distinct directories", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const a = await resolveSharedWorkspaceIdentity(await makeTempCheckout());
    const b = await resolveSharedWorkspaceIdentity(await makeTempCheckout());
    expect(a.key).not.toBe(b.key);

    const first = await svc.claim({ identity: a, companyId, agentId, heartbeatRunId: runIds[0]! });
    const second = await svc.claim({ identity: b, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(true);
  });

  it("releases the claim at run end so the next run may take it", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const identity = await resolveSharedWorkspaceIdentity(await makeTempCheckout());

    await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });
    const blocked = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(blocked.claimed).toBe(false);

    expect(await svc.releaseForRun(runIds[0]!)).toBe(1);

    const afterRelease = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(afterRelease.claimed).toBe(true);
  });

  it("steals a claim whose owning run reached a terminal status", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const identity = await resolveSharedWorkspaceIdentity(await makeTempCheckout());

    await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });
    // Crash path: the run ended without going through the release hook.
    await db
      .update(heartbeatRuns)
      .set({ status: "failed" })
      .where(eq(heartbeatRuns.id, runIds[0]!));

    const stolen = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(stolen.claimed).toBe(true);
    expect(stolen.claim?.heartbeatRunId).toBe(runIds[1]);
  });

  it("never steals from a live owner, however long it has been silent", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const identity = await resolveSharedWorkspaceIdentity(await makeTempCheckout());

    await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });

    // `heartbeat_runs.updated_at` only advances when the adapter emits output, so
    // a run inside one long silent tool call looks identical to a dead one by
    // timestamp. Ageing the clock must not hand its checkout to a second writer:
    // that is the exact overwrite this service exists to prevent.
    await db
      .update(heartbeatRuns)
      .set({ updatedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(heartbeatRuns.id, runIds[0]!));
    await db
      .update(sharedWorkspaceClaims)
      .set({ heartbeatAt: new Date(Date.now() - 24 * 60 * 60 * 1000) })
      .where(eq(sharedWorkspaceClaims.heartbeatRunId, runIds[0]!));

    const aDayLater = sharedWorkspaceClaimService(db, {
      now: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const blocked = await aDayLater.claim({ identity, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(blocked.claimed).toBe(false);
    expect(blocked.owner?.heartbeatRunId).toBe(runIds[0]);

    // And the backstop sweep must agree: a live run's claim is not stale.
    expect(await aDayLater.reapStaleClaims()).toBe(0);
  });

  it("contends on the path when the directory is recreated under a new inode", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const cwd = await makeTempCheckout();
    const first = await resolveSharedWorkspaceIdentity(cwd);
    await svc.claim({ identity: first, companyId, agentId, heartbeatRunId: runIds[0]! });

    // A checkout repaired by delete-and-reclone keeps its path but gets a new
    // inode. Keying on the inode alone would let the next run walk straight in
    // while the first is still writing.
    await rm(cwd, { recursive: true, force: true });
    await mkdir(cwd, { recursive: true });
    const recreated = await resolveSharedWorkspaceIdentity(cwd);
    expect(recreated.key).not.toBe(first.key);
    expect(recreated.cwd).toBe(first.cwd);

    const blocked = await svc.claim({ identity: recreated, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(blocked.claimed).toBe(false);
    expect(blocked.owner?.heartbeatRunId).toBe(runIds[0]);
  });

  it("normalizes the path fallback for a directory that does not exist yet", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const parent = await makeTempCheckout();
    const missing = path.join(parent, "not-created-yet");

    // Before realization the directory has no inode, so the key falls back to the
    // path — which must still be canonical, or two spellings of one future
    // checkout would each claim it.
    const direct = await resolveSharedWorkspaceIdentity(missing);
    const viaDotHop = await resolveSharedWorkspaceIdentity(path.join(parent, ".", "not-created-yet"));
    expect(direct.source).toBe("path");
    expect(direct.key).toBe(`path:${direct.cwd}`);
    expect(viaDotHop.key).toBe(direct.key);

    const first = await svc.claim({ identity: direct, companyId, agentId, heartbeatRunId: runIds[0]! });
    const second = await svc.claim({ identity: viaDotHop, companyId, agentId, heartbeatRunId: runIds[1]! });
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBe(false);
  });

  it("treats queued and scheduled_retry owners as live", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const identity = await resolveSharedWorkspaceIdentity(await makeTempCheckout());
    await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });

    for (const status of ["queued", "scheduled_retry"]) {
      await db
        .update(heartbeatRuns)
        .set({ status })
        .where(eq(heartbeatRuns.id, runIds[0]!));
      const blocked = await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[1]! });
      expect(blocked.claimed, `status ${status} must not be stealable`).toBe(false);
    }
  });

  it("reaps claims left behind by runs that are no longer live", async () => {
    const { companyId, agentId, runIds } = await seed(2);
    const identity = await resolveSharedWorkspaceIdentity(await makeTempCheckout());

    await svc.claim({ identity, companyId, agentId, heartbeatRunId: runIds[0]! });
    await db
      .update(heartbeatRuns)
      .set({ status: "cancelled" })
      .where(eq(heartbeatRuns.id, runIds[0]!));

    expect(await svc.reapStaleClaims()).toBe(1);
    const active = await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(eq(sharedWorkspaceClaims.status, "active"));
    expect(active).toHaveLength(0);
  });
});
