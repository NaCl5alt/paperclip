import { describe, expect, it } from "vitest";
import {
  ACCOUNT_FAILURE_GATE_DEFAULT_MAX_FAILURE_AGE_MS,
  AUTH_REQUIRED_ERROR_CODES,
  type AccountRunOutcome,
  classifyAccountFailureGate,
  deriveAccountKey,
  errorTextAssertsCredentialFailure,
} from "./account-failure-gate.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

// Verbatim from the live fleet: the terse string the claude-local adapter writes
// when the credential really is gone, and the string every run of the real
// 2026-09-05 default-account outage carried.
const GENUINE_LOGIN_ERROR = "Claude run failed: subtype=success: Not logged in \u00b7 Please run /login";
const GENUINE_OAUTH_ERROR =
  "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed";

function run(overrides: Partial<AccountRunOutcome> & { runId: string }): AccountRunOutcome {
  return {
    status: "failed",
    errorCode: null,
    // Default to a corroborated credential failure so the tests below stay about
    // the property each one names; the tests that are about corroboration pass
    // an explicit errorText.
    errorText: GENUINE_LOGIN_ERROR,
    finishedAt: minutesAgo(1),
    ...overrides,
  };
}

describe("deriveAccountKey", () => {
  it("keys claude agents by their explicit CLAUDE_CONFIG_DIR", () => {
    expect(deriveAccountKey("claude-local", { CLAUDE_CONFIG_DIR: "/home/u/.claude_revorn" }))
      .toBe("claude:/home/u/.claude_revorn");
  });

  it("groups claude agents with no explicit config dir under one shared default account", () => {
    // The default ~/.claude is a real shared credential scope across many
    // agents, so the absent case must collide into one key, not stay distinct.
    const a = deriveAccountKey("claude-local", {});
    const b = deriveAccountKey("claude_local", { OTHER: "x" });
    expect(a).toBe("claude:__default__");
    expect(b).toBe("claude:__default__");
    expect(a).toBe(b);
  });

  it("separates distinct config dirs into distinct accounts", () => {
    expect(deriveAccountKey("claude-local", { CLAUDE_CONFIG_DIR: "/a" }))
      .not.toBe(deriveAccountKey("claude-local", { CLAUDE_CONFIG_DIR: "/b" }));
  });

  it("returns null for adapter families that are not credential-gated", () => {
    expect(deriveAccountKey("http", { CLAUDE_CONFIG_DIR: "/a" })).toBeNull();
    expect(deriveAccountKey(null, {})).toBeNull();
    expect(deriveAccountKey("", {})).toBeNull();
  });

  // Regression (VANA-4064): the live fleet stores CLAUDE_CONFIG_DIR as the
  // `{ type: "plain", value }` binding record, not a bare string. Reading only
  // the bare-string form made 19 of 44 claude agents — three distinct accounts
  // (~/.claude, ~/.claude_revorn, ~/.claude_nishika) — resolve to the single
  // default sentinel, so one account's auth break gated the whole fleet and no
  // single account could stay gated once any other account ran successfully.
  it("reads a plain env binding record, not only a bare string", () => {
    expect(
      deriveAccountKey("claude_local", {
        CLAUDE_CONFIG_DIR: { type: "plain", value: "/home/u/.claude_revorn" },
      }),
    ).toBe("claude:/home/u/.claude_revorn");
  });

  it("does not collapse record-shaped config dirs onto the default account", () => {
    const revorn = deriveAccountKey("claude_local", {
      CLAUDE_CONFIG_DIR: { type: "plain", value: "/home/u/.claude_revorn" },
    });
    const nishika = deriveAccountKey("claude_local", {
      CLAUDE_CONFIG_DIR: { type: "plain", value: "/home/u/.claude_nishika" },
    });
    const dflt = deriveAccountKey("claude_local", {});
    expect(new Set([revorn, nishika, dflt]).size).toBe(3);
  });

  it("fails open on a binding it cannot resolve instead of assuming the default account", () => {
    // A secret-backed config dir is a real account whose identity is unknown
    // here; folding it into `__default__` would gate unrelated agents.
    expect(
      deriveAccountKey("claude_local", {
        CLAUDE_CONFIG_DIR: { type: "secret", secretId: "s1" },
      }),
    ).toBeNull();
    expect(deriveAccountKey("claude_local", { CLAUDE_CONFIG_DIR: 12 })).toBeNull();
  });

  it("resolves acpx and gemini families", () => {
    expect(deriveAccountKey("acpx-local", { ACPX_CONFIG_DIR: "/x" })).toBe("acpx:/x");
    expect(deriveAccountKey("gemini-local", {})).toBe("gemini:__default__");
  });
});

describe("classifyAccountFailureGate", () => {
  const key = "claude:/home/u/.claude";

  it("arms when the account's most recent terminal run is an auth-required failure", () => {
    const gate = classifyAccountFailureGate(
      key,
      [run({ runId: "r1", errorCode: "claude_auth_required", finishedAt: minutesAgo(2) })],
      { now },
    );
    expect(gate).toEqual({
      accountKey: key,
      errorCode: "claude_auth_required",
      sinceRunId: "r1",
      sinceFinishedAt: minutesAgo(2),
    });
  });

  it("arms for every auth-required code", () => {
    for (const errorCode of AUTH_REQUIRED_ERROR_CODES) {
      const gate = classifyAccountFailureGate(key, [run({ runId: "r", errorCode })], { now });
      expect(gate?.errorCode).toBe(errorCode);
    }
  });

  it("uses the latest terminal run across the account, not run order", () => {
    // Unordered history: an older success must not release a newer auth failure.
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "old-ok", status: "succeeded", finishedAt: minutesAgo(30) }),
        run({ runId: "new-auth", errorCode: "acpx_auth_required", finishedAt: minutesAgo(3) }),
        run({ runId: "mid-ok", status: "succeeded", finishedAt: minutesAgo(10) }),
      ],
      { now },
    );
    expect(gate?.sinceRunId).toBe("new-auth");
  });

  // --- auto-release on observed recovery (never on time alone) ---

  it("releases as soon as a newer successful run is observed", () => {
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(5) }),
        run({ runId: "ok", status: "succeeded", finishedAt: minutesAgo(1) }),
      ],
      { now },
    );
    expect(gate).toBeNull();
  });

  // --- uninformative outcomes must not be read as recovery (VANA-4067 B-I1) ---
  //
  // The gate ships alongside the VANA-3914 auth handoff, which reassigns an
  // issue when it sees `claude_auth_required` and thereby cancels every queued
  // run on the old assignee with `issue_assignee_changed`. Those cancellations
  // land immediately *after* the auth failure that armed the gate. Under the
  // earlier "any non-auth latest outcome releases" rule the handoff therefore
  // released the gate it had just armed: replaying the real 2026-09-05
  // default-account outage produced 601 gate flips, 19.6% of the window
  // un-gated, and 295 of 301 releases attributable to that one cancellation.

  it("does not release the gate on the cancellation the auth handoff itself emits", () => {
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(5) }),
        run({
          runId: "handoff-cancel",
          status: "cancelled",
          errorCode: "issue_assignee_changed",
          finishedAt: minutesAgo(1),
        }),
      ],
      { now },
    );
    expect(gate?.sinceRunId).toBe("auth");
  });

  it("does not release the gate on an unrelated failure that never touched the credential", () => {
    for (const errorCode of ["adapter_failed", "claude_transient_upstream", "process_lost", "timeout"]) {
      const gate = classifyAccountFailureGate(
        key,
        [
          run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(5) }),
          run({ runId: "noise", errorCode, finishedAt: minutesAgo(1) }),
        ],
        { now },
      );
      expect(gate?.sinceRunId).toBe("auth");
    }
  });

  it("does not release the gate on a fail-closed shared-workspace isolation", () => {
    // The other half of the merged change. A contended checkout that could not
    // be isolated is a directory conflict, so it neither arms nor releases the
    // credential gate.
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(5) }),
        run({ runId: "fail-close", errorCode: "shared_workspace_isolation_failed", finishedAt: minutesAgo(1) }),
      ],
      { now },
    );
    expect(gate?.sinceRunId).toBe("auth");
  });

  it("reads past an arbitrarily long run of uninformative outcomes to the deciding one", () => {
    // Skipping, not releasing: no volume of cancellations can bury the auth
    // failure, which is what makes the SQL pre-filter in heartbeat.ts necessary
    // rather than an optimisation.
    const history: AccountRunOutcome[] = [
      run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(40) }),
    ];
    for (let i = 0; i < 200; i += 1) {
      history.push(run({
        runId: `cancel-${i}`,
        status: "cancelled",
        errorCode: "issue_assignee_changed",
        finishedAt: minutesAgo(30 - i * 0.1),
      }));
    }
    expect(classifyAccountFailureGate(key, history, { now })?.sinceRunId).toBe("auth");
  });

  it("still bounds total suppression by the re-probe window, not by the skipped runs", () => {
    // Skipping cannot strand an account forever: the age check is measured from
    // the auth failure itself, so a stale failure buried under fresh
    // cancellations still lets a probe through.
    const stale = new Date(now.getTime() - ACCOUNT_FAILURE_GATE_DEFAULT_MAX_FAILURE_AGE_MS - 60_000);
    expect(
      classifyAccountFailureGate(
        key,
        [
          run({ runId: "old-auth", errorCode: "claude_auth_required", finishedAt: stale }),
          run({ runId: "cancel", status: "cancelled", errorCode: "issue_assignee_changed", finishedAt: minutesAgo(1) }),
        ],
        { now },
      ),
    ).toBeNull();
  });

  it("still releases on a real success that follows the uninformative runs", () => {
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(10) }),
        run({ runId: "cancel", status: "cancelled", errorCode: "issue_assignee_changed", finishedAt: minutesAgo(5) }),
        run({ runId: "ok", status: "succeeded", errorCode: null, finishedAt: minutesAgo(1) }),
      ],
      { now },
    );
    expect(gate).toBeNull();
  });

  it("does not gate when the only informative run is a success, whatever follows it", () => {
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "ok", status: "succeeded", errorCode: null, finishedAt: minutesAgo(10) }),
        run({ runId: "cancel", status: "cancelled", errorCode: "issue_assignee_changed", finishedAt: minutesAgo(1) }),
      ],
      { now },
    );
    expect(gate).toBeNull();
  });

  // --- fail-open cases: the gate can only ever suppress, never fabricate one ---

  it("does not gate on an empty history (fail-open)", () => {
    expect(classifyAccountFailureGate(key, [], { now })).toBeNull();
  });

  it("does not gate a true transient adapter/upstream failure", () => {
    for (const errorCode of ["adapter_failed", "claude_transient_upstream", "timeout", "provider_quota"]) {
      expect(classifyAccountFailureGate(key, [run({ runId: "t", errorCode })], { now })).toBeNull();
    }
  });

  it("ignores runs that have not reached a terminal (finishedAt) state", () => {
    expect(
      classifyAccountFailureGate(
        key,
        [run({ runId: "live", errorCode: "claude_auth_required", finishedAt: null })],
        { now },
      ),
    ).toBeNull();
  });

  it("stops gating once the failure is older than the re-probe window", () => {
    const stale = new Date(now.getTime() - ACCOUNT_FAILURE_GATE_DEFAULT_MAX_FAILURE_AGE_MS - 60_000);
    expect(
      classifyAccountFailureGate(
        key,
        [run({ runId: "old-auth", errorCode: "claude_auth_required", finishedAt: stale })],
        { now },
      ),
    ).toBeNull();
  });

  it("still gates a fresh failure within the re-probe window", () => {
    const fresh = new Date(now.getTime() - ACCOUNT_FAILURE_GATE_DEFAULT_MAX_FAILURE_AGE_MS + 60_000);
    expect(
      classifyAccountFailureGate(
        key,
        [run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: fresh })],
        { now },
      ),
    ).not.toBeNull();
  });

  // --- the code alone is not evidence (VANA-4067 B-II1) ---
  //
  // `detectClaudeLoginRequired()` matches the legacy auth regex against the
  // adapter's whole stream-json stdout, which contains the echoed prompt and
  // every file the agent read. Measured over 90 days on the live fleet, 66 of
  // the 79 runs stored as `claude_auth_required` carry no auth wording in their
  // own error at all. Arming on the code alone turns each of those into up to a
  // full re-probe window of silence for every agent on the account (25 agents on
  // the default one, 41 times in 90 days) — the gate manufacturing an outage,
  // which its whole design forbids.

  it.each([
    ["a session-limit rejection", "Claude run failed: subtype=success: You've hit your session limit \u00b7 resets 6pm (Asia/Tokyo)"],
    ["a DNS failure", "Claude run failed: subtype=success: API Error: Unable to connect to API (ENOTFOUND)"],
    ["a truncated response", "Claude run failed: subtype=success: API Error: Connection closed mid-response."],
    ["a spend-limit rejection", "Claude run failed: subtype=success: You've hit your org's monthly spend limit"],
    ["an ordinary completion report", "Claude run failed: subtype=success: Heartbeat complete on [VANA-1045]. What changed: ..."],
  ])("does not arm on %s misclassified as auth-required", (_label, errorText) => {
    expect(
      classifyAccountFailureGate(
        key,
        [run({ runId: "misclassified", errorCode: "claude_auth_required", errorText, finishedAt: minutesAgo(2) })],
        { now },
      ),
    ).toBeNull();
  });

  it("still arms on the terse errors the adapter writes for a real credential failure", () => {
    for (const errorText of [GENUINE_LOGIN_ERROR, GENUINE_OAUTH_ERROR]) {
      expect(
        classifyAccountFailureGate(
          key,
          [run({ runId: "real", errorCode: "claude_auth_required", errorText, finishedAt: minutesAgo(2) })],
          { now },
        )?.sinceRunId,
      ).toBe("real");
    }
    // The gemini adapter's own wording, which must survive the same predicate.
    expect(
      classifyAccountFailureGate(
        key,
        [run({
          runId: "gemini",
          errorCode: "gemini_auth_required",
          errorText: "Authentication required. Please visit the URL to log in:",
          finishedAt: minutesAgo(2),
        })],
        { now },
      )?.sinceRunId,
    ).toBe("gemini");
  });

  it("skips an uncorroborated auth code rather than reading it as recovery", () => {
    // Skipped, not released: a session limit is no more proof the credential
    // works than proof it is broken, so an older corroborated failure still
    // governs.
    const gate = classifyAccountFailureGate(
      key,
      [
        run({ runId: "real-auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(10) }),
        run({
          runId: "session-limit",
          errorCode: "claude_auth_required",
          errorText: "Claude run failed: subtype=success: You've hit your session limit",
          finishedAt: minutesAgo(1),
        }),
      ],
      { now },
    );
    expect(gate?.sinceRunId).toBe("real-auth");
  });

  it("does not arm on an agent narrative that merely quotes a login prompt", () => {
    // The one residual false positive in the 90-day sample: a 1,616-character
    // completion report whose body quoted the adapter's own login prompt as
    // sample output, roughly 500 characters in. Bounding the haystack to a
    // prefix is what excludes it, so this run must not arm even though the
    // wording is present.
    //
    // The offset here is a literal, deliberately: deriving it from
    // ACCOUNT_GATE_CREDENTIAL_ERROR_TEXT_MAX_CHARS would make the fixture track
    // the constant and the test would survive any widening of the bound.
    const narrative =
      "Claude run failed: subtype=success: " +
      "x".repeat(500) +
      " Not logged in \u00b7 Please run /login";
    expect(
      classifyAccountFailureGate(
        key,
        [run({ runId: "narrative", errorCode: "claude_auth_required", errorText: narrative, finishedAt: minutesAgo(2) })],
        { now },
      ),
    ).toBeNull();
  });

  it("does not arm when the error text is missing entirely", () => {
    // A caller that fails to read `heartbeat_runs.error` must fail open, never
    // arm on the code alone.
    for (const errorText of [null, ""]) {
      expect(
        classifyAccountFailureGate(
          key,
          [run({ runId: "no-text", errorCode: "claude_auth_required", errorText, finishedAt: minutesAgo(2) })],
          { now },
        ),
      ).toBeNull();
    }
  });

  it("leaves release-on-success independent of the error text", () => {
    // Corroboration constrains arming only. A successful run releases the gate
    // whatever its (empty) error text says.
    expect(
      classifyAccountFailureGate(
        key,
        [
          run({ runId: "auth", errorCode: "claude_auth_required", finishedAt: minutesAgo(5) }),
          run({ runId: "ok", status: "succeeded", errorCode: null, errorText: null, finishedAt: minutesAgo(1) }),
        ],
        { now },
      ),
    ).toBeNull();
  });

  // --- before/after evidence: one dead account no longer multiplies retries ---

  it("suppresses N-1 of N per-issue wakes on a shared dead account (was N runs → 1)", () => {
    const N = 74; // parent VANA-4041 measured this fan-out for one credential outage
    // Run 1 is the first dispatch on the account; it auth-fails and becomes the
    // account's latest terminal outcome. Every subsequent per-issue wake now
    // consults the same account history and is gated.
    const accountHistory: AccountRunOutcome[] = [
      run({ runId: "issue-1-run", errorCode: "claude_auth_required", finishedAt: minutesAgo(5) }),
    ];
    let dispatched = 1; // the first run that surfaced the failure
    let suppressed = 0;
    for (let i = 2; i <= N; i += 1) {
      const gate = classifyAccountFailureGate(key, accountHistory, { now });
      if (gate) suppressed += 1;
      else dispatched += 1;
    }
    expect(dispatched).toBe(1);
    expect(suppressed).toBe(N - 1);
  });
});

describe("errorTextAssertsCredentialFailure", () => {
  // Both sides of the bound are pinned with literal offsets taken from the
  // measured fleet data, never from ACCOUNT_GATE_CREDENTIAL_ERROR_TEXT_MAX_CHARS
  // itself. A fixture built from the constant moves with it, so widening or
  // shrinking the bound would leave the test passing.
  it("matches every genuine adapter error, which all sit at the front of the string", () => {
    // Verbatim, with their real offsets: claude at 35, gemini at 0, and the
    // longest genuine string on the fleet at 69 characters.
    for (const errorText of [
      "Claude run failed: subtype=success: Not logged in \u00b7 Please run /login",
      "Claude run failed: subtype=success: Failed to authenticate: OAuth session expired and could not be refreshed",
      "Authentication required. Please visit the URL to log in:",
    ]) {
      expect(errorTextAssertsCredentialFailure(errorText)).toBe(true);
    }
    // Margin: still matched a full 120 characters in, well past any genuine
    // error, so the bound cannot be shrunk to the point of dropping real ones
    // without failing here.
    expect(errorTextAssertsCredentialFailure("x".repeat(120) + " authentication required")).toBe(true);
  });

  it("ignores wording that appears only deep inside a long narrative", () => {
    // The residual false-positive shape: quoted output ~500 characters into a
    // 1,616-character completion report.
    expect(errorTextAssertsCredentialFailure("x".repeat(500) + " authentication required")).toBe(false);
    expect(errorTextAssertsCredentialFailure("x".repeat(1200) + " not logged in")).toBe(false);
  });

  it("is case-insensitive and rejects non-strings", () => {
    expect(errorTextAssertsCredentialFailure("FAILED TO AUTHENTICATE")).toBe(true);
    expect(errorTextAssertsCredentialFailure(null)).toBe(false);
    expect(errorTextAssertsCredentialFailure(undefined)).toBe(false);
  });
});
