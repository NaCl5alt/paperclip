/**
 * Skill delivery for agy.
 *
 * agy has a first-class skill loader with the same on-disk shape as Claude Code
 * (`<name>/SKILL.md` with `name` / `description` frontmatter), so Paperclip
 * skills need no transformation — only to land in a directory agy actually
 * scans. Which directories those are was established by probing agy 1.1.28 with
 * uniquely-tokened skills and asking the model to enumerate/use them:
 *
 *   scanned      ~/.gemini/config/skills/<name>/SKILL.md
 *   scanned      <any --add-dir root>/.agents/skills/<name>/SKILL.md
 *   NOT scanned  ~/.gemini/skills/<name>/SKILL.md
 *   NOT scanned  <workspace>/.claude/skills, <workspace>/.gemini/skills
 *
 * The third line is the important one: `~/.gemini/skills` is where the
 * deprecated `gemini_local` lane linked Paperclip's skills, and agy ignores it
 * entirely. A skill "synced" there is silently invisible, which is the exact
 * failure this module exists to prevent — so nothing here may ever target it.
 *
 * That `--add-dir` roots each contribute their own `.agents/skills` is what
 * makes per-agent isolation possible: the adapter already passes
 * `--add-dir <cwd>` to bind the workspace (see args.ts), and a *second*
 * `--add-dir` pointed at a Paperclip-owned directory delivers skills without
 * writing into the user's repository and without a host-wide shared root.
 *
 * Symlinked skill directories resolve correctly inside a scanned root, so sync
 * links rather than copies — the agent always reads the live skill version and
 * `buildPersistentSkillSnapshot` can detect drift by comparing link targets.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AdapterSkillContext, AdapterSkillSnapshot } from "@paperclipai/adapter-utils";
import {
  asString,
  buildPersistentSkillSnapshot,
  ensurePaperclipSkillSymlink,
  isPaperclipSkillSourceMissing,
  readInstalledSkillTargets,
  readPaperclipRuntimeSkillEntries,
  resolveLegacyPaperclipDesiredSkillNames,
  type InstalledSkillTarget,
  type PaperclipSkillEntry,
} from "@paperclipai/adapter-utils/server-utils";

import { ADAPTER_TYPE } from "./constants.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Path segment agy scans for skills beneath every `--add-dir` root. */
export const AGY_WORKSPACE_SKILL_SUBPATH = path.join(".agents", "skills");

/** agy's global customization root. Always scanned, shared by every agy run on the host. */
export const AGY_GLOBAL_SKILLS_HOME_SEGMENTS = [".gemini", "config", "skills"] as const;

/** Root for the per-agent skill trees this adapter owns. */
export const AGY_AGENT_SKILL_ROOT_SEGMENTS = [".agy-paperclip", "agents"] as const;

export type AgySkillScope = "agent" | "global";

export interface AgySkillRoot {
  scope: AgySkillScope;
  /**
   * Directory to pass to agy as an extra `--add-dir`, or null when the skills
   * home is a root agy scans unconditionally.
   */
  addDir: string | null;
  /** Directory holding `<runtimeName>/SKILL.md`. */
  skillsHome: string;
  /** Human-readable location for the Paperclip skills UI. */
  locationLabel: string;
}

export interface ResolveAgySkillRootInput {
  config: Record<string, unknown>;
  agentId: string;
  /** Overridable for tests; defaults to the process user's home directory. */
  homeDir?: string;
}

function normalizeScope(value: unknown): AgySkillScope {
  return asString(value, "agent").trim().toLowerCase() === "global" ? "global" : "agent";
}

/**
 * Sanitize an agent id into a single path segment.
 *
 * Agent ids are UUIDs in practice, but this is the only caller-controlled part
 * of a path the adapter creates and deletes symlinks in, so it is not left to
 * trust: anything outside `[A-Za-z0-9._-]` is replaced, and `.` / `..` can
 * never survive as a whole segment.
 */
export function sanitizeAgentIdSegment(agentId: string): string {
  const cleaned = agentId.trim().replace(/[^A-Za-z0-9._-]/g, "-");
  if (cleaned.length === 0 || /^\.+$/.test(cleaned)) return "unknown-agent";
  return cleaned;
}

/**
 * Decide where this agent's skills live.
 *
 * Both branches are pure functions of the adapter config plus the agent id,
 * which is what lets `execute` derive the same `--add-dir` that `syncSkills`
 * wrote to without any shared state between them.
 */
export function resolveAgySkillRoot(input: ResolveAgySkillRootInput): AgySkillRoot {
  const { config, agentId } = input;
  const homeDir = input.homeDir ?? os.homedir();
  const scope = normalizeScope(config.skillsScope);

  if (scope === "global") {
    const skillsHome = path.join(homeDir, ...AGY_GLOBAL_SKILLS_HOME_SEGMENTS);
    return {
      scope,
      // agy scans its global customization root with no flag, and adding it as a
      // workspace directory would hand the agent write access to the operator's
      // whole agy config.
      addDir: null,
      skillsHome,
      locationLabel: skillsHome,
    };
  }

  const configuredRoot = asString(config.skillsRootPath, "").trim();
  const addDir = configuredRoot
    ? path.resolve(configuredRoot)
    : path.join(homeDir, ...AGY_AGENT_SKILL_ROOT_SEGMENTS, sanitizeAgentIdSegment(agentId));

  return {
    scope,
    addDir,
    skillsHome: path.join(addDir, AGY_WORKSPACE_SKILL_SUBPATH),
    locationLabel: path.join(addDir, AGY_WORKSPACE_SKILL_SUBPATH),
  };
}

async function readAvailableEntries(
  config: Record<string, unknown>,
): Promise<PaperclipSkillEntry[]> {
  return withAgyRuntimeNames(await readPaperclipRuntimeSkillEntries(config, moduleDir));
}

/**
 * agy only loads a skill when its directory name equals the `name` in its SKILL.md
 * frontmatter (Claude Code is lenient here). Paperclip gives company skills a hashed
 * runtime name such as `werkafspraken--7b03de82a7`, which agy then silently ignores —
 * the link exists, the skill never loads. Strip that suffix so the link is named after
 * the skill; keep the hashed name only when two entries would otherwise collide.
 */
export function agyRuntimeName(runtimeName: string): string {
  return runtimeName.replace(/--[0-9a-f]{6,}$/, "");
}

export function withAgyRuntimeNames(entries: PaperclipSkillEntry[]): PaperclipSkillEntry[] {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.runtimeName) continue;
    const base = agyRuntimeName(entry.runtimeName);
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  return entries.map((entry) => {
    if (!entry.runtimeName) return entry;
    const base = agyRuntimeName(entry.runtimeName);
    return counts.get(base) === 1 ? { ...entry, runtimeName: base } : entry;
  });
}

function buildSnapshot(options: {
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  root: AgySkillRoot;
  warnings: string[];
}): AdapterSkillSnapshot {
  const { availableEntries, desiredSkills, installed, root, warnings } = options;
  return buildPersistentSkillSnapshot({
    adapterType: ADAPTER_TYPE,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome: root.skillsHome,
    locationLabel: root.locationLabel,
    installedDetail:
      root.scope === "global"
        ? "Linked into agy's global skills directory."
        : "Linked into this agent's agy skill root and passed to the run with --add-dir.",
    missingDetail: "Not linked into an agy skills directory yet; run a skill sync.",
    externalConflictDetail:
      "A different skill directory already occupies this name in agy's skills directory. Paperclip will not overwrite it.",
    externalDetail: "Installed in agy's skills directory outside Paperclip management.",
    warnings,
  });
}

export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const root = resolveAgySkillRoot({ config: ctx.config, agentId: ctx.agentId });
  const availableEntries = await readAvailableEntries(ctx.config);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(ctx.config, availableEntries);
  const installed = await readInstalledSkillTargets(root.skillsHome);
  return buildSnapshot({
    availableEntries,
    desiredSkills,
    installed,
    root,
    warnings: warningsForRoot(root),
  });
}

function warningsForRoot(root: AgySkillRoot): string[] {
  if (root.scope !== "global") return [];
  return [
    "skillsScope is \"global\": every agy agent on this host shares " +
      `${root.skillsHome}, so skills synced for one agent are visible to all of them.`,
  ];
}

export interface RunSkillSync {
  root: AgySkillRoot;
  /** Null when the run performed no sync (global scope, or nothing to deliver). */
  snapshot: AdapterSkillSnapshot | null;
  /** Skill keys this run expected to be present. */
  desiredSkills: string[];
  warnings: string[];
}

/**
 * Reconcile this agent's skill root from the entries Paperclip put in the run
 * config, before the run starts.
 *
 * This exists because the heartbeat runner never calls `syncSkills`: it resolves
 * the agent's runtime skill entries, puts them in `config.paperclipRuntimeSkills`
 * and hands that to `execute`, expecting the adapter to materialize them for the
 * run (the same contract `requiresMaterializedRuntimeSkills` describes). Without
 * this, skills only reached agy after somebody hit "sync" in the skills UI, and
 * run-scoped skills — the ones the runner adds because a skill was mentioned in
 * the issue thread — never reached it at all. Both are the silent-omission
 * failure mode this module exists to prevent.
 *
 * Only "agent" scope syncs per run: that root belongs to this agent alone, so
 * reconciling it is safe. The "global" root is shared by every agy agent on the
 * host, and pruning it on each run would let agents delete each other's skills,
 * so it stays under explicit `syncSkills` control.
 */
export async function syncSkillsForRun(input: {
  config: Record<string, unknown>;
  agentId: string;
  companyId: string;
}): Promise<RunSkillSync> {
  const { config, agentId, companyId } = input;
  const root = resolveAgySkillRoot({ config, agentId });
  const availableEntries = await readAvailableEntries(config);
  const desiredSkills = resolveLegacyPaperclipDesiredSkillNames(config, availableEntries);

  if (root.scope === "global") {
    return { root, snapshot: null, desiredSkills, warnings: [] };
  }
  if (desiredSkills.length === 0 && availableEntries.length === 0) {
    return { root, snapshot: null, desiredSkills, warnings: [] };
  }

  const snapshot = await syncSkills(
    { agentId, companyId, adapterType: ADAPTER_TYPE, config },
    desiredSkills,
  );
  return { root, snapshot, desiredSkills, warnings: snapshot.warnings };
}

/** Prefix every skill-sync receipt line carries, so a run log can be grepped for it. */
export const SKILL_SYNC_LOG_PREFIX = "[paperclip] skill sync:";

function shortVersion(versionId: string | null | undefined): string {
  const value = (versionId ?? "").trim();
  if (!value) return "unpinned";
  return value.length > 8 ? value.slice(0, 8) : value;
}

/**
 * Render a per-run receipt for what skill sync actually did.
 *
 * The control plane cannot show this: `usedByAgents[].actualState` on
 * `GET /api/companies/{c}/skills/{id}` is hardcoded `null` server-side
 * (`@paperclipai/server` `services/company-skills.js`, `usage()`), and the
 * `ServerAdapterModule` surface has no write-back hook — `listSkills` and
 * `syncSkills` only *return* a snapshot to whoever called the HTTP route. So
 * the adapter's snapshot is correct and simply never persisted anywhere an
 * operator looks.
 *
 * Until that changes upstream, the run log is the only place this adapter can
 * put the signal. Before this, a successful sync logged *nothing* — the happy
 * path and the silent-omission failure this module exists to prevent produced
 * byte-identical output, which is why HEA-49 had to be verified by grepping a
 * transcript for the agent's own `view_file` call. Every branch below emits at
 * least one line, so "synced nothing on purpose" and "never ran" stay
 * distinguishable.
 */
export function describeRunSkillSync(sync: RunSkillSync): string[] {
  const { root, snapshot, desiredSkills } = sync;

  if (root.scope === "global") {
    return [
      `${SKILL_SYNC_LOG_PREFIX} skipped — skillsScope is "global"; ${root.skillsHome} is ` +
        "shared host-wide and is only reconciled by an explicit sync, never per run.",
    ];
  }
  if (!snapshot) {
    return [
      `${SKILL_SYNC_LOG_PREFIX} nothing to deliver — no skills are assigned to this agent. ` +
        `Root: ${root.skillsHome}`,
    ];
  }

  const desiredSet = new Set(desiredSkills);
  const delivered = snapshot.entries.filter((entry) => entry.desired && entry.state === "installed");
  const undelivered = snapshot.entries.filter(
    (entry) => entry.desired && entry.state !== "installed",
  );
  const lines = [
    `${SKILL_SYNC_LOG_PREFIX} ${delivered.length}/${desiredSet.size} desired skill(s) installed` +
      `${undelivered.length > 0 ? `, ${undelivered.length} not installed` : ""}. ` +
      `Root: ${root.skillsHome}`,
  ];
  for (const entry of delivered) {
    lines.push(
      `${SKILL_SYNC_LOG_PREFIX}   installed ${entry.runtimeName ?? "(unnamed)"} ` +
        `version=${shortVersion(entry.versionId)} key=${entry.key}`,
    );
  }
  for (const entry of undelivered) {
    // A desired skill Paperclip never provided a runtime entry for arrives here
    // with no runtimeName — it is only identifiable by key, and naming it is the
    // whole point, since silent omission is how this adapter has failed twice.
    lines.push(
      `${SKILL_SYNC_LOG_PREFIX}   ${entry.state}` +
        `${entry.runtimeName ? ` ${entry.runtimeName}` : ""} key=${entry.key}`,
    );
  }
  return lines;
}

export async function syncSkills(
  ctx: AdapterSkillContext,
  desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  const root = resolveAgySkillRoot({ config: ctx.config, agentId: ctx.agentId });
  const availableEntries = await readAvailableEntries(ctx.config);
  const desiredSet = new Set(desiredSkills);
  const warnings = warningsForRoot(root);

  await fs.mkdir(root.skillsHome, { recursive: true });

  // Link everything desired.
  for (const entry of availableEntries) {
    if (!desiredSet.has(entry.key)) continue;
    if (isPaperclipSkillSourceMissing(entry)) {
      // The version snapshot never materialized; linking would create a dangling
      // link that agy surfaces as a broken skill rather than an absent one.
      warnings.push(`Skipped "${entry.runtimeName}": its skill files are not available on disk.`);
      continue;
    }
    const target = path.join(root.skillsHome, entry.runtimeName);
    try {
      const outcome = await ensurePaperclipSkillSymlink(entry.source, target);
      if (outcome === "skipped") {
        const existing = await fs.lstat(target).catch(() => null);
        if (existing && !existing.isSymbolicLink()) {
          warnings.push(
            `Left "${entry.runtimeName}" alone: ${target} exists and is not a Paperclip-managed link.`,
          );
        }
      }
    } catch (err) {
      warnings.push(
        `Failed to link "${entry.runtimeName}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Remove links this adapter previously created for skills no longer desired.
  // Only Paperclip-owned symlinks are removed — a real directory in the skills
  // home belongs to the operator, and in "global" scope it may well be a skill
  // they installed by hand.
  const installedBefore = await readInstalledSkillTargets(root.skillsHome);
  const managedSources = new Set(availableEntries.map((entry) => entry.source));
  for (const [runtimeName, installedEntry] of installedBefore) {
    if (installedEntry.kind !== "symlink") continue;
    if (!installedEntry.targetPath || !managedSources.has(installedEntry.targetPath)) continue;
    const entry = availableEntries.find((candidate) => candidate.runtimeName === runtimeName);
    if (entry && desiredSet.has(entry.key)) continue;
    await fs.unlink(path.join(root.skillsHome, runtimeName)).catch(() => {});
  }

  const installed = await readInstalledSkillTargets(root.skillsHome);
  return buildSnapshot({ availableEntries, desiredSkills, installed, root, warnings });
}
