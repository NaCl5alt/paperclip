import { describe, expect, it } from "vitest";
import {
  detectIncompleteToolCall,
  extractClaudeRetryNotBefore,
  isClaudeTransientUpstreamError,
  parseClaudeStreamJson,
} from "./parse.js";

// The model is supposed to emit tool calls as structured tool_use blocks. The
// signature tags below are split so the fixtures read like the malformed output
// without the file itself looking like a tool invocation.
const INVOKE_OPEN = `<${"invoke"} name="Bash">`;
const PARAM_OPEN = `<${"parameter"} name="command">`;
const PARAM_CLOSE = "</parameter>";
const INVOKE_CLOSE = "</invoke>";
const FUNCTION_CALLS_OPEN = `<${"function_calls"}>`;
const FUNCTION_CALLS_CLOSE = "</function_calls>";

function streamLines(events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
  });

  it("classifies Anthropic API rate_limit_error and overloaded_error as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "rate_limit_error", message: "Rate limit reached for requests." }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          errors: [{ type: "overloaded_error", message: "Overloaded" }],
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "HTTP 429: Too Many Requests",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Bedrock ThrottlingException: slow down",
      }),
    ).toBe(true);
  });

  it("classifies the subscription 5-hour / weekly limit wording", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "5-hour limit reached.",
      }),
    ).toBe(true);
  });

  it("does not classify login/auth failures as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        stderr: "Please log in. Run `claude login` first.",
      }),
    ).toBe(false);
  });

  it("does not classify max-turns or unknown-session as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { subtype: "error_max_turns", result: "Maximum turns reached." },
      }),
    ).toBe(false);
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          result: "No conversation found with session id abc-123",
          errors: [{ message: "No conversation found with session id abc-123" }],
        },
      }),
    ).toBe(false);
  });

  it("does not classify deterministic validation errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "Invalid request_error: Unknown parameter 'foo'.",
      }),
    ).toBe(false);
  });
});

const ANTML_INVOKE_OPEN = `<${"antml:invoke"} name="Bash">`;
const ANTML_PARAM_OPEN = `<${"antml:parameter"} name="command">`;

describe("detectIncompleteToolCall", () => {
  it("flags co-occurring invoke + parameter markup near the end", () => {
    const text = `作業を続けます。\n\n${FUNCTION_CALLS_OPEN}\n${INVOKE_OPEN}\n${PARAM_OPEN}git status${PARAM_CLOSE}\n${INVOKE_CLOSE}\n${FUNCTION_CALLS_CLOSE}`;
    expect(detectIncompleteToolCall(text)).toBe(true);
  });

  it("flags the antml-prefixed variant", () => {
    const text = `次のコマンドを実行します。\n\n${ANTML_INVOKE_OPEN}\n${ANTML_PARAM_OPEN}ls -la</parameter>`;
    expect(detectIncompleteToolCall(text)).toBe(true);
  });

  it("does not flag a lone tag mentioned in prose", () => {
    expect(
      detectIncompleteToolCall(
        `ツール呼び出しは ${INVOKE_OPEN} のような形式ですが、ここでは実行しません。`,
      ),
    ).toBe(false);
  });

  it("does not flag ordinary prose or code explanations", () => {
    expect(detectIncompleteToolCall("実装が完了しました。テストも通っています。")).toBe(false);
    expect(
      detectIncompleteToolCall(
        "Use `git status` to inspect the tree, then commit. No tool markup here at all.",
      ),
    ).toBe(false);
    expect(detectIncompleteToolCall("")).toBe(false);
    expect(detectIncompleteToolCall(null)).toBe(false);
  });

  it("does not flag markup buried far from the end behind a long, clean closing message", () => {
    const buried = `${INVOKE_OPEN}\n${PARAM_OPEN}x${PARAM_CLOSE}\n${INVOKE_CLOSE}`;
    const text = `${buried}\n\n${"これは正常に完了した最終メッセージです。".repeat(120)}`;
    expect(detectIncompleteToolCall(text)).toBe(false);
  });
});

describe("parseClaudeStreamJson incompleteToolCall (VANA-644 fixture)", () => {
  it("flags a subtype=success run whose final assistant turn emitted a Bash call as text", () => {
    const trailingText = `変更を確認します。\n\n${FUNCTION_CALLS_OPEN}\n${INVOKE_OPEN}\n${PARAM_OPEN}git add -A && git commit -m "fix"${PARAM_CLOSE}\n${INVOKE_CLOSE}\n${FUNCTION_CALLS_CLOSE}`;
    const stdout = streamLines([
      { type: "system", subtype: "init", session_id: "sess-644", model: "claude-opus-4-8" },
      {
        type: "assistant",
        session_id: "sess-644",
        message: { content: [{ type: "text", text: trailingText }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-644",
        is_error: false,
        result: trailingText,
        total_cost_usd: 0.42,
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    ]);
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.resultJson?.subtype).toBe("success");
    expect(parsed.incompleteToolCall).toBe(true);
  });

  it("does not flag a normal success run that ends with prose", () => {
    const finalText = "実装とテストが完了しました。差分は最小限です。";
    const stdout = streamLines([
      { type: "system", subtype: "init", session_id: "sess-ok", model: "claude-opus-4-8" },
      {
        type: "assistant",
        session_id: "sess-ok",
        message: { content: [{ type: "text", text: finalText }] },
      },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-ok",
        is_error: false,
        result: finalText,
        total_cost_usd: 0.1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.incompleteToolCall).toBe(false);
  });
});

describe("extractClaudeRetryNotBefore", () => {
  it("parses the 'resets 4pm' hint in its explicit timezone", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-22T21:00:00.000Z");
  });

  it("rolls forward past midnight when the reset time has already passed today", () => {
    const now = new Date("2026-04-22T23:30:00.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "Usage limit reached. Resets at 3:15 AM (UTC)." },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-04-23T03:15:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });
});
