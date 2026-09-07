import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

// VANA-2891: regression coverage for the "complete success, non-zero exit"
// classification. The Claude CLI can emit a full success result envelope
// (is_error:false, subtype:"success") and still exit non-zero — most often
// because our own terminal-result cleanup SIGTERMs the child once the result
// JSON lands on stdout (exit 143), or the CLI exits 1 during post-result
// teardown. Such a run must be recorded as succeeded, NOT as
// claude_transient_upstream.

const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesManagedHome: () => false,
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: vi.fn(async () => {}),
  ensureAdapterExecutionTargetRuntimeCommandInstalled: vi.fn(async () => {}),
  prepareAdapterExecutionTargetRuntime: vi.fn(async () => ({
    workspaceRemoteDir: null,
    restoreWorkspace: async () => {},
  })),
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) =>
    executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  resolveAdapterExecutionTargetCommandForLogs: vi.fn(async () => "claude"),
  runAdapterExecutionTargetProcess: runProcessMock,
  runAdapterExecutionTargetShellCommand: vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "",
  })),
  startAdapterExecutionTargetPaperclipBridge: vi.fn(async () => ({ env: {}, stop: async () => {} })),
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-claude-classify-"));
  tempRoots.push(root);
  return root;
}

function successStreamJson(overrides?: { subtype?: string; isError?: boolean }): string {
  const subtype = overrides?.subtype ?? "success";
  const isError = overrides?.isError ?? false;
  return [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "claude-session-vana2891",
      model: "claude-sonnet",
    }),
    JSON.stringify({
      type: "assistant",
      session_id: "claude-session-vana2891",
      message: { content: [{ type: "text", text: "GitHub Actions の Packer ビルドが完了したら通知が来ます。" }] },
    }),
    JSON.stringify({
      type: "result",
      subtype,
      is_error: isError,
      stop_reason: "end_turn",
      num_turns: 4,
      session_id: "claude-session-vana2891",
      result: "GitHub Actions の Packer ビルドが完了したら通知が来ます。",
      usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
    }),
  ].join("\n");
}

async function buildContext(root: string): Promise<AdapterExecutionContext> {
  const instructionsPath = path.join(root, "instructions.md");
  await fs.writeFile(instructionsPath, "You are a test agent.\n", "utf8");
  return {
    runId: "run-vana2891",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Claude Agent",
      adapterType: "claude_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "claude",
      cwd: root,
      instructionsFilePath: instructionsPath,
    },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
  };
}

describe("claude_local execute classification (VANA-2891)", () => {
  beforeEach(() => {
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("records a complete success result as succeeded when the process is SIGTERM'd (exit 143) during teardown", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: false,
      stdout: successStreamJson(),
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    // Not a failure: no transient_upstream classification, no error surface.
    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
    expect(result.errorMessage).toBeNull();
    // Normalized so the heartbeat outcome derivation (exitCode 0 && no
    // errorMessage) records the run as succeeded.
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.summary).toContain("Packer");
    expect(result.sessionId).toBe("claude-session-vana2891");
    // Real process exit/signal preserved for forensics.
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.processExitCode).toBe(143);
    expect(resultJson.processSignal).toBe("SIGTERM");
    expect(resultJson.exitCodeNormalizedReason).toBe("complete_success_nonzero_exit");
    expect(resultJson.errorFamily).toBeUndefined();
  });

  it("records a complete success result as succeeded when the process exits 1 after emitting the result", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: successStreamJson(),
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    expect(result.errorCode).toBeNull();
    expect(result.errorFamily).toBeNull();
    expect(result.errorMessage).toBeNull();
    expect(result.exitCode).toBe(0);
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.processExitCode).toBe(1);
    expect(resultJson.exitCodeNormalizedReason).toBe("complete_success_nonzero_exit");
  });

  it("still fails a non-zero exit that lacks a complete success envelope (no over-broad success)", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      // is_error:true, subtype:"error_during_execution" — a genuine failure.
      stdout: successStreamJson({ subtype: "error_during_execution", isError: true }),
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    expect(result.exitCode).toBe(1);
    expect(result.errorMessage).not.toBeNull();
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.exitCodeNormalizedReason).toBeUndefined();
  });

  it("does NOT mask an incomplete-tool-call run as success even when SIGTERM'd (exit 143) — VANA-644/647 guard", async () => {
    const root = await makeTempRoot();
    // subtype:"success" + is_error:false, but the final result text is tool-call
    // markup emitted as plain text (the tool never ran). The teardown SIGTERM
    // (exit 143) must not let this slip through completeSuccessDespiteExit.
    const toolMarkup =
      'I will run the command now.\n<function_calls>\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>';
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-vana2891",
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-vana2891",
        message: { content: [{ type: "text", text: toolMarkup }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        num_turns: 2,
        session_id: "claude-session-vana2891",
        result: toolMarkup,
        usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
      }),
    ].join("\n");
    runProcessMock.mockResolvedValue({
      exitCode: 143,
      signal: "SIGTERM",
      timedOut: false,
      stdout,
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    // Must be surfaced as a failure, not normalized to succeeded.
    expect(result.exitCode).not.toBe(0);
    expect(result.errorMessage).not.toBeNull();
    const resultJson = result.resultJson as Record<string, unknown>;
    expect(resultJson.exitCodeNormalizedReason).toBeUndefined();
  });

  it("records a clean zero-exit success unchanged", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: successStreamJson(),
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeNull();
    expect(result.errorMessage).toBeNull();
    const resultJson = result.resultJson as Record<string, unknown>;
    // No normalization marker when the exit was already clean.
    expect(resultJson.exitCodeNormalizedReason).toBeUndefined();
  });

  it("classifies OAuth session-expired wording in parsed.result as claude_auth_required (VANA-3914)", async () => {
    const root = await makeTempRoot();
    const oauthMessage =
      "Failed to authenticate: OAuth session expired and could not be refreshed";
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-vana3914",
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "result",
        subtype: "error",
        is_error: true,
        session_id: "claude-session-vana3914",
        result: oauthMessage,
        usage: { input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
      }),
    ].join("\n");
    runProcessMock.mockResolvedValue({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    expect(result.errorCode).toBe("claude_auth_required");
    expect(result.exitCode).not.toBe(0);
    expect(result.errorMessage).toContain("OAuth session expired");
  });

  it("does NOT classify OAuth session-expired wording that appears only in stdout (VANA-3914 / VANA-3255)", async () => {
    const root = await makeTempRoot();
    // Prompt-echo trap: the incident wording lives only in raw stdout (as if
    // the agent prompt quoted VANA-3914). parsed.result is a normal success, so
    // the narrow OAuth haystack must not fire.
    const echoed =
      "Failed to authenticate: OAuth session expired and could not be refreshed";
    const stdout = [
      JSON.stringify({
        type: "system",
        subtype: "init",
        session_id: "claude-session-vana3914",
        model: "claude-sonnet",
      }),
      JSON.stringify({
        type: "assistant",
        session_id: "claude-session-vana3914",
        message: { content: [{ type: "text", text: echoed }] },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        num_turns: 1,
        session_id: "claude-session-vana3914",
        result: "All good — credentials are fine.",
        usage: { input_tokens: 10, cache_read_input_tokens: 0, output_tokens: 5 },
      }),
    ].join("\n");
    runProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout,
      stderr: "",
    });

    const result = await execute(await buildContext(root));

    expect(result.errorCode).not.toBe("claude_auth_required");
    expect(result.exitCode).toBe(0);
    expect(result.errorMessage).toBeNull();
  });

});
