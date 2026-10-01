/**
 * Live probe: a REAL Paperclip company skill must reach the model.
 *
 * verify-run-skills.mjs proves the run path using a skill this script authors
 * itself. That leaves one thing unproven: that a skill created through the
 * Paperclip control plane — with whatever layout the server actually writes —
 * survives the trip. So this script takes no shortcuts on the source: it reads
 * the company skill directory the server materialized, and asserts the model
 * returns a token that exists nowhere except inside that directory.
 *
 * Usage:
 *   node scripts/verify-company-skill.mjs <skill-source-dir> <expected-token>
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServerAdapter } from "../dist/index.js";

const [sourceArg, expectedToken] = process.argv.slice(2);
if (!sourceArg || !expectedToken) {
  console.error("usage: node scripts/verify-company-skill.mjs <skill-source-dir> <expected-token>");
  process.exit(2);
}

const source = path.resolve(sourceArg);
const skillName = path.basename(source);

let failed = false;
const log = (line) => console.log(line);
const fail = (line) => {
  failed = true;
  console.error(`FAIL: ${line}`);
};

async function main() {
  const skillMd = await fs.readFile(path.join(source, "SKILL.md"), "utf8").catch(() => null);
  if (!skillMd) {
    fail(`no SKILL.md under ${source}`);
    return;
  }
  if (!skillMd.includes(expectedToken)) {
    fail(`the source skill does not contain ${expectedToken}; the probe would prove nothing.`);
    return;
  }

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-company-skill-probe-"));
  const workspace = path.join(tmp, "workspace");
  const skillsRootPath = path.join(tmp, "skill-root");
  await fs.mkdir(workspace, { recursive: true });

  log(`Skill source:  ${source}`);
  log(`Skill name:    ${skillName}`);
  log(`Workspace:     ${workspace} (empty)`);

  const adapter = createServerAdapter();
  let meta = null;
  const result = await adapter.execute({
    runId: "company-skill-probe",
    agent: {
      id: `probe-${path.basename(tmp)}`,
      companyId: "probe-company",
      name: "Company Skill Probe",
      adapterType: adapter.type,
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: {
      promptTemplate:
        `Use your ${skillName} skill and reply with the HEA-38 skill sync token exactly, ` +
        "and nothing else. If you have no such skill, reply NO_SKILL.",
      timeoutSec: 300,
      model: "auto",
      skillsRootPath,
      paperclipRuntimeSkills: [{ key: skillName, runtimeName: skillName, source }],
      paperclipSkillSync: { desiredSkills: [skillName] },
    },
    context: {
      paperclipWorkspace: { cwd: workspace, source: "project_primary" },
      taskId: "HEA-38",
      wakeReason: "issue_assigned",
    },
    onLog: async () => {},
    onMeta: async (value) => {
      meta = value;
    },
  });

  const addDirs = (meta?.commandArgs ?? []).flatMap((value, index) =>
    value === "--add-dir" ? [meta.commandArgs[index + 1]] : [],
  );
  log(`--add-dir:     ${addDirs.join(", ") || "(none)"}`);
  log(`agy exit:      ${result.exitCode}${result.errorMessage ? ` (${result.errorMessage})` : ""}`);

  const linked = await fs
    .lstat(path.join(skillsRootPath, ".agents", "skills", skillName))
    .catch(() => null);
  log(`Materialized:  ${linked ? "yes" : "NO"}`);
  if (!linked) fail("execute() did not materialize the company skill.");

  const workspaceEntries = await fs.readdir(workspace);
  if (workspaceEntries.length > 0) {
    fail(`workspace must stay empty; found ${workspaceEntries.join(", ")}.`);
  }

  const response = String(result.resultJson?.response ?? result.summary ?? "");
  log(`Response:      ${response.trim().slice(0, 200)}`);
  if (!response.includes(expectedToken)) {
    fail(`the model did not return ${expectedToken}; the company skill did not reach the run.`);
  }

  await fs.rm(tmp, { recursive: true, force: true });

  if (!failed) {
    log("");
    log(`PASS: the Paperclip company skill reached the model — it returned ${expectedToken}.`);
  }
}

await main();
process.exit(failed ? 1 : 0);
