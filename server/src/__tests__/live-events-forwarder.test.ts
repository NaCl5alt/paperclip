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
      ts: nextId * 1000,
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
