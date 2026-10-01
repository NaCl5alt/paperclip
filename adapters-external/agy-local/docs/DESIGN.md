# Design

## Why this exists

Gemini CLI is deprecated for personal use, so Paperclip's built-in `gemini_local`
adapter has no viable lane for personal accounts. `agy` (Antigravity CLI) is the
replacement CLI. This package adds an `agy_local` adapter through Paperclip's
external-adapter extension point, so nothing in Paperclip needs to be forked.

## Where this plugs into Paperclip

Paperclip loads external adapters through
`@paperclipai/server/dist/adapters/plugin-loader.js`:

1. `POST /api/adapters/install` (instance-admin only) resolves the package, either
   `npm install`ing it into `~/.paperclip/adapter-plugins/` or resolving a local path.
2. `resolvePackageEntryPoint()` reads `exports["."].import` (falling back to `main`).
3. `validateAdapterModule()` imports that entry and requires a **`createServerAdapter()`**
   export returning a `ServerAdapterModule` with a non-empty `type`. It then runs
   `validateAdapterLoginCapability()`, which fails closed on a malformed capability.
4. If `exports["./ui-parser"]` exists, its **source** is read and cached, gated on
   `package.json` → `paperclip.adapterUiParser` having major version `1`.
5. The registration is persisted to `~/.paperclip/adapter-plugins.json` and reloaded on
   startup by `buildExternalAdapters()`.

`BUILTIN_ADAPTER_TYPES` in the server states that external plugins must not *replace*
built-in types but may add new ones. `agy_local` is a new type, so it does not collide.

`scripts/verify-loader.mjs` reimplements steps 2–4 exactly, so a contract break is
caught locally rather than at install time.

## agy stream-json protocol

Captured from `agy --output-format stream-json` on agy 1.1.28. One JSON object per
line, discriminated by a top-level `event`.

### `init`

```json
{"event":"init","conversation_id":"1d40…","init":{"cwd":"…","tools":["view_file",…],"permission_mode":"always-proceed"}}
```

`conversation_id` is the resume handle. Note `init.cwd` reports the *process* cwd,
which is not necessarily where agy will write — see "Workspace binding" below.

### `step_update`

```json
{"event":"step_update","step_update":{
  "conversation_id":"1d40…","step_index":1,
  "state":"ACTIVE"|"DONE",
  "step_type":"user_input"|"agent_response"|"tool",
  "text_delta":"…","tool_name":"write_to_file",
  "tool_info":{"name":"…","parameters":{…},"output":"…"},
  "duration_seconds":2.15,
  "usage":{"input_tokens":5286,"output_tokens":90,"thinking_tokens":86,"cache_read_tokens":8128,"total_tokens":5376}}}
```

- `text_delta` is a **true incremental chunk**. Concatenating deltas in order
  reconstructs the message, so the UI parser marks assistant entries `delta: true`.
- A tool step appears **twice**, ACTIVE then DONE, sharing one `step_index`. Both
  parsers key on `step_index` so the pair collapses into one invocation rather than
  rendering twice.
- `step_index` is not dense — observed runs skip indices.

### `result`

```json
{"event":"result","result":{"conversation_id":"1d40…","status":"SUCCESS","response":"…","duration_seconds":7.6,"num_turns":1,"usage":{…}}}
```

`result.usage` is the **sum over the whole invocation**, not the last step. In a
two-tool probe the final step reported 6,613 input tokens while the result event
reported 18,259. Hence `usageBasis: "per_run"`; reporting `session_cumulative` would
make Paperclip delta against the previous run and undercount.

Only `SUCCESS` has been observed. Non-success handling is written defensively: the
parser reads several plausible error field names and, failing that, synthesizes
`agy finished with status <STATUS>`.

## Workspace binding — the critical behaviour

**agy does not use its process cwd as the workspace.** A probe run with cwd set to a
temp project directory wrote to `~/.gemini/antigravity-cli/scratch/probe.txt` instead.
Passing `--add-dir <cwd>` corrected it; the same prompt then wrote to the intended
directory.

This is the highest-severity failure mode for this adapter, because it is silent:
the run succeeds, the model reports success, and the workspace diff is empty. Agent
work would disappear with nothing to review.

Mitigations:

- `buildAgyArgs()` passes `--add-dir` unconditionally, not behind a config flag.
- A unit test asserts `--add-dir` is present and carries the resolved cwd.
- `scripts/verify-e2e.mjs` asserts a real file lands in a real workspace.
- The behaviour is documented in the README and `agentConfigurationDoc`.

## Skill delivery

agy has a first-class skill loader, so Paperclip skills are delivered as skills rather
than injected into the prompt. Paperclip's own skills already ship as `SKILL.md` with
`name`/`description` frontmatter, which is exactly agy's format — the sync is a link,
not a translation.

### Which roots agy scans

Determined empirically against agy 1.1.28 by planting uniquely-tokened skills and asking
the model to enumerate and use them (no assumption of Claude Code parity):

| Root | Scanned | Evidence |
|---|---|---|
| `~/.gemini/config/skills/<name>/` | yes | listed as `probe-cfgroot` |
| `<workspace>/.agents/skills/<name>/` | yes | listed as `probe-wsagents` |
| `<secondary --add-dir>/.agents/skills/<name>/` | yes | listed as `probe-adddir2` |
| symlinked skill dir in a scanned root | yes | returned `TOKEN-SYMLINK-7788` through the link |
| `~/.gemini/skills/<name>/` | no | absent from enumeration |
| `<workspace>/.gemini/skills/`, `<workspace>/.claude/skills/` | no | absent from enumeration |

The third row is the design unlock. Because *every* `--add-dir` root contributes its own
`.agents/skills` tree, and the adapter already passes `--add-dir <cwd>` to bind the
workspace, a second `--add-dir` can carry a Paperclip-owned skill root — no writes into
the user's repository, no host-wide shared state, and no conflict with the HEA-33
workspace binding.

The fifth row is the reason this feature was filed. `~/.gemini/skills` is where the
deprecated `gemini_local` lane linked Paperclip's skills, and it still contains a
`paperclip` symlink on hosts that ran it. agy never reads that directory, so those skills
were silently absent. `resolveAgySkillRoot()` can never produce that path and a unit test
asserts it.

### Scopes

| `skillsScope` | Skills home | `--add-dir` | Isolation |
|---|---|---|---|
| `agent` (default) | `~/.agy-paperclip/agents/<agentId>/.agents/skills` | extra root appended after the workspace | per agent |
| `global` | `~/.gemini/config/skills` | none needed | shared by every agy agent on the host |

`resolveAgySkillRoot()` is a pure function of `(config, agentId, homeDir)`. That is what
lets `execute()` derive the same `--add-dir` that `syncSkills()` wrote to without any
shared state between the two call paths — they are separate Paperclip API entry points
and never see each other's results.

Ordering matters: the workspace `--add-dir` is emitted first, because agy treats the
first added directory as the primary workspace. A skill root promoted to that position
would relocate the run.

### Sync semantics

`syncSkills()` symlinks each desired skill into the skills home and reports through
`buildPersistentSkillSnapshot()` (`mode: "persistent"`). Symlinks rather than copies mean
the agent always reads the live skill version, and drift is detectable by comparing link
targets.

Three cases are handled conservatively, because the skills home may contain skills the
operator installed by hand — especially under `global` scope:

- **Unmanaged directory occupying a desired name** — left alone, reported `external`,
  and a warning is emitted. Paperclip never overwrites it.
- **Skill whose source never materialized** (`sourceStatus: "missing"`) — skipped rather
  than linked. A dangling link reads to agy as a *broken* skill, which is worse than an
  absent one.
- **Un-desiring a skill** — only symlinks whose target is a known Paperclip skill source
  are removed. A real directory, or a symlink pointing somewhere else, is left in place.

`requiresMaterializedRuntimeSkills` is `true`: agy scans a directory, so Paperclip must
write the skill trees to disk before `syncSkills()` can link them.

### Two entry points, and why `execute()` syncs too

Paperclip reaches skills through two independent paths, and an adapter that implements
only the first delivers nothing during real runs:

1. **`POST /agents/:id/skills/sync`** — the skills UI. Calls `syncSkills()` directly.
2. **The heartbeat runner** — never calls `syncSkills()`. It resolves the agent's runtime
   skill entries, puts them in `config.paperclipRuntimeSkills`, and calls `execute()`,
   which is expected to materialize them for the run.

So `execute()` calls `syncSkillsForRun()` before deciding on the extra `--add-dir`. Two
things depend on it: an agent whose skills were configured but never explicitly synced
(most of them), and *run-scoped* skills — the ones the runner adds because a skill was
mentioned in the issue thread, which by construction can never have been pre-synced.
Without it agy runs simply had no skills, which is the same silent omission as the
`~/.gemini/skills` trap above, one layer up. `scripts/verify-run-skills.mjs` asserts on
this path specifically: against the pre-fix build the model answers `NO_SKILL`.

That script authors its own skill fixture, which leaves the source layout unverified —
it proves the adapter handles a hand-written skill directory, not the one the Paperclip
server writes for a company skill. `scripts/verify-company-skill.mjs` takes the real
directory instead. Confirmed against `hea38-agy-skill-probe`, created through
`POST /api/companies/{id}/skills`: the server materializes a company skill as a plain
`SKILL.md` with `name`/`description` frontmatter, which is byte-for-byte what agy's
loader expects, so no transform is needed on the way in.

Only `agent` scope reconciles per run. The `global` root is shared by every agy agent on
the host, so pruning it on each run would let one agent delete another's skills
mid-flight; it stays under explicit `syncSkills()` control. A sync failure is logged and
the run continues — a missing skill is worth reporting, not worth killing the run over.

### Observability: why the run log carries a sync receipt

Skill delivery is the one thing this adapter has failed at twice, both times by silent
omission. The obvious place to check it — `usedByAgents[].actualState` on
`GET /api/companies/{c}/skills/{id}` — cannot report it. That field is hardcoded:

```js
// @paperclipai/server, services/company-skills.js — usage()
desired: true,
// Runtime adapter state is intentionally omitted from this bounded metadata read.
actualState: null,
```

That literal is the *only* occurrence of `actualState` in the server. No column stores
it, and `ServerAdapterModule` has no write-back hook — `listSkills()` and `syncSkills()`
return a snapshot to whoever called the HTTP route and it is discarded after the
response. The adapter's own snapshot is correct (`state: "installed"` with the right
`versionId`); it simply has nowhere to put it. `GET /agents/:id/skills` invokes the
adapter live and does show it, but the company-skills detail view never asks.

So `actualState` reads identically whether sync worked or never ran, which makes it
useless for catching exactly the failure it looks like it would catch — HEA-49 had to be
verified by grepping a run transcript for the agent's own `view_file` call.

Until that changes upstream (filed as [paperclipai/paperclip#13129](https://github.com/paperclipai/paperclip/issues/13129)), the run log is the only
channel available, so `describeRunSkillSync()` emits a receipt on **every** run, not just
on warnings. Previously a successful sync logged nothing at all — byte-identical to a
sync that never happened. Every branch now says something: what landed, its truncated
version id, the root it landed in, anything desired but not installed (named by key when
Paperclip supplied no runtime entry for it), and explicit lines for "nothing assigned"
and "skipped, global scope". All lines share the `[paperclip] skill sync:` prefix, so one
grep over a run log answers whether delivery happened:

```
[paperclip] skill sync: 1/1 desired skill(s) installed. Root: /Users/…/.agy-paperclip/agents/71b37185-…/.agents/skills
[paperclip] skill sync:   installed hea38-agy-skill-probe--5dc20b6f68 version=b9e4beac key=company/9a98323b-…/hea38-agy-skill-probe
```

### Remote targets

The skill root is a path on the Paperclip host and does not exist inside an SSH or
sandbox target. `execute()` detects this, skips the extra `--add-dir`, and logs a note
pointing the operator at `skillsScope: "global"` with a provisioned
`~/.gemini/config/skills` in the target. Pointing agy at a nonexistent directory would
just fail the run.

## Session model

`sessionParams` is `{ conversationId, cwd, workspaceId?, repoUrl?, repoRef? }`.

`cwd` is part of session identity on purpose. An agy conversation is bound to the
directory it was created in; resuming it elsewhere hands the model a transcript
describing files that are not present. `execute()` therefore resumes only when the
stored cwd resolves equal to the current execution cwd, and logs a `[paperclip]` line
explaining the refusal otherwise.

`sessionCodec.deserialize()` also accepts a bare string and a `{sessionId}` object, so
rows written by Paperclip's legacy single-session view still decode.

`sessionManagement` declares `nativeContextManagement: "unknown"`, matching what
`gemini_local` declares. agy resumes conversations but documents no automatic
compaction, so Paperclip keeps its threshold-based session rotation active
(200 runs / 2M raw input tokens / 72 hours).

### Recovery

A resume that fails with a "conversation not found"-shaped error triggers exactly one
retry with a fresh conversation. On that retry the adapter does **not** fall back to
the stored conversation id, since it is known-stale. If no conversation id can be
resolved on a failed run, `clearSession: true` tells Paperclip to drop the dead handle
so the next heartbeat starts clean.

## Timeout interaction

Two timers exist: Paperclip's `timeoutSec`, which kills the process, and agy's own
`--print-timeout`. If Paperclip's fired first, agy would die mid-stream before emitting
a result event, losing the conversation id and orphaning the session.

`resolveAgyPrintTimeoutSec()` sets agy's timeout to `timeoutSec` minus a 5% margin
(minimum 10s, floor 30s), so agy always exits first and reports its own state.

## Failure classification

`execute()` maps failures to distinct error codes so Paperclip can act on them:

| Condition | `errorCode` | `errorFamily` |
|---|---|---|
| Not signed in / 401 | `agy_auth_required` | — |
| Quota / rate limit / 429 | `agy_quota_exhausted` | `provider_quota` |
| Connection reset, 5xx, DNS | `agy_network_unavailable` | `transient_upstream` |
| Transport-level failure | forwarded from `proc.errorCode` | — |

`errorFamily` is what drives Paperclip's retry and escalation behaviour, so quota and
transient-network failures are tagged rather than surfacing as opaque crashes.

A run is treated as failed when **any** of: non-zero exit, a parsed non-`SUCCESS`
status, or **no result event at all**. That last case matters — a truncated stream with
a zero exit code would otherwise read as success.

## Security boundaries

- `applyConfiguredEnv()` refuses `PAPERCLIP_API_KEY` from adapter config
  (`isForbiddenConfigEnvKey`) and refuses to shadow any `PAPERCLIP_*` key the runtime
  already assigned. The harness-minted run token stays the only source of Paperclip API
  identity, so operator config cannot hijack the control plane.
- The prompt is always the final CLI argument, so `onMeta` can replace exactly that one
  element with `<prompt N chars>` and keep prompt bodies out of duplicated log fields.
- Env is logged through `buildInvocationEnvForLogs()`, which applies Paperclip's
  redaction.
- `ui-parser.cjs` runs in the host's locked-down worker (no network, no storage, no
  module loader). It is plain self-contained CJS with no `require`; a test asserts both
  properties and evaluates it in a bare `vm` context to prove it.

## Deliberate scope limits

- **Local execution focus.** `execute()` routes through
  `runAdapterExecutionTargetProcess`, so SSH and sandbox targets are structurally
  supported and session identity is recorded per target. But only the local target has
  been verified, and `testEnvironment()` reports an explicit warning rather than a
  false pass when a remote target is configured.
- **No ACP lane.** agy exposes no ACP server, so unlike `claude_local` and
  `gemini_local` there is no `acp` descriptor.
- **Skills are local-target only.** `listSkills`/`syncSkills` are implemented against
  agy's real skill loader (see *Skill delivery*), but only for local execution. A remote
  target needs its skills provisioned in the target's own
  `~/.gemini/config/skills`.
- **No login capability.** agy's login is an interactive browser flow with no
  scriptable `setup-token`-style equivalent, so no `loginCapability` is declared.
  Authentication is a one-time manual `agy` run, which `testEnvironment()` verifies by
  listing models.

## Verification performed

Against agy 1.1.28 and Paperclip 2026.831.1, macOS arm64:

| Check | Result |
|---|---|
| `validateAdapterModule()` replay | pass — `type = agy_local` |
| ui-parser contract extraction | pass — 6,096 bytes, contract 1.0.0 |
| Live model discovery | pass — 15 models |
| `testEnvironment()` | pass — agy found, authenticated |
| Workspace binding (real file write) | pass — file landed in workspace |
| Session resume (real recall) | pass — same id, model recalled prior turn |
| Stale-session rejection | pass — refused resume, warned, new id |
| Skill root discovery (6 candidate roots) | pass — 3 scanned, 3 not; symlinks resolve |
| `listSkills`/`syncSkills` via loader replay | pass — `mode = persistent` |
| Skill sync reaches the model | pass — model returned the synced skill's random token from an empty workspace |
| Skills reach the model via `execute()` alone (heartbeat path) | pass — token returned with no prior `syncSkills()` call; the same probe answers `NO_SKILL` against the pre-fix build |
| Unit tests | 49/49 pass |

Not yet done: registration in a running Paperclip instance (needs instance-admin), and
any Linux or Windows testing.
