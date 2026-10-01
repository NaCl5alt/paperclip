# agy-paperclip-adapter

[![CI](https://github.com/evgemar/agy-paperclip-adapter/actions/workflows/ci.yml/badge.svg)](https://github.com/evgemar/agy-paperclip-adapter/actions/workflows/ci.yml)

A [Paperclip](https://github.com/paperclipai/paperclip) adapter for **agy**, the Antigravity CLI.

Gemini CLI is deprecated for personal use, which leaves the built-in `gemini_local`
adapter without a viable lane. This package registers a new `agy_local` adapter that
drives `agy` instead, keeping the same Paperclip behaviours: heartbeat prompts,
conversation resume across wakes, live tool-call rendering, token accounting, and
"Test Connection".

It installs as an **external adapter plugin** — no Paperclip fork or patch required.

## Requirements

- Paperclip with external adapter support (`@paperclipai/adapter-utils` >= 2026.8.0)
- Node.js >= 24.11.0
- `agy` on `PATH`, already signed in to Antigravity

Verify agy independently first:

```bash
agy --version
agy models      # must print a model table; empty output means you are not signed in
```

## Install

### From a local checkout

```bash
git clone https://github.com/<owner>/agy-paperclip-adapter.git
cd agy-paperclip-adapter
npm install
npm run build          # dist/ is not committed, so this step is required
```

Then register it in Paperclip: **Settings → Adapters → Install adapter**, choose
"local path", and point it at the checkout directory.

Registration is an instance-admin action, so it must be done from a board session.
Agent API tokens get `403 Board access required` on `POST /api/adapters/install`.

### From npm

Once published, install by package name from the same screen, or:

```bash
curl -X POST "$PAPERCLIP_API_URL/api/adapters/install" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"agy-paperclip-adapter"}'
```

After installing, create or edit an agent and set its adapter to
**Antigravity CLI (agy)**, then use **Test Connection** to confirm agy is installed
and authenticated.

## Configuration

| Field | Default | Notes |
|---|---|---|
| `command` | `agy` | Executable name or absolute path |
| `model` | `auto` | `auto` lets agy choose; otherwise any id from `agy models` |
| `effort` | *(unset)* | `low` \| `medium` \| `high` → `agy --effort`. Dropped automatically when `model` already encodes an effort tier (e.g. `gemini-3.8-flash-high`) — agy rejects `--model` + `--effort` together. Only `auto`, `claude-sonnet-4-6` and `claude-opus-4-6-thinking` take an explicit value today |
| `agyAgent` | *(unset)* | Named agy agent → `agy --agent` |
| `cwd` | *(unset)* | Fallback working directory when no workspace is attached |
| `instructionsFilePath` | *(unset)* | Markdown instructions prepended to every prompt |
| `promptTemplate` | Paperclip default | Overrides the heartbeat prompt |
| `bootstrapPromptTemplate` | *(unset)* | Injected only on the first run of a conversation |
| `skillsScope` | `agent` | `agent` = per-agent skill root delivered with an extra `--add-dir`; `global` = agy's shared `~/.gemini/config/skills` |
| `skillsRootPath` | *(unset)* | Overrides the per-agent skill root; agy reads skills from `<root>/.agents/skills`. Ignored when `skillsScope` is `global` |
| `sandbox` | `false` | `agy --sandbox`; off because Paperclip owns the boundary |
| `disableSlashCommands` | `false` | `agy --disable-slash-commands` |
| `extraArgs` | `[]` | Extra agy arguments |
| `env` | *(unset)* | `KEY=VALUE` per line, passed to the child process |
| `timeoutSec` | `3600` | Paperclip run timeout |
| `graceSec` | `15` | SIGTERM grace period |

Models available through Antigravity at the time of writing include Gemini 3.1 Pro,
Gemini 3.6–3.8 Flash, Claude Sonnet 4.6, Claude Opus 4.6 and GPT-OSS 120B. The
adapter discovers the live list from `agy models` rather than hardcoding it, so new
models appear without an adapter release.

## The one thing worth knowing

**agy does not treat its process working directory as the workspace.** Launched with
cwd set to a project directory, it still wrote its output to
`~/.gemini/antigravity-cli/scratch/`. Passing `--add-dir <cwd>` fixes it.

This adapter therefore *always* passes `--add-dir`. Without it, agent edits land
outside the Paperclip workspace and silently vanish — no error, no diff, nothing to
review. `test/parse.test.js` asserts the flag is present so it cannot regress.

## Skills

Paperclip skills are delivered to agy as real skills, not as prompt text. agy has its
own skill loader that reads `<name>/SKILL.md` with `name`/`description` frontmatter —
the same shape Paperclip already ships — so sync is a symlink, not a transform.

Which directories agy actually scans was established by probing agy 1.1.28 with
uniquely-tokened skills and asking the model to enumerate and use them:

| Root | Scanned |
|---|---|
| `~/.gemini/config/skills/<name>/SKILL.md` | yes |
| `<any --add-dir root>/.agents/skills/<name>/SKILL.md` | yes |
| symlinked skill directory inside a scanned root | yes |
| `~/.gemini/skills/<name>/SKILL.md` | **no** |
| `<workspace>/.claude/skills`, `<workspace>/.gemini/skills` | **no** |

That every `--add-dir` root contributes its own `.agents/skills` tree is what makes the
default `skillsScope: "agent"` possible: each agent gets a private skill root under
`~/.agy-paperclip/agents/<agentId>/`, passed as a second `--add-dir` after the workspace
one. Nothing is written into your repository, and two agy agents on the same host do not
share a skill set.

Set `skillsScope: "global"` to use agy's shared `~/.gemini/config/skills` instead. It
needs no extra flag, but every agy agent on the host then sees the same skills, and
`listSkills` returns a warning saying so.

> **`~/.gemini/skills` is a trap.** The deprecated `gemini_local` lane linked Paperclip
> skills there and agy does not read it. Skills placed in that directory are silently
> invisible — no error, no warning, just a model that has never heard of them. This
> adapter never targets it, and a unit test asserts no configuration can resolve to it.

Remote execution targets are not covered: the skill root is a path on the Paperclip
host, so `execute()` logs a note and skips the extra `--add-dir` rather than pointing agy
at a directory that does not exist in the target.

## Behaviour notes

- **Non-interactive:** runs use `--print` with `--output-format stream-json`, plus
  `--dangerously-skip-permissions` because an unattended heartbeat cannot answer a
  permission prompt.
- **Timeouts:** `agy --print-timeout` is set just *below* Paperclip's `timeoutSec`, so
  agy exits on its own and still emits a result event carrying the conversation id,
  rather than being killed mid-stream with the session handle lost.
- **Session resume:** the agy `conversation_id` is stored as `sessionParams` and replayed
  via `--conversation`. A conversation is only resumed when its recorded `cwd` matches
  the current one, because an agy conversation is bound to the directory it was created
  in. A conversation that no longer exists triggers exactly one retry from scratch.
- **Usage:** agy's result event totals the whole invocation, so the adapter reports
  `usageBasis: "per_run"`. Reporting it as cumulative would double-count.
- **Billing:** reported as a Google subscription. `provider` reflects the *upstream*
  model vendor, since Antigravity also fronts Anthropic and OpenAI models.
- **Failure classification:** auth, quota and transient-network failures get distinct
  error codes (`agy_auth_required`, `agy_quota_exhausted`, `agy_network_unavailable`) so
  Paperclip can retry or escalate appropriately instead of treating every failure alike.
- **Truncated streams:** a run that never emits a result event is reported as failed,
  not as a silent success, and still bills the tokens the last step reported.

## Development

```bash
npm install
npm run build
npm test                       # 49 unit tests over captured agy fixtures

node scripts/verify-loader.mjs "$PWD"   # replays Paperclip's plugin-loader, hits live agy
node scripts/verify-e2e.mjs             # real agy runs: workspace binding + resume + stale session
node scripts/verify-skill-sync.mjs      # real agy run: proves a synced skill reaches the model
node scripts/verify-run-skills.mjs      # real agy run: proves execute() alone delivers skills
node scripts/verify-company-skill.mjs <skill-dir> <token>   # real agy run against a real Paperclip company skill
```

`scripts/verify-e2e.mjs` makes real model calls and consumes quota. It asserts the
three things unit tests cannot: that files land in the workspace, that a resumed
conversation remembers the previous turn, and that a stale conversation id is refused.

`scripts/verify-skill-sync.mjs` is the same idea for skills, and it deliberately does
*not* assert on file presence. It syncs a skill containing a random token, runs agy
against an empty workspace, and asserts the model returns that token — the only way it
can, since the token exists nowhere else. A skill directory agy silently ignores is the
failure mode that matters, and only a behavioural assertion catches it.

`scripts/verify-run-skills.mjs` narrows that further to the path a real heartbeat takes:
no `syncSkills()` call at all, just `execute()` with the skill entries in run config, the
way Paperclip's runner invokes the adapter. Against a build without run-time sync the
model answers `NO_SKILL`.

`scripts/verify-company-skill.mjs` closes the last gap: the three scripts above author
their own skill fixtures, so they prove the adapter handles *a* skill directory, not that
it handles the layout the Paperclip server actually writes. This one takes a real company
skill directory as an argument, refuses to run if the token is not already in its
`SKILL.md`, and asserts the model returns it. Verified against
`hea38-agy-skill-probe`, created through `POST /api/companies/{id}/skills`.

See [docs/DESIGN.md](docs/DESIGN.md) for the adapter contract and the agy stream-json
protocol reference.

## Status

Verified end to end against agy 1.1.28 and Paperclip 2026.831.1 on macOS (arm64):
loader validation, live model discovery, environment probe, workspace binding, session
resume, stale-session rejection, and skill delivery — both through an explicit
`syncSkills()` call and through `execute()` alone, and for a real Paperclip company skill
created through the control-plane API — each proved by the model returning a token that
exists only inside the synced skill — all pass.

CI (GitHub Actions) builds and runs the unit test suite on Node 24 for `ubuntu-latest`
and `macos-latest` on every push and pull request, so the build and unit-test path is
verified on Linux as well as macOS. Windows is untested, and the end-to-end checks above
(which require a real, signed-in `agy` install) have only been run on macOS.

## License

MIT
