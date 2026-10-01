import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { SIMPLE_RUN, TOOL_RUN } from "./fixtures.js";

const require = createRequire(import.meta.url);
const { parseStdoutLine } = require("../ui-parser.cjs");

const TS = "2026-01-01T00:00:00.000Z";

function parseAll(stream) {
  return stream
    .split("\n")
    .flatMap((line) => parseStdoutLine(line, TS));
}

test("emits an init entry carrying the conversation id", () => {
  const entries = parseAll(SIMPLE_RUN);
  const init = entries.find((entry) => entry.kind === "init");
  assert.ok(init);
  assert.equal(init.sessionId, "1d4068bc-62e4-47ec-ad8b-6e83372b5f32");
  assert.equal(typeof init.model, "string");
});

test("marks assistant text as deltas so the UI concatenates them", () => {
  const assistant = parseAll(TOOL_RUN).filter((entry) => entry.kind === "assistant");
  assert.equal(assistant.length, 2);
  assert.ok(assistant.every((entry) => entry.delta === true));
  assert.equal(assistant.map((entry) => entry.text).join(""), "I have created probe.txt and read it back.");
});

test("pairs tool_call and tool_result on a shared toolUseId", () => {
  const entries = parseAll(TOOL_RUN);
  const calls = entries.filter((entry) => entry.kind === "tool_call");
  const results = entries.filter((entry) => entry.kind === "tool_result");
  assert.equal(calls.length, 2);
  assert.equal(results.length, 2);
  for (const call of calls) {
    assert.ok(
      results.some((result) => result.toolUseId === call.toolUseId),
      `no tool_result matched toolUseId ${call.toolUseId}`,
    );
  }
  assert.equal(calls[0].name, "write_to_file");
  assert.deepEqual(calls[0].input, { TargetFile: "/tmp/agyprobe/probe.txt" });
  assert.equal(results[1].content, "2 lines, 7 bytes");
  assert.equal(results[1].isError, false);
});

test("falls back to a parameter summary when a tool reports no output", () => {
  const result = parseStdoutLine(
    '{"event":"step_update","step_update":{"conversation_id":"c","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_to_file","tool_info":{"name":"write_to_file","parameters":{"TargetFile":"/tmp/x.txt"}}}}',
    TS,
  );
  assert.equal(result[0].kind, "tool_result");
  assert.equal(result[0].content, "write_to_file /tmp/x.txt");
});

test("flags a failed tool call as an error result", () => {
  const result = parseStdoutLine(
    '{"event":"step_update","step_update":{"conversation_id":"c","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","error":"exit 1"}}}',
    TS,
  );
  assert.equal(result[0].isError, true);
});

test("emits a result entry with token counts", () => {
  const entries = parseAll(SIMPLE_RUN);
  const result = entries.find((entry) => entry.kind === "result");
  assert.ok(result);
  assert.equal(result.inputTokens, 5286);
  assert.equal(result.outputTokens, 90);
  assert.equal(result.cachedTokens, 8128);
  assert.equal(result.isError, false);
  assert.equal(result.subtype, "success");
});

test("marks a non-SUCCESS result as an error and carries the message", () => {
  const entries = parseStdoutLine(
    '{"event":"result","result":{"status":"ERROR","error":"boom","usage":{}}}',
    TS,
  );
  assert.equal(entries[0].isError, true);
  assert.deepEqual(entries[0].errors, ["boom"]);
});

test("surfaces non-JSON output instead of dropping it", () => {
  assert.deepEqual(parseStdoutLine("some banner text", TS), [
    { kind: "stdout", ts: TS, text: "some banner text" },
  ]);
  assert.equal(parseStdoutLine("Error: agy exploded", TS)[0].kind, "stderr");
  assert.equal(parseStdoutLine("{not json", TS)[0].kind, "stdout");
  assert.deepEqual(parseStdoutLine("   ", TS), []);
});

test("surfaces an unknown event type rather than silently dropping it", () => {
  const entries = parseStdoutLine('{"event":"future_event","payload":{}}', TS);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, "stdout");
});

test("is self-contained: evaluates with no require, module scope only", () => {
  // The host evaluates this file's source inside a locked-down worker with no
  // module loader, so it must not reference require, import, or any Node global.
  const source = fs.readFileSync(
    path.join(import.meta.dirname, "..", "ui-parser.cjs"),
    "utf8",
  );
  assert.ok(!/\brequire\s*\(/.test(source), "ui-parser must not call require()");
  assert.ok(!/\bimport\s*[({]/.test(source), "ui-parser must not use import");

  const exports = {};
  const module = { exports };
  const context = vm.createContext({ exports, module });
  vm.runInContext(`"use strict";\n{\n${source}\n}`, context);
  const resolved = Object.keys(module.exports).length > 0 ? module.exports : exports;
  assert.equal(typeof resolved.parseStdoutLine, "function");
  assert.equal(resolved.parseStdoutLine('{"event":"init","conversation_id":"z"}', TS)[0].sessionId, "z");
});
