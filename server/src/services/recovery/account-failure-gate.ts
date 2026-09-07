// Account-level failure-suppression gate (VANA-4048, derived from VANA-4041).
//
// Problem: a *deterministic* failure (an expired/absent credential — the
// `*_auth_required` adapter codes) does not heal by retrying, yet the retry
// budget is scoped per issue. One dead account therefore multiplies wasted
// runs by the number of issues that share it (VANA-4041 measured ~2,474 runs
// across 74 issues for a single credential outage). The unit that is actually
// broken is the *account* (the credential scope, e.g. `CLAUDE_CONFIG_DIR`) —
// not the agent and not the issue — so every agent that shares that account
// should stop dispatching until the credential is restored.
//
// This module is the pure, side-effect-free core of the gate. It answers one
// question from already-observed run history: "is this account currently in a
// confirmed auth-failure state?" There is no stored gate state and no new
// write path — the gate is *derived* from recent terminal runs. Two properties
// fall out of that for free:
//   * Auto-release on recovery: the gate keys on the account's most-recent
//     terminal outcome, so the next successful (or non-auth) run clears it.
//     Release never depends on time elapsing alone.
//   * Fail-open: any ambiguity (no runs, an unknown account, a non-auth latest
//     failure, or a stale failure past the re-probe window) yields "not gated".
//     The gate can only ever *suppress*, never manufacture a new outage — it
//     must not become a fleet-wide single point of failure.

// The deterministic credential-failure codes emitted by the local adapters.
// These are the codes that will not clear by retrying on the same account.
// `claude_auth_required` is produced by the claude-local adapter and classified
// onto OAuth-expiry failures by VANA-3914 (downstream of which this gate sits);
// `acpx_auth_required` and `gemini_auth_required` are emitted today.
export const AUTH_REQUIRED_ERROR_CODES = new Set<string>([
  "claude_auth_required",
  "acpx_auth_required",
  "gemini_auth_required",
]);

// Absent an explicit credential dir, all agents on an adapter share that
// adapter's default account (e.g. the default `~/.claude`), so grouping the
// absent case under one per-adapter sentinel is the correct account identity,
// not a loss of precision.
const DEFAULT_ACCOUNT_SENTINEL = "__default__";

// Env var that carries the credential/account scope for each adapter family.
// Matched by adapter-type prefix so revisioned adapter types (e.g.
// `claude-local`, `claude_local`) all resolve. Only families that emit an
// `*_auth_required` code need an entry; anything else yields no gate.
const CREDENTIAL_DIR_ENV_BY_ADAPTER_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["claude", "CLAUDE_CONFIG_DIR"],
  ["gemini", "GEMINI_CONFIG_DIR"],
  ["acpx", "ACPX_CONFIG_DIR"],
];

const DEFAULT_MAX_FAILURE_AGE_MS = 6 * 60 * 60 * 1000;

function normalizeAdapterType(adapterType: string | null | undefined): string | null {
  const trimmed = typeof adapterType === "string" ? adapterType.trim().toLowerCase() : "";
  return trimmed.length > 0 ? trimmed : null;
}

function readEnvString(env: unknown, key: string): string | null {
  if (!env || typeof env !== "object") return null;
  const value = (env as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

// Stable key identifying the credential scope an agent runs under. Agents that
// share the returned key share an account and gate together. Returns null when
// the adapter family is not credential-gated (→ no gate, fail-open).
export function deriveAccountKey(
  adapterType: string | null | undefined,
  env: unknown,
): string | null {
  const normalized = normalizeAdapterType(adapterType);
  if (!normalized) return null;
  const match = CREDENTIAL_DIR_ENV_BY_ADAPTER_PREFIX.find(([prefix]) =>
    normalized.startsWith(prefix)
  );
  if (!match) return null;
  const [prefix, envKey] = match;
  const configDir = readEnvString(env, envKey) ?? DEFAULT_ACCOUNT_SENTINEL;
  return `${prefix}:${configDir}`;
}

export type AccountRunOutcome = {
  runId: string;
  status: string;
  errorCode: string | null;
  finishedAt: Date | null;
};

export type AccountFailureGate = {
  accountKey: string;
  errorCode: string;
  sinceRunId: string;
  sinceFinishedAt: Date | null;
};

// Decide whether an account is currently auth-gated from its recent terminal
// runs (any order; only runs with a finishedAt are considered). The account's
// most-recent terminal outcome governs:
//   * succeeded, or any non-auth failure → not gated (recovery observed).
//   * an `*_auth_required` failure within the re-probe window → gated.
//   * an `*_auth_required` failure older than the window → not gated, so a
//     probe run is allowed through to re-test (time never *confirms* recovery,
//     it only lets a probe through; a real success still does the releasing).
export function classifyAccountFailureGate(
  accountKey: string,
  recentTerminalRuns: readonly AccountRunOutcome[],
  opts: { now?: Date; maxFailureAgeMs?: number } = {},
): AccountFailureGate | null {
  const now = opts.now ?? new Date();
  const maxFailureAgeMs = opts.maxFailureAgeMs ?? DEFAULT_MAX_FAILURE_AGE_MS;

  const terminal = recentTerminalRuns
    .filter((run): run is AccountRunOutcome & { finishedAt: Date } =>
      run.finishedAt instanceof Date && !Number.isNaN(run.finishedAt.getTime())
    )
    .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());

  const latest = terminal[0];
  if (!latest) return null;
  if (latest.status === "succeeded") return null;

  const errorCode = typeof latest.errorCode === "string" ? latest.errorCode.trim() : "";
  if (!AUTH_REQUIRED_ERROR_CODES.has(errorCode)) return null;

  const ageMs = now.getTime() - latest.finishedAt.getTime();
  if (maxFailureAgeMs > 0 && ageMs > maxFailureAgeMs) return null;

  return {
    accountKey,
    errorCode,
    sinceRunId: latest.runId,
    sinceFinishedAt: latest.finishedAt,
  };
}

export const ACCOUNT_FAILURE_GATE_DEFAULT_MAX_FAILURE_AGE_MS = DEFAULT_MAX_FAILURE_AGE_MS;
