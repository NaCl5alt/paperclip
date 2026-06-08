import { describe, expect, it } from "vitest";
import {
  HANDOFF_DOCUMENT_KEY,
  buildHandoffDocument,
  parseClaudeSessionTranscript,
  renderHandoffMarkdown,
} from "./handoff-bridge.js";

function sessionLine(role: string, content: unknown, type = role): string {
  return JSON.stringify({ type, message: { role, content } });
}

describe("parseClaudeSessionTranscript", () => {
  it("parses user/assistant text and summarizes tool blocks", () => {
    const jsonl = [
      sessionLine("user", "fix the bug"),
      sessionLine("assistant", [
        { type: "text", text: "looking" },
        { type: "tool_use", name: "Bash", input: { command: "ls" } },
        { type: "thinking", thinking: "secret reasoning" },
      ]),
      sessionLine("user", [{ type: "tool_result", content: "file.ts" }]),
    ].join("\n");
    const turns = parseClaudeSessionTranscript(jsonl);
    expect(turns).toHaveLength(3);
    expect(turns[0]).toEqual({ role: "user", text: "fix the bug" });
    expect(turns[1].role).toBe("assistant");
    expect(turns[1].text).toContain("looking");
    expect(turns[1].text).toContain("tool_use(Bash)");
    expect(turns[1].text).not.toContain("secret reasoning");
    expect(turns[2].text).toContain("tool_result");
  });

  it("ignores malformed lines and blank lines", () => {
    const jsonl = ["not json", "", sessionLine("user", "hello"), "{bad"].join("\n");
    expect(parseClaudeSessionTranscript(jsonl)).toEqual([{ role: "user", text: "hello" }]);
  });

  it("captures prior summary entries", () => {
    const jsonl = JSON.stringify({ type: "summary", summary: "did setup" });
    const turns = parseClaudeSessionTranscript(jsonl);
    expect(turns[0]).toEqual({ role: "system", text: "(prior summary) did setup" });
  });
});

const identity = (s: string) => s;

describe("renderHandoffMarkdown", () => {
  it("keeps recent turns full and summarizes older turns", () => {
    const turns = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      text: `turn ${i}`,
    }));
    const body = renderHandoffMarkdown({ turns, header: "# H", redact: identity, recentTurns: 3 });
    expect(body).toContain("7 earlier turn(s) omitted");
    expect(body).toContain("turn 9");
    expect(body).toContain("turn 7");
    expect(body).not.toContain("turn 6");
  });

  it("enforces the byte budget by dropping oldest full turns", () => {
    const big = "x".repeat(50_000);
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `${i} ${big}` }));
    const body = renderHandoffMarkdown({ turns, header: "# H", redact: identity, recentTurns: 20, maxBytes: 120_000 });
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(120_000);
    // Most recent turn must survive.
    expect(body).toContain("19 ");
  });

  it("applies the injected redactor to the assembled body", () => {
    const turns = [{ role: "user" as const, text: "token=abc123" }];
    const body = renderHandoffMarkdown({
      turns,
      header: "# H",
      redact: (s) => s.replace("abc123", "***"),
    });
    expect(body).toContain("token=***");
    expect(body).not.toContain("abc123");
  });
});

describe("buildHandoffDocument", () => {
  const base = {
    strandedAgentName: "claude-coder",
    strandedAdapterType: "claude_local",
    fallbackAdapterType: "codex_local",
    sourceIssueLink: "[source-issue](/issues/source-issue)",
    runLink: "[run](/VANA/agents/a/runs/r)",
    redact: (s: string) => s,
  };

  it("captures transcript when resolvable", async () => {
    const result = await buildHandoffDocument({
      ...base,
      sessionId: "sess-1",
      readTranscript: async () => sessionLine("user", "do the thing"),
    });
    expect(result.captured).toBe(true);
    expect(result.note).toBe("handoff_captured");
    expect(result.body).toContain("Context handoff");
    expect(result.body).toContain("do the thing");
  });

  it("degrades gracefully when transcript is not resolvable locally (remote target)", async () => {
    const result = await buildHandoffDocument({
      ...base,
      sessionId: "sess-remote",
      readTranscript: async () => null,
    });
    expect(result.captured).toBe(false);
    expect(result.note).toBe("handoff_transcript_unavailable");
    expect(result.body).toContain("remote target");
  });

  it("degrades when no session id was recorded", async () => {
    const result = await buildHandoffDocument({ ...base, sessionId: null });
    expect(result.captured).toBe(false);
    expect(result.note).toBe("handoff_no_session_id");
  });

  it("uses the documented handoff key", () => {
    expect(HANDOFF_DOCUMENT_KEY).toBe("handoff");
  });
});
