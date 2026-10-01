#!/usr/bin/env node
/**
 * Live proof that a Paperclip-synced skill reaches the model.
 *
 * File presence is not the assertion that matters here. agy silently ignores
 * skill directories in roots it does not scan (`~/.gemini/skills` is one, and it
 * is where the deprecated gemini_local lane put them), so a sync can look
 * perfect on disk and deliver nothing. This script therefore drives a real
 * `agy --print` run through the adapter's own `syncSkills` + `buildAgyArgs` and
 * asserts on the model's *answer*: a token that exists nowhere except inside the
 * synced SKILL.md.
 *
 * Requires a working, authenticated `agy` on PATH.
 *
 *   node scripts/verify-skill-sync.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { buildAgyArgs } from "../dist/args.js";
import { resolveAgySkillRoot, syncSkills } from "../dist/skills.js";
import { parseAgyJsonl } from "../dist/parse.js";

const COMMAND = process.env.AGY_COMMAND ?? "agy";
const TIMEOUT_SEC = Number(process.env.AGY_PROBE_TIMEOUT_SEC ?? 240);

// Distinctive enough that it cannot come from the model's own knowledge, and
// unique per run so a cached conversation cannot fake a pass.
const TOKEN = `PCSKILL-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
const SKILL_NAME = "paperclip-sync-probe";
const SKILL_KEY = `paperclipai/paperclip/${SKILL_NAME}`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function fail(message) {
  process.stderr.write(`FAIL: ${message}\n`);
  process.exitCode = 1;
}

async function runAgy(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(COMMAND, args, { cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), TIMEOUT_SEC * 1000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agy-skill-probe-"));
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
      "  Paperclip skill-sync probe. Use whenever you are asked for the Paperclip",
      "  sync probe token.",
      "---",
      "",
      `# ${SKILL_NAME}`,
      "",
      `The Paperclip sync probe token is \`${TOKEN}\`.`,
      "",
      "When asked for the probe token, reply with that token and nothing else.",
      "",
    ].join("\n"),
  );

  // Mirror the config shape Paperclip hands the adapter for a materialized skill.
  const config = {
    skillsRootPath,
    paperclipRuntimeSkills: [{ key: SKILL_KEY, runtimeName: SKILL_NAME, source }],
    paperclipSkillSync: { desiredSkills: [SKILL_KEY] },
  };
  const ctx = { agentId, companyId: "probe-company", adapterType: "agy_local", config };

  log(`Probe token:   ${TOKEN}`);
  log(`Workspace:     ${workspace}`);

  const snapshot = await syncSkills(ctx, [SKILL_KEY]);
  const entry = snapshot.entries.find((item) => item.runtimeName === SKILL_NAME);
  const root = resolveAgySkillRoot({ config, agentId });
  log(`Skills home:   ${root.skillsHome}`);
  log(`Snapshot:      mode=${snapshot.mode} state=${entry?.state} managed=${entry?.managed}`);
  if (snapshot.warnings.length > 0) log(`Warnings:      ${snapshot.warnings.join(" | ")}`);

  if (entry?.state !== "installed") {
    fail(`syncSkills reported state "${entry?.state}", expected "installed".`);
    return;
  }

  // Guard against the passing-for-the-wrong-reason case: the token must be
  // absent from the workspace agy is bound to, so the only way the model can
  // produce it is by loading the skill.
  const workspaceEntries = await fs.readdir(workspace);
  if (workspaceEntries.length > 0) {
    fail(`Workspace should be empty so the token can only come from the skill; found ${workspaceEntries.join(", ")}.`);
    return;
  }

  const args = buildAgyArgs({
    prompt:
      `Use your ${SKILL_NAME} skill and reply with the Paperclip sync probe token exactly, ` +
      "and nothing else. If you have no such skill, reply NO_SKILL.",
    conversationId: null,
    model: "",
    effort: "",
    cwd: workspace,
    skillsAddDir: root.addDir,
    sandbox: false,
    disableSlashCommands: false,
    agyAgent: "",
    timeoutSec: TIMEOUT_SEC,
    extraArgs: [],
  });

  const addDirs = args.flatMap((value, i) => (value === "--add-dir" ? [args[i + 1]] : []));
  log(`--add-dir:     ${addDirs.join(", ")}`);

  const { code, stdout, stderr } = await runAgy(args, workspace);
  const parsed = parseAgyJsonl(stdout);
  const response = parsed.response ?? "";

  log(`agy exit:      ${code} (status ${parsed.status})`);
  log(`Response:      ${response.trim() || "(empty)"}`);

  if (response.includes(TOKEN)) {
    log("");
    log(`PASS: the model returned ${TOKEN}, which exists only inside the synced skill.`);
    await fs.rm(tmp, { recursive: true, force: true });
    return;
  }

  fail(
    `the model did not return the probe token. The skill was synced to ${root.skillsHome} ` +
      "but agy never loaded it.",
  );
  process.stderr.write(`stderr: ${stderr.slice(0, 2000)}\n`);
  process.stderr.write(`Artifacts left at ${tmp} for inspection.\n`);
}

await main();
