/**
 * Run one Paperclip heartbeat through the Antigravity CLI.
 *
 * Flow: resolve workspace cwd → build the Paperclip env → decide whether the
 * stored conversation can be resumed → assemble the prompt → spawn agy with
 * `--output-format stream-json` → parse the NDJSON → map to an
 * AdapterExecutionResult.
 */

import {
  adapterExecutionTargetIsRemote,
  adapterExecutionTargetRemoteCwd,
  adapterExecutionTargetSessionIdentity,
  adapterExecutionTargetSessionMatches,
  readAdapterExecutionTarget,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import {
  applyPaperclipWorkspaceEnv,
  asBoolean,
  asNumber,
  asString,
  asStringArray,
  buildInvocationEnvForLogs,
  buildPaperclipEnv,
  ensureAbsoluteDirectory,
  isForbiddenConfigEnvKey,
  isPaperclipRuntimeEnvKey,
  parseObject,
  readPaperclipIssueWorkModeFromContext,
  stringifyPaperclipWakePayload,
} from "@paperclipai/adapter-utils/server-utils";
import { buildAdapterEnvConfig } from "@paperclipai/adapter-utils";
import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
} from "@paperclipai/adapter-utils";
import fs from "node:fs/promises";
import path from "node:path";

import { buildAgyArgs, describeAgyArgs } from "./args.js";
import { ADAPTER_TYPE } from "./constants.js";
import { inferModelProvider, DEFAULT_AGY_MODEL } from "./models.js";
import {
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgySessionUnrecoverableError,
  isAgyTransientNetworkError,
  parseAgyJsonl,
  type AgyParsedStream,
} from "./parse.js";
import { buildAgyPrompt } from "./prompt.js";
import { sessionCodec } from "./session.js";
import { describeRunSkillSync, resolveAgySkillRoot, syncSkillsForRun } from "./skills.js";

const DEFAULT_TIMEOUT_SEC = 3600;
const DEFAULT_GRACE_SEC = 15;

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

/**
 * Copy the wake/issue identifiers from the run context into the child env so a
 * shell inside agy can call the Paperclip API for the right issue.
 */
function applyWakeEnv(env: Record<string, string>, context: Record<string, unknown>): void {
  const readTrimmed = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = context[key];
      if (typeof value === "string" && value.trim().length > 0) return value.trim();
    }
    return null;
  };

  const taskId = readTrimmed("taskId", "issueId");
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  const issueWorkMode = readPaperclipIssueWorkModeFromContext(context);
  if (issueWorkMode) env.PAPERCLIP_ISSUE_WORK_MODE = issueWorkMode;

  const wakeReason = readTrimmed("wakeReason");
  if (wakeReason) env.PAPERCLIP_WAKE_REASON = wakeReason;

  const wakeCommentId = readTrimmed("wakeCommentId", "commentId");
  if (wakeCommentId) env.PAPERCLIP_WAKE_COMMENT_ID = wakeCommentId;

  const approvalId = readTrimmed("approvalId");
  if (approvalId) env.PAPERCLIP_APPROVAL_ID = approvalId;

  const approvalStatus = readTrimmed("approvalStatus");
  if (approvalStatus) env.PAPERCLIP_APPROVAL_STATUS = approvalStatus;

  const linkedIssueIds = Array.isArray(context.issueIds)
    ? context.issueIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      )
    : [];
  if (linkedIssueIds.length > 0) env.PAPERCLIP_LINKED_ISSUE_IDS = linkedIssueIds.join(",");

  const wakePayloadJson = stringifyPaperclipWakePayload(context.paperclipWake);
  if (wakePayloadJson) env.PAPERCLIP_WAKE_PAYLOAD_JSON = wakePayloadJson;
}

/**
 * Merge operator-configured env vars into the child env.
 *
 * Two guardrails, matching the first-party adapters: PAPERCLIP_API_KEY may never
 * come from config (the harness-minted run token is the only source of Paperclip
 * API identity), and config may not shadow any PAPERCLIP_* key the runtime has
 * already assigned for this run.
 */
function applyConfiguredEnv(env: Record<string, string>, config: Record<string, unknown>): void {
  const configured = buildAdapterEnvConfig(
    config.envBindings,
    typeof config.env === "string" ? config.env : null,
  );
  // The env field also accepts a plain object form from older agent rows.
  const objectEnv = typeof config.env === "string" ? {} : parseObject(config.env);
  for (const [key, rawValue] of Object.entries({ ...objectEnv, ...configured })) {
    if (isForbiddenConfigEnvKey(key)) continue;
    if (isPaperclipRuntimeEnvKey(key) && key in env) continue;
    if (rawValue === null || rawValue === undefined) continue;
    if (typeof rawValue === "object") continue;
    env[key] = String(rawValue);
  }
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { runId, agent, runtime, config, context, onLog, onMeta, onSpawn } = ctx;

  const executionTarget = readAdapterExecutionTarget({
    executionTarget: ctx.executionTarget,
    legacyRemoteExecution: ctx.executionTransport?.remoteExecution,
  });
  const executionTargetIsRemote = adapterExecutionTargetIsRemote(executionTarget);

  const command = asString(config.command, "agy");
  const model = asString(config.model, DEFAULT_AGY_MODEL).trim();
  const effort = asString(config.effort, "").trim();
  const agyAgent = asString(config.agyAgent, "").trim();
  const sandbox = asBoolean(config.sandbox, false);
  const disableSlashCommands = asBoolean(config.disableSlashCommands, false);
  const extraArgs = asStringArray(config.extraArgs);
  const timeoutSec = asNumber(config.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const graceSec = asNumber(config.graceSec, DEFAULT_GRACE_SEC);

  // ── Workspace resolution ──────────────────────────────────────────────────
  const workspaceContext = parseObject(context.paperclipWorkspace);
  const workspaceCwd = asString(workspaceContext.cwd, "");
  const workspaceSource = asString(workspaceContext.source, "");
  const workspaceId = asString(workspaceContext.workspaceId, "");
  const workspaceRepoUrl = asString(workspaceContext.repoUrl, "");
  const workspaceRepoRef = asString(workspaceContext.repoRef, "");
  const configuredCwd = asString(config.cwd, "");

  // An explicit config cwd wins over the bare agent-home fallback, matching the
  // first-party local adapters.
  const useConfiguredInsteadOfAgentHome =
    workspaceSource === "agent_home" && configuredCwd.length > 0;
  const effectiveWorkspaceCwd = useConfiguredInsteadOfAgentHome ? "" : workspaceCwd;
  const cwd = effectiveWorkspaceCwd || configuredCwd || process.cwd();
  const effectiveExecutionCwd = adapterExecutionTargetRemoteCwd(executionTarget, cwd);
  if (!executionTargetIsRemote) {
    await ensureAbsoluteDirectory(cwd, { createIfMissing: true });
  }

  // ── Skills ────────────────────────────────────────────────────────────────
  // The heartbeat runner does not call syncSkills before a run; it puts the
  // agent's runtime skill entries in config.paperclipRuntimeSkills and expects
  // the adapter to materialize them here. So reconcile the skill root first,
  // then decide whether to pass it to agy.
  //
  // In "agent" scope the skills live outside the workspace, so the run needs a
  // second --add-dir to see them. The directory is only added when it actually
  // exists: agy rejects an --add-dir pointing at nothing, and an agent with no
  // skills at all has no such directory.
  let skillRoot = resolveAgySkillRoot({ config, agentId: agent.id });
  let skillsAddDir: string | null = null;
  if (skillRoot.addDir && !executionTargetIsRemote) {
    try {
      const runSync = await syncSkillsForRun({
        config,
        agentId: agent.id,
        companyId: agent.companyId,
      });
      skillRoot = runSync.root;
      // Report what landed on every run, not only when something went wrong.
      // This receipt is the only operator-visible signal that sync ran at all:
      // the control plane's `usedByAgents[].actualState` is hardcoded null
      // server-side, so a working sync and a sync that never happened are
      // otherwise indistinguishable outside the run log. See
      // `describeRunSkillSync`.
      for (const line of describeRunSkillSync(runSync)) {
        await onLog("stdout", `${line}\n`);
      }
      for (const warning of runSync.warnings) {
        await onLog("stdout", `[paperclip] skill sync: ${warning}\n`);
      }
    } catch (err) {
      // A failed sync must not take the run down — the agent still works, it
      // just may be missing skills, and saying so is more useful than a crash.
      await onLog(
        "stdout",
        `[paperclip] Skill sync failed; the run continues without freshly synced skills: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }
    const skillsHomeExists = await fs
      .stat(skillRoot.skillsHome)
      .then((stats) => stats.isDirectory())
      .catch(() => false);
    if (skillsHomeExists) skillsAddDir = skillRoot.addDir;
  } else if (skillRoot.addDir && executionTargetIsRemote) {
    // The skill root is a path on the Paperclip host; it does not exist inside
    // an SSH/sandbox target, so pointing agy at it there would just fail.
    await onLog(
      "stdout",
      `[paperclip] Skills synced to ${skillRoot.skillsHome} are not delivered to remote execution targets; ` +
        `set skillsScope to "global" and provision ~/.gemini/config/skills in the target instead.\n`,
    );
  }

  // ── Environment ───────────────────────────────────────────────────────────
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  applyWakeEnv(env, context);
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  applyPaperclipWorkspaceEnv(env, {
    workspaceCwd: effectiveWorkspaceCwd,
    workspaceSource,
    workspaceStrategy: asString(workspaceContext.strategy, ""),
    workspaceId,
    workspaceRepoUrl,
    workspaceRepoRef,
    workspaceBranch: asString(workspaceContext.branch, ""),
    workspaceWorktreePath: asString(workspaceContext.worktreePath, ""),
    agentHome: asString(workspaceContext.agentHome, ""),
  });
  applyConfiguredEnv(env, config);

  // ── Session resume decision ───────────────────────────────────────────────
  const runtimeSessionParams =
    sessionCodec.deserialize(runtime.sessionParams ?? runtime.sessionId) ?? {};
  const storedConversationId = asString(runtimeSessionParams.conversationId, "");
  const storedCwd = asString(runtimeSessionParams.cwd, "");
  const storedRemoteExecution = parseObject(runtimeSessionParams.remoteExecution);

  // An agy conversation is bound to the directory it was created in, so a cwd
  // mismatch means the transcript describes files that are not here.
  const cwdMatches =
    storedCwd.length === 0 ||
    path.resolve(storedCwd) === path.resolve(effectiveExecutionCwd);
  const canResume =
    storedConversationId.length > 0 &&
    cwdMatches &&
    adapterExecutionTargetSessionMatches(storedRemoteExecution, executionTarget);
  const conversationId = canResume ? storedConversationId : null;

  if (storedConversationId.length > 0 && !canResume) {
    await onLog(
      "stdout",
      `[paperclip] agy conversation "${storedConversationId}" was saved for cwd "${storedCwd || "(unset)"}" and will not be resumed in "${effectiveExecutionCwd}". Starting a fresh conversation.\n`,
    );
  }

  // ── Prompt ────────────────────────────────────────────────────────────────
  const built = await buildAgyPrompt({
    config,
    context,
    env,
    agent: { id: agent.id, companyId: agent.companyId },
    runId,
    conversationId,
    onLog,
  });

  const commandNotes = [
    ...describeAgyArgs({ cwd: effectiveExecutionCwd, sandbox, timeoutSec, skillsAddDir }),
    ...built.notes,
  ];

  const runAttempt = async (resumeConversationId: string | null) => {
    const args = buildAgyArgs({
      prompt: built.prompt,
      conversationId: resumeConversationId,
      model,
      effort,
      cwd: effectiveExecutionCwd,
      skillsAddDir,
      sandbox,
      disableSlashCommands,
      agyAgent,
      timeoutSec,
      extraArgs,
    });

    if (onMeta) {
      await onMeta({
        adapterType: ADAPTER_TYPE,
        command,
        cwd: effectiveExecutionCwd,
        commandNotes,
        // The prompt is the last argument; replace it so logs never carry the
        // full prompt body twice.
        commandArgs: args.map((value, index) =>
          index === args.length - 1 ? `<prompt ${built.prompt.length} chars>` : value,
        ),
        env: buildInvocationEnvForLogs(env),
        prompt: built.prompt,
        promptMetrics: built.promptMetrics,
        context,
      });
    }

    const proc = await runAdapterExecutionTargetProcess(runId, executionTarget, command, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onSpawn,
      onLog,
      onRuntimeProgress: ctx.onRuntimeProgress,
    });

    return { proc, parsed: parseAgyJsonl(proc.stdout) };
  };

  type Attempt = Awaited<ReturnType<typeof runAttempt>>;

  const toResult = (attempt: Attempt, isRetry: boolean): AdapterExecutionResult => {
    const { proc, parsed } = attempt;
    const requiresAuth = detectAgyAuthRequired({
      stdout: proc.stdout,
      stderr: proc.stderr,
      parsed,
    }).requiresAuth;
    const quotaExhausted = detectAgyQuotaExhausted({
      stdout: proc.stdout,
      stderr: proc.stderr,
      parsed,
    });
    const networkUnavailable = isAgyTransientNetworkError(proc.stdout, proc.stderr);

    const resolvedModel = model && model !== DEFAULT_AGY_MODEL ? model : null;
    const provider = inferModelProvider(resolvedModel ?? "gemini");

    // Resume falls back to the stored conversation id only on a first attempt;
    // after a retry the old id is known-stale.
    const resolvedConversationId =
      parsed.conversationId ?? (isRetry ? null : storedConversationId || null);
    const sessionParams = resolvedConversationId
      ? {
          conversationId: resolvedConversationId,
          cwd: effectiveExecutionCwd,
          ...(workspaceId ? { workspaceId } : {}),
          ...(workspaceRepoUrl ? { repoUrl: workspaceRepoUrl } : {}),
          ...(workspaceRepoRef ? { repoRef: workspaceRepoRef } : {}),
          ...(executionTargetIsRemote
            ? { remoteExecution: adapterExecutionTargetSessionIdentity(executionTarget) }
            : {}),
        }
      : null;

    const classifyErrorCode = (): string | null => {
      if (proc.errorCode) return proc.errorCode;
      if (requiresAuth) return "agy_auth_required";
      if (quotaExhausted) return "agy_quota_exhausted";
      if (networkUnavailable) return "agy_network_unavailable";
      return null;
    };

    const errorFamily = quotaExhausted
      ? ("provider_quota" as const)
      : networkUnavailable
        ? ("transient_upstream" as const)
        : null;

    if (proc.timedOut) {
      return {
        exitCode: proc.exitCode,
        signal: proc.signal,
        timedOut: true,
        errorMessage: `Timed out after ${timeoutSec}s`,
        errorCode: classifyErrorCode(),
        errorFamily,
        usage: parsed.usage,
        usageBasis: "per_run",
        sessionId: resolvedConversationId,
        sessionParams,
        sessionDisplayId: resolvedConversationId,
        provider,
        biller: "google",
        model: resolvedModel,
        billingType: "subscription",
        resultJson: buildResultJson(parsed, proc.stdout, proc.stderr),
      };
    }

    // agy exits non-zero on failure, but also treat a parsed non-SUCCESS status
    // as a failure so a zero-exit error surfaces rather than reading as success.
    const exitFailed = (proc.exitCode ?? 0) !== 0;
    const statusFailed = parsed.status !== null && parsed.status !== "SUCCESS";
    // No result event at all means the stream was truncated — the run did not
    // reach a terminal state, so it must not be reported as success.
    const missingResult = parsed.resultEvent === null;
    const failed = exitFailed || statusFailed || missingResult;

    const errorMessage = failed
      ? parsed.errorMessage ??
        firstNonEmptyLine(proc.stderr) ??
        (missingResult
          ? "agy exited without emitting a result event; the stream-json output was truncated."
          : `agy exited with code ${proc.exitCode ?? -1}`)
      : null;

    return {
      exitCode: proc.exitCode,
      signal: proc.signal,
      timedOut: false,
      errorMessage: errorMessage || null,
      errorCode: failed ? classifyErrorCode() : null,
      errorFamily: failed ? errorFamily : null,
      usage: parsed.usage,
      // agy's result event totals the whole invocation, so these are per-run
      // numbers and must not be deltaed against the previous run.
      usageBasis: "per_run",
      sessionId: resolvedConversationId,
      sessionParams,
      sessionDisplayId: resolvedConversationId,
      provider,
      biller: "google",
      model: resolvedModel,
      billingType: "subscription",
      resultJson: buildResultJson(parsed, proc.stdout, proc.stderr),
      summary: parsed.summary,
      // Drop a conversation id that could not be recovered so the next
      // heartbeat starts clean instead of retrying a dead handle.
      clearSession: failed && resolvedConversationId === null && storedConversationId.length > 0,
    };
  };

  const initial = await runAttempt(conversationId);

  // A resume that failed because the conversation is gone is worth exactly one
  // retry from scratch; anything else is a real failure to report.
  if (
    conversationId &&
    !initial.proc.timedOut &&
    (initial.proc.exitCode ?? 0) !== 0 &&
    isAgySessionUnrecoverableError(initial.proc.stdout, initial.proc.stderr)
  ) {
    await onLog(
      "stdout",
      `[paperclip] agy conversation "${conversationId}" is unavailable; retrying with a fresh conversation.\n`,
    );
    const retry = await runAttempt(null);
    return toResult(retry, true);
  }

  return toResult(initial, false);
}

function buildResultJson(
  parsed: AgyParsedStream,
  stdout: string,
  stderr: string,
): Record<string, unknown> {
  if (parsed.resultEvent) {
    return {
      ...parsed.resultEvent,
      ...(parsed.thinkingTokens !== null ? { thinking_tokens: parsed.thinkingTokens } : {}),
      ...(parsed.tools.length > 0
        ? { tool_invocations: parsed.tools.map((tool) => tool.name) }
        : {}),
      ...(parsed.malformedLines > 0 ? { malformed_stream_lines: parsed.malformedLines } : {}),
    };
  }
  return { stdout, stderr, ...(parsed.malformedLines > 0 ? { malformed_stream_lines: parsed.malformedLines } : {}) };
}
