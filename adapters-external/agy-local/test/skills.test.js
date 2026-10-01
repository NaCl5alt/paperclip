import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  AGY_WORKSPACE_SKILL_SUBPATH,
  listSkills,
  resolveAgySkillRoot,
  sanitizeAgentIdSegment,
  syncSkills,
  syncSkillsForRun,
  describeRunSkillSync,
  SKILL_SYNC_LOG_PREFIX,
} from "../dist/skills.js";
import { buildAgyArgs, describeAgyArgs } from "../dist/args.js";

const AGENT_ID = "30223245-91b7-48df-bedb-5f5049b05c38";

async function makeTempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "agy-skills-test-"));
}

/** Build a runtime skill tree the way Paperclip materializes one. */
async function writeSkillSource(root, name, body) {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${body}\n---\n\n${body}\n`,
  );
  return dir;
}

function skillConfig(sourceDirs, extra = {}) {
  return {
    paperclipRuntimeSkills: Object.entries(sourceDirs).map(([key, source]) => ({
      key,
      runtimeName: key.split("/").pop(),
      source,
    })),
    ...extra,
  };
}

// ── Path resolution ─────────────────────────────────────────────────────────

test("agent scope puts skills under a per-agent .agents/skills root", () => {
  const root = resolveAgySkillRoot({ config: {}, agentId: AGENT_ID, homeDir: "/home/u" });
  assert.equal(root.scope, "agent");
  assert.equal(root.addDir, path.join("/home/u", ".agy-paperclip", "agents", AGENT_ID));
  assert.equal(root.skillsHome, path.join(root.addDir, AGY_WORKSPACE_SKILL_SUBPATH));
  // The subpath is what agy actually scans beneath an --add-dir root.
  assert.equal(AGY_WORKSPACE_SKILL_SUBPATH, path.join(".agents", "skills"));
});

test("agent scope honours an explicit skillsRootPath and appends .agents/skills to it", () => {
  const root = resolveAgySkillRoot({
    config: { skillsRootPath: "/srv/agy-skills" },
    agentId: AGENT_ID,
    homeDir: "/home/u",
  });
  assert.equal(root.addDir, path.resolve("/srv/agy-skills"));
  assert.equal(root.skillsHome, path.join("/srv/agy-skills", ".agents", "skills"));
});

test("global scope targets agy's config skills dir and needs no --add-dir", () => {
  const root = resolveAgySkillRoot({
    config: { skillsScope: "global", skillsRootPath: "/ignored" },
    agentId: AGENT_ID,
    homeDir: "/home/u",
  });
  assert.equal(root.scope, "global");
  assert.equal(root.skillsHome, path.join("/home/u", ".gemini", "config", "skills"));
  // agy scans this root unconditionally; adding it as a workspace dir would give
  // the agent write access to the operator's whole agy configuration.
  assert.equal(root.addDir, null);
});

test("never resolves to ~/.gemini/skills, which agy does not scan", () => {
  const dead = path.join("/home/u", ".gemini", "skills");
  for (const config of [{}, { skillsScope: "global" }, { skillsScope: "GLOBAL" }]) {
    const root = resolveAgySkillRoot({ config, agentId: AGENT_ID, homeDir: "/home/u" });
    assert.notEqual(root.skillsHome, dead);
  }
});

test("an unrecognized skillsScope falls back to per-agent rather than the shared root", () => {
  const root = resolveAgySkillRoot({
    config: { skillsScope: "workspace" },
    agentId: AGENT_ID,
    homeDir: "/home/u",
  });
  assert.equal(root.scope, "agent");
});

test("agent ids are reduced to a single safe path segment", () => {
  assert.equal(sanitizeAgentIdSegment(AGENT_ID), AGENT_ID);
  // Traversal collapses into an inert single segment: separators are gone and
  // the result is not "." or "..", so it cannot escape the skills root.
  assert.equal(sanitizeAgentIdSegment("../../etc"), "..-..-etc");
  assert.equal(sanitizeAgentIdSegment(".."), "unknown-agent");
  assert.equal(sanitizeAgentIdSegment("  "), "unknown-agent");
  assert.ok(!sanitizeAgentIdSegment("a/b/c").includes(path.sep));
});

// ── Argument construction ───────────────────────────────────────────────────

const BASE_ARGS = {
  prompt: "hi",
  conversationId: null,
  model: "",
  effort: "",
  cwd: "/work/repo",
  skillsAddDir: null,
  sandbox: false,
  disableSlashCommands: false,
  agyAgent: "",
  timeoutSec: 600,
  extraArgs: [],
};

test("the skill root is added as a second --add-dir, after the workspace", () => {
  const args = buildAgyArgs({ ...BASE_ARGS, skillsAddDir: "/home/u/.agy-paperclip/agents/a1" });
  const addDirValues = args.flatMap((value, i) => (value === "--add-dir" ? [args[i + 1]] : []));
  // Order matters: agy treats the first added directory as the primary
  // workspace, so the skill root must never come first.
  assert.deepEqual(addDirValues, ["/work/repo", "/home/u/.agy-paperclip/agents/a1"]);
});

test("no skill root means exactly one --add-dir", () => {
  const args = buildAgyArgs(BASE_ARGS);
  assert.equal(args.filter((value) => value === "--add-dir").length, 1);
});

test("a skill root equal to the workspace is not added twice", () => {
  const args = buildAgyArgs({ ...BASE_ARGS, skillsAddDir: "/work/repo/" });
  assert.equal(args.filter((value) => value === "--add-dir").length, 1);
});

test("the operator notes explain the extra --add-dir", () => {
  const notes = describeAgyArgs({
    cwd: "/work/repo",
    sandbox: false,
    timeoutSec: 600,
    skillsAddDir: "/home/u/.agy-paperclip/agents/a1",
  });
  assert.ok(notes.some((note) => note.includes(".agents/skills")));
  assert.ok(
    describeAgyArgs({ cwd: "/work/repo", sandbox: false, timeoutSec: 600 }).every(
      (note) => !note.includes(".agents/skills"),
    ),
  );
});

// ── listSkills / syncSkills ─────────────────────────────────────────────────

test("listSkills reports desired-but-unsynced skills as missing", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const src = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

  const config = skillConfig(
    { "paperclipai/paperclip/alpha": src },
    {
      skillsRootPath: path.join(tmp, "root"),
      paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
    },
  );
  const snapshot = await listSkills({
    agentId: AGENT_ID,
    companyId: "c1",
    adapterType: "agy_local",
    config,
  });

  assert.equal(snapshot.adapterType, "agy_local");
  assert.equal(snapshot.supported, true);
  assert.equal(snapshot.mode, "persistent");
  const alpha = snapshot.entries.find((entry) => entry.runtimeName === "alpha");
  assert.equal(alpha.desired, true);
  assert.equal(alpha.state, "missing");
});

test("syncSkills links desired skills into the agy skills home", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
  const beta = await writeSkillSource(path.join(tmp, "src"), "beta", "Beta skill");
  const rootPath = path.join(tmp, "root");

  const config = skillConfig(
    { "paperclipai/paperclip/alpha": alpha, "paperclipai/paperclip/beta": beta },
    { skillsRootPath: rootPath },
  );
  const snapshot = await syncSkills(
    { agentId: AGENT_ID, companyId: "c1", adapterType: "agy_local", config },
    ["paperclipai/paperclip/alpha"],
  );

  const skillsHome = path.join(rootPath, ".agents", "skills");
  // The link must resolve to a readable SKILL.md — a dangling link is exactly
  // the silent failure this hook exists to prevent.
  assert.equal(
    await fs.realpath(path.join(skillsHome, "alpha")),
    await fs.realpath(alpha),
  );
  assert.match(await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8"), /Alpha skill/);
  assert.equal(await fs.lstat(path.join(skillsHome, "beta")).catch(() => null), null);

  const alphaEntry = snapshot.entries.find((entry) => entry.runtimeName === "alpha");
  assert.equal(alphaEntry.state, "installed");
  assert.equal(alphaEntry.managed, true);
});

test("syncSkills removes a link it owns once the skill is no longer desired", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
  const rootPath = path.join(tmp, "root");
  const ctx = {
    agentId: AGENT_ID,
    companyId: "c1",
    adapterType: "agy_local",
    config: skillConfig({ "paperclipai/paperclip/alpha": alpha }, { skillsRootPath: rootPath }),
  };

  await syncSkills(ctx, ["paperclipai/paperclip/alpha"]);
  await syncSkills(ctx, []);

  const skillsHome = path.join(rootPath, ".agents", "skills");
  assert.equal(await fs.lstat(path.join(skillsHome, "alpha")).catch(() => null), null);
});

test("syncSkills leaves an unmanaged directory in the skills home alone", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
  const rootPath = path.join(tmp, "root");
  const skillsHome = path.join(rootPath, ".agents", "skills");

  // A hand-installed skill occupying the same name.
  await writeSkillSource(skillsHome, "alpha", "Operator's own alpha");

  const snapshot = await syncSkills(
    {
      agentId: AGENT_ID,
      companyId: "c1",
      adapterType: "agy_local",
      config: skillConfig({ "paperclipai/paperclip/alpha": alpha }, { skillsRootPath: rootPath }),
    },
    ["paperclipai/paperclip/alpha"],
  );

  assert.match(
    await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8"),
    /Operator's own alpha/,
  );
  const entry = snapshot.entries.find((item) => item.runtimeName === "alpha");
  assert.equal(entry.state, "external");
  assert.ok(snapshot.warnings.some((warning) => warning.includes("alpha")));
});

test("syncSkills skips a skill whose source never materialized", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const rootPath = path.join(tmp, "root");
  const config = {
    skillsRootPath: rootPath,
    paperclipRuntimeSkills: [
      {
        key: "paperclipai/paperclip/ghost",
        runtimeName: "ghost",
        source: path.join(tmp, "src", "ghost"),
        sourceStatus: "missing",
        missingDetail: "version snapshot deleted",
      },
    ],
  };

  const snapshot = await syncSkills(
    { agentId: AGENT_ID, companyId: "c1", adapterType: "agy_local", config },
    ["paperclipai/paperclip/ghost"],
  );

  // A dangling link reads to agy as a broken skill; absence is the safer state.
  const skillsHome = path.join(rootPath, ".agents", "skills");
  assert.equal(await fs.lstat(path.join(skillsHome, "ghost")).catch(() => null), null);
  assert.equal(
    snapshot.entries.find((entry) => entry.runtimeName === "ghost").state,
    "missing",
  );
});

test("global scope warns that the skills home is shared across agents", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const snapshot = await listSkills({
    agentId: AGENT_ID,
    companyId: "c1",
    adapterType: "agy_local",
    config: { skillsScope: "global", paperclipRuntimeSkills: [] },
  });
  assert.ok(snapshot.warnings.some((warning) => warning.includes("shares")));
});

// ── syncSkillsForRun (the heartbeat path) ───────────────────────────────────
//
// The runner never calls syncSkills before a run: it puts the agent's runtime
// skill entries in config.paperclipRuntimeSkills and hands that to execute().
// These cover that path specifically — reaching the skills home only through
// run config, never through an explicit sync call.

test("syncSkillsForRun materializes skills from run config with no prior sync", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
  const rootPath = path.join(tmp, "root");

  const result = await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(
      { "paperclipai/paperclip/alpha": alpha },
      {
        skillsRootPath: rootPath,
        paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
      },
    ),
  });

  const skillsHome = path.join(rootPath, ".agents", "skills");
  assert.match(await fs.readFile(path.join(skillsHome, "alpha", "SKILL.md"), "utf8"), /Alpha skill/);
  assert.equal(result.root.addDir, path.resolve(rootPath));
  assert.equal(
    result.snapshot.entries.find((entry) => entry.runtimeName === "alpha").state,
    "installed",
  );
});

test("syncSkillsForRun delivers the operational skill even with an empty desired set", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const operational = await writeSkillSource(path.join(tmp, "src"), "paperclip", "Operational");
  const rootPath = path.join(tmp, "root");

  // An agent configured with no skills still needs the operational skill: it is
  // how a CLI runner reaches the Paperclip API at all.
  const result = await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(
      { "paperclipai/paperclip/paperclip": operational },
      { skillsRootPath: rootPath, paperclipSkillSync: { desiredSkills: [] } },
    ),
  });

  assert.ok(result.desiredSkills.includes("paperclipai/paperclip/paperclip"));
  assert.match(
    await fs.readFile(path.join(rootPath, ".agents", "skills", "paperclip", "SKILL.md"), "utf8"),
    /Operational/,
  );
});

test("syncSkillsForRun drops a link once the run config stops asking for it", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");
  const rootPath = path.join(tmp, "root");
  const sources = { "paperclipai/paperclip/alpha": alpha };

  await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(sources, {
      skillsRootPath: rootPath,
      paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
    }),
  });
  await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(sources, {
      skillsRootPath: rootPath,
      paperclipSkillSync: { desiredSkills: [] },
    }),
  });

  assert.equal(
    await fs.lstat(path.join(rootPath, ".agents", "skills", "alpha")).catch(() => null),
    null,
  );
});

test("syncSkillsForRun leaves the shared global root untouched", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

  // Every agy agent on the host shares the global root, so reconciling it on
  // each run would let one agent prune another's skills mid-flight.
  const result = await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(
      { "paperclipai/paperclip/alpha": alpha },
      {
        skillsScope: "global",
        paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
      },
    ),
  });

  assert.equal(result.snapshot, null);
  assert.equal(result.root.scope, "global");
});

// ── Run receipt ─────────────────────────────────────────────────────────────
// The control plane hardcodes `usedByAgents[].actualState: null`, so the run
// log is the only place a successful sync is observable. These tests pin that
// every branch says something: a silent happy path is the exact bug (HEA-55).

test("describeRunSkillSync names each installed skill and its version", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const rootPath = path.join(tmp, "root");
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

  const sync = await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: {
      skillsRootPath: rootPath,
      paperclipRuntimeSkills: [
        {
          key: "paperclipai/paperclip/alpha",
          runtimeName: "alpha",
          source: alpha,
          versionId: "b9e4beac-92a0-4ff2-9f57-c9e66c1655c2",
        },
      ],
      paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
    },
  });

  const lines = describeRunSkillSync(sync);
  assert.ok(lines.every((line) => line.startsWith(SKILL_SYNC_LOG_PREFIX)));
  assert.match(lines[0], /1\/1 desired skill\(s\) installed/);
  assert.ok(lines[0].includes(sync.root.skillsHome));
  // Truncated so the line stays readable, but long enough to identify a revision.
  assert.match(lines[1], /installed alpha version=b9e4beac key=paperclipai\/paperclip\/alpha/);
});

test("describeRunSkillSync reports an unpinned version rather than omitting the skill", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const rootPath = path.join(tmp, "root");
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

  const sync = await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(
      { "paperclipai/paperclip/alpha": alpha },
      {
        skillsRootPath: rootPath,
        paperclipSkillSync: { desiredSkills: ["paperclipai/paperclip/alpha"] },
      },
    ),
  });

  assert.match(describeRunSkillSync(sync).join("\n"), /installed alpha version=unpinned/);
});

test("describeRunSkillSync distinguishes 'nothing assigned' from 'never ran'", () => {
  // An empty log line here would read exactly like a sync that never happened,
  // which is the failure mode this receipt exists to rule out.
  const lines = describeRunSkillSync({
    root: resolveAgySkillRoot({ config: {}, agentId: AGENT_ID, homeDir: "/home/u" }),
    snapshot: null,
    desiredSkills: [],
    warnings: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /nothing to deliver — no skills are assigned to this agent/);
});

test("describeRunSkillSync explains why global scope did not sync", () => {
  const lines = describeRunSkillSync({
    root: resolveAgySkillRoot({ config: { skillsScope: "global" }, agentId: AGENT_ID, homeDir: "/home/u" }),
    snapshot: null,
    desiredSkills: ["paperclipai/paperclip/alpha"],
    warnings: [],
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0], /skipped — skillsScope is "global"/);
});

test("describeRunSkillSync flags a desired skill Paperclip never provided an entry for", async (t) => {
  const tmp = await makeTempDir();
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const rootPath = path.join(tmp, "root");
  const alpha = await writeSkillSource(path.join(tmp, "src"), "alpha", "Alpha skill");

  // "beta" is desired but has no runtime entry, so it cannot even surface as
  // "missing" — silent omission is precisely how this adapter has failed twice.
  const sync = await syncSkillsForRun({
    agentId: AGENT_ID,
    companyId: "c1",
    config: skillConfig(
      { "paperclipai/paperclip/alpha": alpha },
      {
        skillsRootPath: rootPath,
        paperclipSkillSync: {
          desiredSkills: ["paperclipai/paperclip/alpha", "paperclipai/paperclip/beta"],
        },
      },
    ),
  });

  const joined = describeRunSkillSync(sync).join("\n");
  assert.match(joined, /1 not installed/);
  // No runtimeName exists for it, so the key is the only handle — it must still
  // be named rather than dropped.
  assert.match(joined, /missing key=paperclipai\/paperclip\/beta/);
});

// agy loads a skill only when its directory name equals the SKILL.md `name`.
test("runtime names drop Paperclip's hash suffix unless that would collide", async () => {
  const { agyRuntimeName, withAgyRuntimeNames } = await import("../dist/skills.js");
  assert.equal(agyRuntimeName("werkafspraken--7b03de82a7"), "werkafspraken");
  assert.equal(agyRuntimeName("paperclip"), "paperclip");
  const out = withAgyRuntimeNames([
    { key: "a", runtimeName: "organisatie--4f1ad66e59" },
    { key: "b", runtimeName: "dup--aaaaaaaaaa" },
    { key: "c", runtimeName: "dup--bbbbbbbbbb" },
    { key: "d", runtimeName: "paperclip" },
  ]);
  assert.deepEqual(out.map((e) => e.runtimeName), ["organisatie", "dup--aaaaaaaaaa", "dup--bbbbbbbbbb", "paperclip"]);
});
