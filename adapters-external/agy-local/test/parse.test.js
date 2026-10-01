import assert from "node:assert/strict";
import test from "node:test";

import {
  detectAgyAuthRequired,
  detectAgyQuotaExhausted,
  isAgySessionUnrecoverableError,
  isAgySuccessResult,
  isAgyTransientNetworkError,
  parseAgyJsonl,
} from "../dist/parse.js";
import { parseAgyModelsOutput } from "../dist/models.js";
import { buildAgyArgs, modelHasEffortSuffix, resolveAgyPrintTimeoutSec } from "../dist/args.js";
import { sessionCodec } from "../dist/session.js";
import { MODELS_OUTPUT, SIMPLE_RUN, TOOL_RUN, TRUNCATED_RUN } from "./fixtures.js";

test("parses a simple run: conversation id, status, response, usage", () => {
  const parsed = parseAgyJsonl(SIMPLE_RUN);
  assert.equal(parsed.conversationId, "1d4068bc-62e4-47ec-ad8b-6e83372b5f32");
  assert.equal(parsed.status, "SUCCESS");
  assert.equal(parsed.response, "HELLO_AGY\n");
  assert.equal(parsed.summary, "HELLO_AGY");
  assert.equal(parsed.numTurns, 1);
  assert.deepEqual(parsed.usage, {
    inputTokens: 5286,
    outputTokens: 90,
    cachedInputTokens: 8128,
  });
  assert.equal(parsed.thinkingTokens, 86);
  assert.equal(parsed.errorMessage, null);
  assert.equal(parsed.malformedLines, 0);
  assert.ok(isAgySuccessResult(parsed));
});

test("concatenates assistant text deltas in order", () => {
  const parsed = parseAgyJsonl(TOOL_RUN);
  assert.equal(parsed.assistantText, "I have created probe.txt and read it back.");
});

test("pairs ACTIVE and DONE tool events into one invocation per step", () => {
  const parsed = parseAgyJsonl(TOOL_RUN);
  assert.equal(parsed.tools.length, 2);

  const [write, view] = parsed.tools;
  assert.equal(write.name, "write_to_file");
  assert.equal(write.stepIndex, 2);
  assert.equal(write.completed, true);
  assert.deepEqual(write.parameters, { TargetFile: "/tmp/agyprobe/probe.txt" });
  assert.equal(write.durationSeconds, 0.01667);

  assert.equal(view.name, "view_file");
  assert.equal(view.output, "2 lines, 7 bytes");
  assert.equal(view.completed, true);
  assert.equal(view.isError, false);
});

test("uses the result event's run total for usage, not the last step", () => {
  const parsed = parseAgyJsonl(TOOL_RUN);
  // Last step reported 6613 input tokens; the result event totals 18259.
  assert.equal(parsed.usage.inputTokens, 18259);
  assert.equal(parsed.usage.outputTokens, 1111);
  assert.equal(parsed.usage.cachedInputTokens, 24379);
});

test("records the init event's advertised tools and permission mode", () => {
  const parsed = parseAgyJsonl(SIMPLE_RUN);
  assert.deepEqual(parsed.availableTools, ["view_file", "write_to_file", "run_command"]);
  assert.equal(parsed.permissionMode, "always-proceed");
});

test("a truncated stream yields no result event but keeps partial usage", () => {
  const parsed = parseAgyJsonl(TRUNCATED_RUN);
  assert.equal(parsed.resultEvent, null);
  assert.equal(parsed.status, null);
  assert.equal(parsed.conversationId, "abc-123");
  // Falls back to the last step usage so a crashed run still bills its tokens.
  assert.equal(parsed.usage.inputTokens, 10);
  assert.ok(!isAgySuccessResult(parsed));
});

test("a non-SUCCESS status produces an error message", () => {
  const parsed = parseAgyJsonl(
    '{"event":"result","result":{"conversation_id":"x","status":"ERROR","error":"model refused"}}',
  );
  assert.equal(parsed.status, "ERROR");
  assert.equal(parsed.errorMessage, "model refused");
});

test("a non-SUCCESS status with no error field still explains itself", () => {
  const parsed = parseAgyJsonl('{"event":"result","result":{"status":"CANCELLED"}}');
  assert.equal(parsed.errorMessage, "agy finished with status CANCELLED");
});

test("counts malformed JSON lines instead of throwing", () => {
  const parsed = parseAgyJsonl(['{"event":"init","conversation_id":"a"}', "{not json", ""].join("\n"));
  assert.equal(parsed.conversationId, "a");
  assert.equal(parsed.malformedLines, 1);
});

test("ignores non-JSON banner lines without counting them as malformed", () => {
  const parsed = parseAgyJsonl(["Fetching...", SIMPLE_RUN].join("\n"));
  assert.equal(parsed.malformedLines, 0);
  assert.equal(parsed.status, "SUCCESS");
});

test("classifies auth, quota, network and dead-session failures", () => {
  assert.ok(detectAgyAuthRequired({ stderr: "Error: not logged in" }).requiresAuth);
  assert.ok(detectAgyAuthRequired({ stderr: "authentication required" }).requiresAuth);
  assert.ok(!detectAgyAuthRequired({ stderr: "some other failure" }).requiresAuth);

  assert.ok(detectAgyQuotaExhausted({ stderr: "RESOURCE_EXHAUSTED" }));
  assert.ok(detectAgyQuotaExhausted({ stderr: "429 too many requests" }));
  assert.ok(!detectAgyQuotaExhausted({ stderr: "file not found" }));

  assert.ok(isAgyTransientNetworkError("", "read ECONNRESET"));
  assert.ok(isAgyTransientNetworkError("", "503 Service Unavailable"));
  assert.ok(!isAgyTransientNetworkError("", "syntax error"));

  assert.ok(isAgySessionUnrecoverableError("", "conversation abc-123 not found"));
  assert.ok(isAgySessionUnrecoverableError("", "invalid conversation"));
  assert.ok(!isAgySessionUnrecoverableError("", "tool call failed"));
});

test("parses the models table and skips the banner", () => {
  const parsed = parseAgyModelsOutput(MODELS_OUTPUT);
  assert.equal(parsed.length, 4);
  assert.deepEqual(parsed[0], {
    id: "gemini-3.8-flash-high",
    label: "Gemini 3.8 Flash (High)",
  });
  assert.ok(parsed.every((model) => !model.id.includes(" ")));
});

test("always binds the workspace with --add-dir and puts the prompt last", () => {
  const args = buildAgyArgs({
    prompt: "do the thing",
    conversationId: null,
    model: "auto",
    effort: "",
    cwd: "/work/repo",
    sandbox: false,
    disableSlashCommands: false,
    agyAgent: "",
    timeoutSec: 3600,
    extraArgs: [],
  });

  const addDirIndex = args.indexOf("--add-dir");
  assert.notEqual(addDirIndex, -1, "--add-dir must always be passed");
  assert.equal(args[addDirIndex + 1], "/work/repo");

  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.deepEqual(args.slice(0, 2), ["--output-format", "stream-json"]);
  // The prompt must be the final argument so log redaction can target it.
  assert.equal(args[args.length - 2], "--print");
  assert.equal(args[args.length - 1], "do the thing");
  // "auto" is a sentinel, not a real model id.
  assert.ok(!args.includes("--model"));
  assert.ok(!args.includes("--conversation"));
});

test("passes resume, model, effort and agent when configured for an effort-free model", () => {
  const args = buildAgyArgs({
    prompt: "p",
    conversationId: "conv-1",
    model: "claude-sonnet-4-6",
    effort: "high",
    cwd: "/w",
    sandbox: true,
    disableSlashCommands: true,
    agyAgent: "reviewer",
    timeoutSec: 600,
    extraArgs: ["--foo", "bar"],
  });
  assert.equal(args[args.indexOf("--conversation") + 1], "conv-1");
  assert.equal(args[args.indexOf("--model") + 1], "claude-sonnet-4-6");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--agent") + 1], "reviewer");
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(args.includes("--foo") && args.includes("bar"));
});

test("rejects an out-of-range effort value rather than passing it through", () => {
  const args = buildAgyArgs({
    prompt: "p",
    conversationId: null,
    model: "auto",
    effort: "extreme",
    cwd: "/w",
    sandbox: false,
    disableSlashCommands: false,
    agyAgent: "",
    timeoutSec: 600,
    extraArgs: [],
  });
  assert.ok(!args.includes("--effort"));
});

test("suppresses --effort when the model id already encodes a tier", () => {
  const args = buildAgyArgs({
    prompt: "p",
    conversationId: null,
    model: "gemini-3.6-flash-high",
    effort: "medium",
    cwd: "/w",
    sandbox: false,
    disableSlashCommands: false,
    agyAgent: "",
    timeoutSec: 600,
    extraArgs: [],
  });
  assert.equal(args[args.indexOf("--model") + 1], "gemini-3.6-flash-high");
  assert.ok(!args.includes("--effort"), "--effort must be dropped for an effort-suffixed model");
});

test("suppresses --effort even when the requested tier matches the model's suffix", () => {
  const args = buildAgyArgs({
    prompt: "p",
    conversationId: null,
    model: "gpt-oss-120b-medium",
    effort: "medium",
    cwd: "/w",
    sandbox: false,
    disableSlashCommands: false,
    agyAgent: "",
    timeoutSec: 600,
    extraArgs: [],
  });
  assert.ok(!args.includes("--effort"));
});

test("modelHasEffortSuffix detects effort-suffixed model ids", () => {
  assert.ok(modelHasEffortSuffix("gemini-3.6-flash-high"));
  assert.ok(modelHasEffortSuffix("gemini-3.6-flash-medium"));
  assert.ok(modelHasEffortSuffix("gpt-oss-120b-medium"));
  assert.ok(!modelHasEffortSuffix("auto"));
  assert.ok(!modelHasEffortSuffix("claude-sonnet-4-6"));
  assert.ok(!modelHasEffortSuffix("claude-opus-4-6-thinking"));
});

test("agy's print timeout stays under the Paperclip run timeout", () => {
  assert.ok(resolveAgyPrintTimeoutSec(3600) < 3600);
  assert.equal(resolveAgyPrintTimeoutSec(3600), 3420);
  assert.equal(resolveAgyPrintTimeoutSec(120), 110);
  // Never below a usable floor, and disabled when the timeout is unbounded.
  assert.equal(resolveAgyPrintTimeoutSec(10), 30);
  assert.equal(resolveAgyPrintTimeoutSec(0), 0);
});

test("session codec round-trips conversation identity", () => {
  const params = sessionCodec.serialize({
    conversationId: "conv-9",
    cwd: "/work/repo",
    workspaceId: "ws-1",
    ignored: "dropped",
  });
  assert.deepEqual(params, {
    conversationId: "conv-9",
    cwd: "/work/repo",
    workspaceId: "ws-1",
  });
  assert.deepEqual(sessionCodec.deserialize(params), params);
  assert.equal(sessionCodec.getDisplayId(params), "conv-9");
});

test("session codec accepts the legacy bare-string and sessionId shapes", () => {
  assert.deepEqual(sessionCodec.deserialize("conv-legacy"), {
    conversationId: "conv-legacy",
  });
  assert.deepEqual(sessionCodec.deserialize({ sessionId: "conv-old", cwd: "/w" }), {
    conversationId: "conv-old",
    cwd: "/w",
  });
});

test("session codec rejects empty or malformed session state", () => {
  assert.equal(sessionCodec.deserialize(null), null);
  assert.equal(sessionCodec.deserialize(""), null);
  assert.equal(sessionCodec.deserialize({}), null);
  assert.equal(sessionCodec.serialize(null), null);
  assert.equal(sessionCodec.getDisplayId(null), null);
});
