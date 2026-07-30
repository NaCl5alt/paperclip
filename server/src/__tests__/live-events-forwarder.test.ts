import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import {
  MAX_RUN_LOG_FLUSH_BYTES,
  RUN_LOG_FLUSH_INTERVAL_MS,
  createLiveEventForwarder,
  readPositiveIntEnv,
} from "../realtime/live-events-ws.js";

// Advance past one flush window, whatever the configured/default interval is.
const FLUSH = RUN_LOG_FLUSH_INTERVAL_MS;

let nextId = 0;

function logEvent(
  runId: string,
  chunk: string,
  opts: { stream?: string; truncated?: boolean } = {},
): LiveEvent {
  nextId += 1;
  return {
    id: nextId,
    companyId: "co_1",
    type: "heartbeat.run.log",
    createdAt: new Date(nextId * 1000).toISOString(),
    payload: {
      runId,
      agentId: "ag_1",
      ts: new Date(nextId * 1000).toISOString(),
      stream: opts.stream ?? "stdout",
      chunk,
      truncated: opts.truncated ?? false,
    },
  };
}

function statusEvent(runId: string): LiveEvent {
  nextId += 1;
  return {
    id: nextId,
    companyId: "co_1",
    type: "heartbeat.run.status",
    createdAt: new Date(nextId * 1000).toISOString(),
    payload: { runId, status: "running" },
  };
}

describe("createLiveEventForwarder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nextId = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("forwards non-log events immediately without waiting for a flush", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(statusEvent("run_1"));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.type).toBe("heartbeat.run.status");
  });

  it("coalesces consecutive run.log chunks of the same run+stream into one concatenated message", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "a"));
    forwarder.handle(logEvent("run_1", "b"));
    forwarder.handle(logEvent("run_1", "c"));

    expect(sent).toHaveLength(0); // buffered, not yet flushed

    vi.advanceTimersByTime(FLUSH);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload.chunk).toBe("abc");
    expect(sent[0]?.payload.stream).toBe("stdout");
  });

  it("carries per-chunk segments so the client can reproduce per-line dedupe keys", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    const e1 = logEvent("run_1", "a");
    const e2 = logEvent("run_1", "b");
    forwarder.handle(e1);
    forwarder.handle(e2);

    vi.advanceTimersByTime(FLUSH);

    expect(sent).toHaveLength(1);
    const segments = sent[0]?.payload.segments as Array<{ ts: unknown; chunk: unknown }>;
    expect(segments).toHaveLength(2);
    expect(segments.map((s) => s.chunk)).toEqual(["a", "b"]);
    // segment ts must equal each source event's payload.ts (identical to the persisted per-line ts)
    expect(segments[0]?.ts).toBe(e1.payload.ts);
    expect(segments[1]?.ts).toBe(e2.payload.ts);
    // joined chunk stays consistent with the segment chunks
    expect(sent[0]?.payload.chunk).toBe("ab");
  });

  it("drops the segment of the oldest chunk when it is dropped for the byte budget", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    // Each chunk alone fills the budget, so two chunks force the oldest segment to be dropped.
    const chunkA = `A${"x".repeat(MAX_RUN_LOG_FLUSH_BYTES)}`;
    const chunkB = `B${"x".repeat(MAX_RUN_LOG_FLUSH_BYTES)}`;
    forwarder.handle(logEvent("run_1", chunkA));
    forwarder.handle(logEvent("run_1", chunkB));

    vi.advanceTimersByTime(FLUSH);

    const segments = sent[0]?.payload.segments as Array<{ chunk: string }>;
    expect(segments).toHaveLength(1);
    expect(segments[0]?.chunk.startsWith("B")).toBe(true);
  });

  it("keeps distinct streams as separate coalesced messages", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "out1", { stream: "stdout" }));
    forwarder.handle(logEvent("run_1", "err1", { stream: "stderr" }));
    forwarder.handle(logEvent("run_1", "out2", { stream: "stdout" }));

    vi.advanceTimersByTime(FLUSH);

    const byStream = Object.fromEntries(
      sent.map((e) => [e.payload.stream, e.payload.chunk]),
    );
    expect(byStream.stdout).toBe("out1out2");
    expect(byStream.stderr).toBe("err1");
  });

  it("drops oldest whole chunks past the byte budget and marks truncated", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    // Each chunk alone fills the budget, so two chunks force the oldest to be dropped.
    const chunkA = `A${"x".repeat(MAX_RUN_LOG_FLUSH_BYTES)}`;
    const chunkB = `B${"x".repeat(MAX_RUN_LOG_FLUSH_BYTES)}`;
    forwarder.handle(logEvent("run_1", chunkA));
    forwarder.handle(logEvent("run_1", chunkB));

    vi.advanceTimersByTime(FLUSH);

    expect(sent).toHaveLength(1);
    const chunk = String(sent[0]?.payload.chunk);
    // oldest chunk dropped, newest retained
    expect(chunk.startsWith("B")).toBe(true);
    expect(chunk.includes("A")).toBe(false);
    expect(sent[0]?.payload.truncated).toBe(true);
  });

  it("propagates the source truncated flag even when within budget", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "small", { truncated: true }));
    vi.advanceTimersByTime(FLUSH);

    expect(sent[0]?.payload.truncated).toBe(true);
  });

  it("cancels the pending flush on dispose so no message is sent after close", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "a"));
    forwarder.dispose();
    vi.advanceTimersByTime(FLUSH + 1000);

    expect(sent).toHaveLength(0);
  });
});

describe("readPositiveIntEnv", () => {
  const NAME = "PAPERCLIP_TEST_RUN_LOG_ENV";
  afterEach(() => {
    delete process.env[NAME];
  });

  it("returns the fallback when the env var is unset or blank", () => {
    delete process.env[NAME];
    expect(readPositiveIntEnv(NAME, 400, 50)).toBe(400);
    process.env[NAME] = "   ";
    expect(readPositiveIntEnv(NAME, 400, 50)).toBe(400);
  });

  it("returns the parsed value when it is a valid integer at or above the minimum", () => {
    process.env[NAME] = "800";
    expect(readPositiveIntEnv(NAME, 400, 50)).toBe(800);
    process.env[NAME] = "50";
    expect(readPositiveIntEnv(NAME, 400, 50)).toBe(50);
  });

  it("falls back on NaN, non-integer, negative, or below-minimum values", () => {
    for (const bad of ["abc", "400.5", "-5", "10", "0", "1e-3"]) {
      process.env[NAME] = bad;
      expect(readPositiveIntEnv(NAME, 400, 50)).toBe(400);
    }
  });
});
