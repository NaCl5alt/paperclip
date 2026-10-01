export const agentConfigurationDoc = `# agy_local agent configuration

Adapter: agy_local (external plugin — \`agy-paperclip-adapter\`)

Use when:
- You want Paperclip to drive the Antigravity CLI (\`agy\`) locally on the host machine
- You are migrating off \`gemini_local\`, which is deprecated for personal use
- You want conversations resumed across heartbeats via agy's \`--conversation\`
- You want access to the models Antigravity fronts (Gemini 3.x, Claude Sonnet/Opus 4.6, GPT-OSS)

Don't use when:
- You need webhook-style external invocation (use http or openclaw_gateway)
- You only need a one-shot script with no agent loop (use process)
- \`agy\` is not installed and authenticated on the machine that runs Paperclip

Core fields:
- command (string, optional): defaults to "agy"
- model (string, optional): agy model id. Defaults to "auto", which lets agy choose.
- effort (string, optional): reasoning effort — low, medium, or high. Unset uses the model default.
- agyAgent (string, optional): named agy agent passed as --agent
- cwd (string, optional): fallback absolute working directory when no Paperclip workspace is attached
- instructionsFilePath (string, optional): absolute path to a markdown instructions file prepended to the run prompt
- promptTemplate (string, optional): overrides the default Paperclip heartbeat prompt
- bootstrapPromptTemplate (string, optional): extra prompt text injected only on the first run of a conversation
- sandbox (boolean, optional): pass agy --sandbox (default false — Paperclip owns the execution boundary)
- disableSlashCommands (boolean, optional): pass agy --disable-slash-commands
- extraArgs (string[], optional): additional agy arguments
- env (object, optional): KEY=VALUE environment variables for the agy child process
- skillsScope (string, optional): "agent" (default) keeps this agent's Paperclip skills in its own
  root, delivered with an extra --add-dir. "global" uses agy's shared ~/.gemini/config/skills,
  which every agy agent on the host can see.
- skillsRootPath (string, optional): overrides the per-agent skill root. agy reads skills from
  <root>/.agents/skills. Ignored when skillsScope is "global".

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (default 3600)
- graceSec (number, optional): SIGTERM grace period in seconds (default 15)

Notes:
- **Workspace binding.** agy does not treat its process cwd as the workspace; left alone it
  writes into \`~/.gemini/antigravity-cli/scratch/\`. This adapter always passes
  \`--add-dir <cwd>\` to pin the run to the Paperclip workspace. This is the single most
  important behaviour of the adapter — without it, agent edits land outside the workspace.
- Runs use \`--print\` for non-interactive execution and \`--output-format stream-json\` for
  structured logs, so the Paperclip UI renders tool calls and assistant text live.
- \`--dangerously-skip-permissions\` is always passed; an unattended heartbeat cannot answer a
  permission prompt.
- agy's \`--print-timeout\` is set just below \`timeoutSec\` so agy exits on its own and still
  emits a result event carrying the conversation id, instead of being killed mid-stream.
- Sessions resume with \`--conversation <id>\` only when the stored conversation cwd matches the
  current cwd. A conversation that no longer exists triggers exactly one retry from scratch.
- Token usage comes from agy's result event, which totals the whole invocation, so the adapter
  reports \`usageBasis: "per_run"\`.
- Billing is reported as a Google subscription (\`billingType: "subscription"\`). The \`provider\`
  field reflects the upstream model vendor, since Antigravity also fronts Anthropic and OpenAI
  models.
- Authentication uses the local agy login. Run \`agy\` interactively once and complete the
  Antigravity sign-in; "Test Connection" verifies this by listing models.
- **Skills.** Paperclip skills are synced as real agy skills, not prompt text — agy reads
  \`<name>/SKILL.md\` in the same format Paperclip already ships. By default each agent gets a
  private skill root at \`~/.agy-paperclip/agents/<agentId>/.agents/skills\`, passed to the run as
  a second \`--add-dir\`; nothing is written into your repository.
- Do not place skills in \`~/.gemini/skills\`. The deprecated \`gemini_local\` lane used that path
  and agy does not read it, so skills there are silently invisible to the model.
- Skill sync covers local execution only. On an SSH or sandbox target the skill root does not
  exist, so set skillsScope to "global" and provision \`~/.gemini/config/skills\` inside the target.
- \`instructionsFilePath\` remains the way to supply always-on agent instructions; skills are
  loaded on demand by the model.
`;
