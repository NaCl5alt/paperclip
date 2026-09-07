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
//     outcome that actually says something about the credential, so the next
//     successful run clears it. Release never depends on time elapsing alone,
//     and never on an outcome (a cancellation, a transient upstream error) that
//     carries no evidence the credential works again.
//   * Fail-open: any ambiguity (no runs, an unknown account, a non-auth latest
//     failure, an `*_auth_required` code the run's own error text does not
//     corroborate, or a stale failure past the re-probe window) yields "not
//     gated". The gate can only ever *suppress*, never manufacture a new outage
//     — it must not become a fleet-wide single point of failure. That property
//     is what forces the corroboration step: the code alone is 83.5% false on
//     the live fleet, and suppression that broad *is* a new outage.

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

// Reading an agent env binding. Bindings are stored either as a bare string or
// as the `{ type: "plain", value }` record the rest of the server uses (see
// `assertLowTrustEnvConfigAllowed` in heartbeat.ts); on the live fleet 19 of 44
// claude agents use the record form, so treating only the bare-string form as
// "present" silently collapsed every one of them onto the default-account
// sentinel and merged three distinct credential scopes into one key.
// The three outcomes are deliberately distinct:
//   * `{ kind: "absent" }`   — no binding: the adapter's default account.
//   * `{ kind: "value" }`    — a readable plain binding: that account.
//   * `{ kind: "opaque" }`   — present but not resolvable here (e.g. a secret
//     reference). The account is real but unknown, so the caller must fail open
//     rather than fold it into the default account.
type EnvBindingRead =
  | { kind: "absent" }
  | { kind: "value"; value: string }
  | { kind: "opaque" };

function readEnvBinding(env: unknown, key: string): EnvBindingRead {
  if (!env || typeof env !== "object") return { kind: "absent" };
  if (!(key in (env as Record<string, unknown>))) return { kind: "absent" };
  const value = (env as Record<string, unknown>)[key];
  if (value === null || value === undefined) return { kind: "absent" };
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? { kind: "value", value: trimmed } : { kind: "absent" };
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.type === "plain" && typeof record.value === "string") {
      const trimmed = record.value.trim();
      return trimmed.length > 0 ? { kind: "value", value: trimmed } : { kind: "absent" };
    }
    return { kind: "opaque" };
  }
  return { kind: "opaque" };
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
  const binding = readEnvBinding(env, envKey);
  // An unresolvable binding names a real but unidentifiable account; returning
  // null keeps the gate fail-open instead of merging it into the default one.
  if (binding.kind === "opaque") return null;
  const configDir = binding.kind === "value" ? binding.value : DEFAULT_ACCOUNT_SENTINEL;
  return `${prefix}:${configDir}`;
}

export type AccountRunOutcome = {
  runId: string;
  status: string;
  errorCode: string | null;
  // The run's own terminal error string (`heartbeat_runs.error`). Required, not
  // optional: arming reads it (see `errorTextAssertsCredentialFailure`), and an
  // optional field would let a caller that forgets to select the column silently
  // disable the gate — the exact fail-open-by-omission shape that left this gate
  // dead once already (the un-imported `gte` fixed in 5d725821d).
  errorText: string | null;
  finishedAt: Date | null;
};

export type AccountFailureGate = {
  accountKey: string;
  errorCode: string;
  sinceRunId: string;
  sinceFinishedAt: Date | null;
};

// Arming additionally requires the failing run's *own* terminal error text to
// say that the credential is what broke. The error code alone is not
// trustworthy evidence: `detectClaudeLoginRequired()` matches the legacy
// `CLAUDE_AUTH_REQUIRED_RE` against the adapter's entire stream-json stdout,
// which echoes the prompt (agent instructions, issue body, whole thread) and
// every file the agent read — the same contaminated haystack that made
// `accountQuotaExhausted` 0%-precision in VANA-3255.
//
// Measured on the live fleet over 90 days (VANA-4067 B-II1): of the 79 runs
// stored as `claude_auth_required`, 66 (83.5%) carry no auth wording anywhere
// in their own error — session limits (19), `ENOTFOUND` (5), `Connection closed
// mid-response` (11), spend limits (5), and even ordinary agent completion
// reports. Reading the code alone, each of those arms the gate and silences
// every agent sharing the account for up to the re-probe window; on the default
// account that is 25 agents, 41 times in 90 days. That is the gate manufacturing
// the very outage its docstring promises it can never manufacture.
//
// Re-applying the classifier's own vocabulary to a haystack that cannot be
// contaminated loses no genuine failure. Against the same 90 days it keeps all
// 13 genuine `claude_auth_required` runs, all 96 `gemini_auth_required` runs,
// and all 2,088 runs of the real 2026-09-05 default-account outage (whose error
// is `Failed to authenticate: OAuth session expired and could not be
// refreshed`), while dropping all 66 false positives.
export const ACCOUNT_GATE_CREDENTIAL_ERROR_TEXT_PATTERN_SOURCE =
  "(oauth session expired|not logged in|please log in|please run claude login|login required|requires? login|unauthorized|authentication required|failed to authenticate)";

// The adapter puts the reason at the front of the error string: across the 90-day
// sample the latest genuine match started at offset 37 and the longest genuine
// auth error was 69 characters. An agent narrative that merely *quotes* a login
// prompt carries it deep in the body — the one residual false positive in that
// sample sat at roughly offset 500 of a 1,616-character completion report. So
// bounding the haystack to a prefix drops that last case with ~200 characters of
// margin over every genuine one, and the bound is stable: 120, 160, 200, 300 and
// 500 all yield the identical 108-kept / 69-dropped split.
export const ACCOUNT_GATE_CREDENTIAL_ERROR_TEXT_MAX_CHARS = 240;

// One source of truth for both haystacks. The SQL pre-filter in heartbeat.ts
// compiles the same pattern with `~*` and the same bound with `left()`. The two
// slicings differ in units — Postgres `left()` counts characters, JS `slice()`
// counts UTF-16 code units — so on astral input SQL sees at least as much text
// as this does. The asymmetry only ever runs one way (SQL can keep a row this
// filter then skips, never the reverse), which is the fail-open direction.
const CREDENTIAL_ERROR_TEXT_RE = new RegExp(
  ACCOUNT_GATE_CREDENTIAL_ERROR_TEXT_PATTERN_SOURCE,
  "i",
);

export function errorTextAssertsCredentialFailure(
  errorText: string | null | undefined,
): boolean {
  if (typeof errorText !== "string") return false;
  return CREDENTIAL_ERROR_TEXT_RE.test(
    errorText.slice(0, ACCOUNT_GATE_CREDENTIAL_ERROR_TEXT_MAX_CHARS),
  );
}

// A terminal run only carries information about the account's credential when
// it either *used* the credential successfully or *failed on* it. Every other
// outcome — a `cancelled` run, a transient upstream failure, a lost process —
// says nothing about whether the credential is still expired, so it must not be
// read as evidence of recovery.
//
// This distinction is load-bearing, not hygiene. The earlier rule ("any
// non-auth latest outcome releases the gate") is defeated by the auth handoff
// this gate ships alongside: when VANA-3914 fails an issue over to a fallback
// agent it reassigns the issue, and every queued run on the old assignee is
// cancelled with `issue_assignee_changed`. That cancellation lands *after* the
// auth failure that armed the gate, so the handoff released the gate it had
// just armed. Replayed against the real 2026-09-05 default-account outage, the
// old rule flipped the gate 601 times and left it OFF for 19.6% of the window;
// of its 301 releases, 295 were `issue_assignee_changed` cancellations, 5 were
// unrelated failures, and exactly 1 was a real success.
function isInformativeAboutCredential(run: AccountRunOutcome): boolean {
  if (run.status === "succeeded") return true;
  const errorCode = typeof run.errorCode === "string" ? run.errorCode.trim() : "";
  if (!AUTH_REQUIRED_ERROR_CODES.has(errorCode)) return false;
  // An `*_auth_required` code whose own error text says nothing about the
  // credential is a misclassification, not evidence. It is *skipped*, not read
  // as recovery: a session-limit rejection is no more proof the credential works
  // than proof it is broken.
  return errorTextAssertsCredentialFailure(run.errorText);
}

// The subset of run shapes the gate is willing to read, as a SQL-side predicate
// can express it. Kept next to `isInformativeAboutCredential` so the database
// pre-filter in heartbeat.ts and this in-memory filter stay in step: the caller
// narrows the fetch to these rows *and* to the credential-text predicate above,
// and this module re-applies both rules so a caller that fetches everything
// still behaves identically. The two are not byte-identical — this module trims
// the code and slices by UTF-16 code unit where SQL compares the raw column and
// slices by character — but both deviations only ever make the in-memory filter
// the narrower of the pair, so SQL can never admit a row this module would arm
// on.
export const ACCOUNT_GATE_INFORMATIVE_ERROR_CODES: readonly string[] = [
  ...AUTH_REQUIRED_ERROR_CODES,
];

// Decide whether an account is currently auth-gated from its recent terminal
// runs (any order; only runs with a finishedAt are considered). Runs that say
// nothing about the credential are skipped over entirely, and the most-recent
// *informative* outcome governs:
//   * succeeded → not gated (recovery actually observed).
//   * an `*_auth_required` failure whose own error text names the credential,
//     within the re-probe window → gated.
//   * an `*_auth_required` failure whose error text does not → skipped, exactly
//     like a cancellation: it neither arms nor releases.
//   * a corroborated `*_auth_required` failure older than the window → not gated, so a
//     probe run is allowed through to re-test (time never *confirms* recovery,
//     it only lets a probe through; a real success still does the releasing).
//   * no informative run at all → not gated (fail-open).
//
// Skipping rather than releasing cannot strand the fleet: the re-probe window
// still bounds total suppression at `maxFailureAgeMs` measured from the auth
// failure itself, regardless of how many uninformative runs pile up after it.
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
    .filter(isInformativeAboutCredential)
    .sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime());

  const latest = terminal[0];
  if (!latest) return null;
  if (latest.status === "succeeded") return null;

  const errorCode = typeof latest.errorCode === "string" ? latest.errorCode.trim() : "";
  // Unreachable given the filter above; kept so the gate still fails open if the
  // informative-run predicate is ever widened without revisiting this branch.
  if (!AUTH_REQUIRED_ERROR_CODES.has(errorCode)) return null;
  if (!errorTextAssertsCredentialFailure(latest.errorText)) return null;

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
