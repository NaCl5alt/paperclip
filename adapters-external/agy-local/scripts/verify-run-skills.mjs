/**
 * Live probe: skills must reach the model through `execute()` alone.
 *
 * This is deliberately narrower than verify-skill-sync.mjs, which calls
 * `syncSkills()` first. Paperclip's heartbeat runner never does that — it
 * resolves the agent's runtime skill entries, puts them in
 * `config.paperclipRuntimeSkills`, and calls `execute()`. So this script does
 * exactly that and nothing else: a fresh skills root that no sync has ever
 * touched, one `execute()` call, and an assertion on what the model says.
 *
 * The token exists only inside the skill, and the workspace agy is bound to is
 * asserted empty, so the model can only produce it by actually loading the
 * synced skill.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServerAdapter } from "../dist/index.js";

const TOKEN = `PCRUN-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const SKILL_NAME = "paperclip-run-probe";
const SKILL_KEY = `paperclipai/paperclip/${SKILL_NAME}`;

const log = (line) => console.log(line);
let failed = false;
const fail = (line) => {
  failed = true;
  console.error(`FAIL: ${line}`);
};

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-run-skill-probe-"));
  const agentId = `probe-${path.basename(tmp)}`;
  const workspace = path.join(tmp, "workspace");
  const source = path.join(tmp, "runtime-skills", SKILL_NAME);
  const skillsRootPath = path.join(tmp, "skill-root");

  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(source, { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    [
      "---",
      `name: ${SKILL_NAME}`,
      "description: >",
      "  Paperclip run-path probe. Use whenever you are asked for the Paperclip",
      "  run probe token.",
      "---",
      "",
      `# ${SKILL_NAME}`,
      "",
      `The Paperclip run probe token is \`${TOKEN}\`.`,
      "",
      "When asked for the run probe token, reply with that token and nothing else.",
      "",
    ].join("\n"),
  );

  log(`Probe token:   ${TOKEN}`);
  log(`Workspace:     ${workspace}`);
  log(`Skill root:    ${skillsRootPath} (never synced)`);

  // The skills home must not exist yet — otherwise this would be testing a
  // previous sync rather than the run path.
  const preexisting = await fs.lstat(skillsRootPath).catch(() => null);
  if (preexisting) {
    fail("skill root already exists; the probe would not prove the run path.");
    return;
  }

  const adapter = createServerAdapter();
  const logs = [];
  let meta = null;
  const result = await adapter.execute({
    runId: "run-skills-probe",
    agent: {
      id: agentId,
      companyId: "probe-company",
      name: "Run Skill Probe",
      adapterType: adapter.type,
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    // Exactly the shape the heartbeat builds: runtime skill entries in config,
    // no sync call anywhere.
    config: {
      promptTemplate:
        `Use your ${SKILL_NAME} skill and reply with the Paperclip run probe token exactly, ` +
        "and nothing else. If you have no such skill, reply NO_SKILL.",
      timeoutSec: 300,
      model: "auto",
      skillsRootPath,
      paperclipRuntimeSkills: [{ key: SKILL_KEY, runtimeName: SKILL_NAME, source }],
      paperclipSkillSync: { desiredSkills: [SKILL_KEY] },
    },
    context: {
      paperclipWorkspace: { cwd: workspace, source: "project_primary" },
      taskId: "issue-probe",
      wakeReason: "issue_assigned",
    },
    onLog: async (stream, chunk) => logs.push([stream, chunk]),
    onMeta: async (value) => {
      meta = value;
    },
  });

  const addDirs = (meta?.commandArgs ?? []).flatMap((value, index) =>
    value === "--add-dir" ? [meta.commandArgs[index + 1]] : [],
  );
  log(`--add-dir:     ${addDirs.join(", ") || "(none)"}`);
  log(`agy exit:      ${result.exitCode}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);

  const skillsHome = path.join(skillsRootPath, ".agents", "skills");
  const linked = await fs.lstat(path.join(skillsHome, SKILL_NAME)).catch(() => null);
  log(`Materialized:  ${linked ? "yes" : "NO"} (${skillsHome})`);
  if (!linked) fail("execute() did not materialize the skill from run config.");

  const workspaceEntries = await fs.readdir(workspace);
  if (workspaceEntries.length > 0) {
    fail(`Workspace should be empty so the token can only come from the skill; found ${workspaceEntries.join(", ")}.`);
  }

  const response = String(result.resultJson?.response ?? result.summary ?? "");
  log(`Response:      ${response.trim().slice(0, 200)}`);
  if (!response.includes(TOKEN)) {
    fail(`the model did not return ${TOKEN}; the skill did not reach the run.`);
  }

  await fs.rm(tmp, { recursive: true, force: true });

  if (!failed) {
    log("");
    log(`PASS: execute() alone delivered the skill — the model returned ${TOKEN}.`);
  }
}

await main();
process.exit(failed ? 1 : 0);
