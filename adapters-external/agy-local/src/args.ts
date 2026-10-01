/**
 * Argument construction for `agy`.
 *
 * The one non-obvious requirement: agy does **not** treat its process cwd as
 * the workspace. In a probe, a run launched with cwd set to a scratch directory
 * wrote its output to `~/.gemini/antigravity-cli/scratch/` instead. Passing
 * `--add-dir <cwd>` binds the run to the intended directory, so this adapter
 * always passes it. Dropping that flag silently sends agent edits somewhere the
 * Paperclip workspace will never see.
 */

import path from "node:path";

export interface BuildAgyArgsInput {
  prompt: string;
  /** Conversation to resume, or null to start fresh. */
  conversationId: string | null;
  /** Resolved model id, or "" / "auto" to let agy choose. */
  model: string;
  /** "low" | "medium" | "high", or "" to leave unset. */
  effort: string;
  /** Absolute working directory the run must operate in. */
  cwd: string;
  /**
   * Extra directory holding this agent's synced skills (`<root>/.agents/skills`),
   * or null when skills live somewhere agy scans unconditionally. agy reads a
   * `.agents/skills` tree under *every* `--add-dir` root, which is what lets
   * Paperclip deliver skills without writing into the workspace repo.
   */
  skillsAddDir: string | null;
  sandbox: boolean;
  disableSlashCommands: boolean;
  /** Named agy agent, or "" for the default. */
  agyAgent: string;
  /** Paperclip's run timeout, used to derive agy's own --print-timeout. */
  timeoutSec: number;
  extraArgs: string[];
}

export const AGY_AUTO_MODEL = "auto";

/**
 * Every model agy currently exposes bakes reasoning effort into its id
 * (`gemini-3.8-flash-high`, `gpt-oss-120b-medium`, ...). agy rejects `--model`
 * plus `--effort` together unless the two happen to agree, so the adapter
 * must never send both. This detects the effort-suffixed models (everything
 * except `auto`, `claude-sonnet-4-6` and `claude-opus-4-6-thinking` today) so
 * `--effort` can be suppressed for them regardless of what the config field
 * says.
 */
export function modelHasEffortSuffix(model: string): boolean {
  return /-(?:low|medium|high)$/i.test(model.trim());
}

/**
 * agy's own print timeout is set slightly *below* Paperclip's run timeout so
 * agy exits on its own and still emits a result event, rather than being killed
 * mid-stream by Paperclip and losing the conversation id.
 */
export function resolveAgyPrintTimeoutSec(timeoutSec: number): number {
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) return 0;
  const margin = Math.max(10, Math.floor(timeoutSec * 0.05));
  return Math.max(30, timeoutSec - margin);
}

export function buildAgyArgs(input: BuildAgyArgsInput): string[] {
  const args: string[] = ["--output-format", "stream-json"];

  if (input.conversationId) args.push("--conversation", input.conversationId);

  const model = input.model.trim();
  if (model.length > 0 && model !== AGY_AUTO_MODEL) args.push("--model", model);

  const effort = input.effort.trim().toLowerCase();
  // Never pass --effort alongside a model id that already encodes it — agy
  // rejects the run outright unless the two happen to match. See
  // modelHasEffortSuffix() above.
  if ((effort === "low" || effort === "medium" || effort === "high") && !modelHasEffortSuffix(model)) {
    args.push("--effort", effort);
  }

  const agyAgent = input.agyAgent.trim();
  if (agyAgent.length > 0) args.push("--agent", agyAgent);

  // Unattended runs must never block on a permission prompt.
  args.push("--dangerously-skip-permissions");

  if (input.sandbox) args.push("--sandbox");
  if (input.disableSlashCommands) args.push("--disable-slash-commands");

  // See the module comment: this is what actually binds agy to the workspace.
  // It must come first — agy treats the first added directory as the primary
  // workspace, and a skill root promoted to that position would relocate the run.
  if (input.cwd.trim().length > 0) args.push("--add-dir", input.cwd);

  const skillsAddDir = input.skillsAddDir?.trim() ?? "";
  if (skillsAddDir.length > 0 && path.resolve(skillsAddDir) !== path.resolve(input.cwd)) {
    args.push("--add-dir", skillsAddDir);
  }

  const printTimeoutSec = resolveAgyPrintTimeoutSec(input.timeoutSec);
  if (printTimeoutSec > 0) args.push("--print-timeout", `${printTimeoutSec}s`);

  if (input.extraArgs.length > 0) args.push(...input.extraArgs);

  // --print carries the prompt and must stay last so the redacted log view can
  // replace exactly the final argument.
  args.push("--print", input.prompt);
  return args;
}

/** Operator-facing notes explaining the non-obvious flags. */
export function describeAgyArgs(
  input: Pick<BuildAgyArgsInput, "cwd" | "sandbox" | "timeoutSec"> &
    Partial<Pick<BuildAgyArgsInput, "skillsAddDir">>,
): string[] {
  const notes = [
    "Prompt is passed to agy via --print for non-interactive execution.",
    "Added --dangerously-skip-permissions so unattended runs never block on a permission prompt.",
    `Added --add-dir ${input.cwd} — agy does not treat its process cwd as the workspace, so this binds the run to the Paperclip workspace.`,
  ];
  const skillsAddDir = input.skillsAddDir?.trim() ?? "";
  if (skillsAddDir.length > 0 && path.resolve(skillsAddDir) !== path.resolve(input.cwd)) {
    notes.push(
      `Added --add-dir ${skillsAddDir} so agy loads the Paperclip skills synced to ${skillsAddDir}/.agents/skills.`,
    );
  }
  const printTimeoutSec = resolveAgyPrintTimeoutSec(input.timeoutSec);
  if (printTimeoutSec > 0) {
    notes.push(
      `Set --print-timeout ${printTimeoutSec}s, just under the ${input.timeoutSec}s Paperclip timeout, so agy exits cleanly and still reports its conversation id.`,
    );
  }
  notes.push(
    input.sandbox
      ? "Added --sandbox because the agent config requested agy's own sandbox."
      : "Left agy's sandbox off; Paperclip owns the execution boundary.",
  );
  return notes;
}
