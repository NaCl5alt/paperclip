import { describe, expect, it } from "vitest";
import {
  ACCOUNT_FAILURE_GATE_DEFAULT_MAX_FAILURE_AGE_MS,
  AUTH_REQUIRED_ERROR_CODES,
  type AccountRunOutcome,
  classifyAccountFailureGate,
  deriveAccountKey,
} from "./account-failure-gate.js";

const now = new Date("2026-09-07T12:00:00.000Z");
const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000);

function run(overrides: Partial<AccountRunOutcome> & { runId: string }): AccountRunOutcome {
  return {
    status: "failed",
    errorCode: null,
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
