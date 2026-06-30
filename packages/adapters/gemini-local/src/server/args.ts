import path from "node:path";

/**
 * Detect whether the configured command is the Antigravity CLI (`agy`) rather
 * than the stock `gemini` CLI. `agy` shares the gemini_local adapter but uses a
 * different flag dialect, so the run path must branch on this.
 */
export function isAgyCommand(command: string): boolean {
  const base = path
    .basename(String(command ?? "").trim())
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/i, "");
  return base === "agy" || base === "antigravity";
}

export interface GeminiInvocationArgOptions {
  /** True when the resolved command is `agy`/`antigravity`. */
  isAgy: boolean;
  /** Resume token when continuing a prior session, else null. */
  resumeSessionId: string | null;
  /** Configured model (already trimmed). */
  model: string;
  /** Adapter default model; `--model` is omitted when model equals this. */
  defaultModel: string;
  /** Whether sandboxing is requested. */
  sandbox: boolean;
  /** Extra args appended verbatim before the prompt. */
  extraArgs: string[];
  /** Fully-rendered prompt text. */
  prompt: string;
  /** Optional process execution timeout in seconds. */
  timeoutSec?: number;
}

/**
 * Build the CLI argv for a single non-interactive run.
 *
 * The stock `gemini` CLI accepts `--output-format stream-json`,
 * `--approval-mode yolo`, `--sandbox=none`, and `--resume <id>`. The
 * Antigravity CLI (`agy`) rejects all four ("flags provided but not defined"),
 * so when `isAgy` is set we emit agy's equivalent dialect:
 *   - no `--output-format` (agy prints plain text)
 *   - `--approval-mode yolo` -> `--dangerously-skip-permissions`
 *   - `--sandbox=none` -> omitted (agy `--sandbox` is boolean-only)
 *   - `--resume <id>` -> `--continue` (agy print mode exposes no conversation
 *     id to round-trip, so we resume the most recent conversation)
 */
export function buildGeminiInvocationArgs(opts: GeminiInvocationArgOptions): string[] {
  const { isAgy, resumeSessionId, model, defaultModel, sandbox, extraArgs, prompt, timeoutSec } = opts;

  if (isAgy) {
    const args: string[] = [];
    if (resumeSessionId) args.push("--continue");
    if (model && model !== defaultModel) args.push("--model", model);
    args.push("--dangerously-skip-permissions");
    if (sandbox) args.push("--sandbox");
    if (!extraArgs.includes("--print-timeout")) {
      const timeoutVal = timeoutSec && timeoutSec > 0 ? `${timeoutSec}s` : "30m";
      args.push("--print-timeout", timeoutVal);
    }
    if (extraArgs.length > 0) args.push(...extraArgs);
    args.push("--prompt", prompt);
    return args;
  }

  const args = ["--output-format", "stream-json"];
  if (resumeSessionId) args.push("--resume", resumeSessionId);
  if (model && model !== defaultModel) args.push("--model", model);
  args.push("--approval-mode", "yolo");
  if (sandbox) {
    args.push("--sandbox");
  } else {
    args.push("--sandbox=none");
  }
  if (extraArgs.length > 0) args.push(...extraArgs);
  args.push("--prompt", prompt);
  return args;
}

/**
 * Sentinel session id stored after a successful `agy` run. agy print mode does
 * not surface a conversation id, so we persist this marker purely to signal
 * "a prior conversation exists" on the next heartbeat, which triggers
 * `--continue` in {@link buildGeminiInvocationArgs}.
 */
export const AGY_SESSION_SENTINEL = "agy:most-recent";
