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

  // `error` is required, not defaulted: arming corroborates the error code
  // against the run's own error text (VANA-4067 B-II1), so a fixture that omits
  // it would quietly stop exercising the gate. Making the compiler ask keeps
  // every case in this file explicit about which text it is asserting on.
  async function recordTerminalRun(
    companyId: string,
    agentId: string,
    opts: { status: string; errorCode: string | null; error: string | null; finishedAt: Date },
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
      error: opts.error,
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

  // The terse string the claude-local adapter writes when the credential really
  // is gone. Verbatim from the live fleet.
  const AUTH_ERROR_TEXT =
    "Claude run failed: subtype=success: Not logged in \u00b7 Please run /login";

  it("suppresses an automated wake to an agent sharing a dead account", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: AUTH_ERROR_TEXT,
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
      error: AUTH_ERROR_TEXT,
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
      error: AUTH_ERROR_TEXT,
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
      error: AUTH_ERROR_TEXT,
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
      error: null,
      finishedAt: minutesAgo(1),
    });

    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).not.toBeNull();
  });

  // ── release condition: only observed recovery releases (VANA-4067 B-I1) ────

  it("stays gated when the auth handoff cancels the account's queued runs", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: AUTH_ERROR_TEXT,
      finishedAt: minutesAgo(10),
    });
    // Exactly what the co-shipped VANA-3914 failover produces: it reassigns the
    // issue away from the dead account, and every queued run on the old
    // assignee is cancelled with this code — newer than the auth failure that
    // armed the gate. Reading it as "recovery" let the handoff release the gate
    // it had just armed.
    await recordTerminalRun(companyId, dead, {
      status: "cancelled",
      errorCode: "issue_assignee_changed",
      error: `Claude run failed: subtype=success: issue_assignee_changed`,
      finishedAt: minutesAgo(1),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();
    expect(await runsFor(sibling)).toHaveLength(0);
  });

  it("finds the deciding run even when more cancellations follow it than the query fetches", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: AUTH_ERROR_TEXT,
      finishedAt: minutesAgo(30),
    });
    // This is the assertion the pure classifier cannot make. The classifier
    // skips uninformative runs, but it can only skip what it was handed: the
    // enforcement query fetches a bounded, finishedAt-ordered window, so unless
    // that query filters too, a cancellation burst fills the window and the
    // auth failure is never read at all. During the real outage the account
    // produced hundreds of these in minutes.
    for (let i = 0; i < 12; i += 1) {
      await recordTerminalRun(companyId, dead, {
        status: "cancelled",
        errorCode: "issue_assignee_changed",
        error: `Claude run failed: subtype=success: issue_assignee_changed`,
        finishedAt: minutesAgo(20 - i),
      });
    }

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();
  });

  it("still releases on a real success recorded after the cancellations", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: AUTH_ERROR_TEXT,
      finishedAt: minutesAgo(30),
    });
    for (let i = 0; i < 12; i += 1) {
      await recordTerminalRun(companyId, dead, {
        status: "cancelled",
        errorCode: "issue_assignee_changed",
        error: `Claude run failed: subtype=success: issue_assignee_changed`,
        finishedAt: minutesAgo(20 - i),
      });
    }

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();

    // Suppression is still bounded by evidence, not by exhaustion: one real
    // success on the account clears it even under the same cancellation noise.
    await recordTerminalRun(companyId, dead, {
      status: "succeeded",
      errorCode: null,
      error: null,
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
      error: AUTH_ERROR_TEXT,
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
    //
    // The code seeded here is the one a fail-close actually writes; the
    // end-to-end proof that a real fail-close records it (rather than the
    // generic `adapter_failed` it used to collapse onto) is in
    // `heartbeat-shared-checkout-isolation.test.ts`. Both are needed: without
    // that test this seed asserts a code no production path emits.
    await recordTerminalRun(companyId, contended, {
      status: "failed",
      errorCode: "shared_workspace_isolation_failed",
      error: `Claude run failed: subtype=success: shared_workspace_isolation_failed`,
      finishedAt: minutesAgo(1),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).not.toBeNull();
  });

  it("does not let a fail-closed isolation release a gate that a real auth failure armed", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: AUTH_ERROR_TEXT,
      finishedAt: minutesAgo(10),
    });
    // The interaction in the direction the specificity test above cannot see:
    // the fail-close is newer than the auth failure, so under a "latest
    // non-auth outcome releases" rule the shared-checkout half of this merge
    // would switch the credential gate off for the whole account.
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "shared_workspace_isolation_failed",
      error: `Claude run failed: subtype=success: shared_workspace_isolation_failed`,
      finishedAt: minutesAgo(1),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();
  });
  // --- the error code alone must not arm the gate (VANA-4067 B-II1) ---

  it("does not suppress the account when an auth code is not corroborated by the run's own error", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Misclassified", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    // Verbatim from the live fleet: a session-limit rejection stored as
    // `claude_auth_required` because `detectClaudeLoginRequired()` scans the
    // whole stream-json stdout, prompt echo included. 66 of the 79 runs carrying
    // this code over 90 days are of this shape. Arming on the code alone would
    // silence all 25 agents on the default account for up to the re-probe
    // window, 41 times in 90 days.
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: "Claude run failed: subtype=success: You've hit your session limit \u00b7 resets 6pm (Asia/Tokyo)",
      finishedAt: minutesAgo(5),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).not.toBeNull();
  });

  it("does not let an uncorroborated auth code bury the real failure that armed the gate", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error: AUTH_ERROR_TEXT,
      finishedAt: minutesAgo(30),
    });
    // Enough misclassified rows to overrun the LIMIT window the fetch uses. They
    // must be filtered out in SQL, not merely skipped in memory: if they reach
    // the window they push the corroborated failure out of it and the gate goes
    // quiet during a real outage. Skipping (not releasing) is what this asserts.
    for (let i = 0; i < 8; i += 1) {
      await recordTerminalRun(companyId, dead, {
        status: "failed",
        errorCode: "claude_auth_required",
        error: "Claude run failed: subtype=success: API Error: Unable to connect to API (ENOTFOUND)",
        finishedAt: minutesAgo(20 - i),
      });
    }

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();
  });

  it("still suppresses on the OAuth-expiry wording of the real 2026-09-05 outage", async () => {
    const companyId = await seedCompany();
    const dead = await seedClaudeAgent(companyId, "Dead", "/tmp/acct-a");
    const sibling = await seedClaudeAgent(companyId, "Sibling", "/tmp/acct-a");
    // All 2,088 runs of that outage carried this string. Narrowing the arming
    // predicate must not cost the case the gate exists for.
    await recordTerminalRun(companyId, dead, {
      status: "failed",
      errorCode: "claude_auth_required",
      error:
        "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed",
      finishedAt: minutesAgo(5),
    });

    const heartbeat = heartbeatService(db);
    expect(
      await heartbeat.wakeup(sibling, { source: "automation", triggerDetail: "issue_assigned" }),
    ).toBeNull();
  });
});
