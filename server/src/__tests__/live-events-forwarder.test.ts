import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveEvent } from "@paperclipai/shared";
import { createLiveEventForwarder } from "../realtime/live-events-ws.js";

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

    vi.advanceTimersByTime(150);

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

    vi.advanceTimersByTime(150);

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

    const big = "x".repeat(40 * 1024); // 40KiB each; budget is 64KiB
    forwarder.handle(logEvent("run_1", `${big}A`));
    forwarder.handle(logEvent("run_1", `${big}B`));

    vi.advanceTimersByTime(150);

    const segments = sent[0]?.payload.segments as Array<{ chunk: string }>;
    expect(segments).toHaveLength(1);
    expect(segments[0]?.chunk.endsWith("B")).toBe(true);
  });

  it("keeps distinct streams as separate coalesced messages", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "out1", { stream: "stdout" }));
    forwarder.handle(logEvent("run_1", "err1", { stream: "stderr" }));
    forwarder.handle(logEvent("run_1", "out2", { stream: "stdout" }));

    vi.advanceTimersByTime(150);

    const byStream = Object.fromEntries(
      sent.map((e) => [e.payload.stream, e.payload.chunk]),
    );
    expect(byStream.stdout).toBe("out1out2");
    expect(byStream.stderr).toBe("err1");
  });

  it("drops oldest whole chunks past the byte budget and marks truncated", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    const big = "x".repeat(40 * 1024); // 40KiB each; budget is 64KiB
    forwarder.handle(logEvent("run_1", `${big}A`));
    forwarder.handle(logEvent("run_1", `${big}B`));

    vi.advanceTimersByTime(150);

    expect(sent).toHaveLength(1);
    const chunk = String(sent[0]?.payload.chunk);
    // oldest chunk dropped, newest retained
    expect(chunk.endsWith("B")).toBe(true);
    expect(chunk.includes("A")).toBe(false);
    expect(sent[0]?.payload.truncated).toBe(true);
  });

  it("propagates the source truncated flag even when within budget", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "small", { truncated: true }));
    vi.advanceTimersByTime(150);

    expect(sent[0]?.payload.truncated).toBe(true);
  });

  it("cancels the pending flush on dispose so no message is sent after close", () => {
    const sent: LiveEvent[] = [];
    const forwarder = createLiveEventForwarder((data) => sent.push(JSON.parse(data)));

    forwarder.handle(logEvent("run_1", "a"));
    forwarder.dispose();
    vi.advanceTimersByTime(1000);

    expect(sent).toHaveLength(0);
  });
});
