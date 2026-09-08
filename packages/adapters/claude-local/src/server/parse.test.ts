import { describe, expect, it } from "vitest";
import {
  detectIncompleteToolCall,
  extractClaudeRateLimitReset,
  extractClaudeRetryNotBefore,
  isClaudeAccountQuotaExhausted,
  claudeModelUsageTotals,
  parseClaudeStreamJson,
  detectClaudeLoginRequired,
  isClaudeProviderQuotaError,
  isClaudeTransientUpstreamError,
  isClaudePoisonedPreviousMessageIdError,
  isClaudeRefusalResult,
  isClaudeUnknownSessionError,
  isClaudeImageProcessingError,
  isClaudeModelNotFoundError,
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
const ANTML_INVOKE_OPEN = `<${"antml:invoke"} name="Bash">`;
const ANTML_PARAM_OPEN = `<${"antml:parameter"} name="command">`;

function streamLines(events: Record<string, unknown>[]): string {
  return events.map((event) => JSON.stringify(event)).join("\n");
}

describe("detectClaudeLoginRequired", () => {
  it("classifies Claude's invalid API key login prompt as auth required", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key · Please run /login",
      }),
    ).toEqual({ requiresLogin: true, loginUrl: null });
  });

  it("does not classify a bare invalid API key as the Claude login flow", () => {
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "",
        stderr: "Invalid API key",
      }).requiresLogin,
    ).toBe(false);
  });

  it("classifies an invalid or expired OAuth bearer token as login required", () => {
    // Grounded on the real Claude CLI output for CLAUDE_CODE_OAUTH_TOKEN=invalid:
    // the result event carries a 401 authentication failure and an "Invalid
    // bearer token" message. This is an auth failure, not a probe that could not
    // run, so the detector must classify it as login required.
    const parsed = {
      is_error: true,
      subtype: "success",
      api_error_status: 401,
      error: "authentication_failed",
      result: "Failed to authenticate. API Error: 401 Invalid bearer token",
    };
    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"Failed to authenticate. API Error: 401 Invalid bearer token"}]},"error":"authentication_failed"}',
        stderr: "",
      }).requiresLogin,
    ).toBe(true);
  });

  it("does not route an invalid token to the transient or quota classifiers", () => {
    // An auth failure must win over the transient and quota lanes, so a run
    // surfaces login required instead of a retry.
    const input = {
      parsed: {
        is_error: true,
        result: "Failed to authenticate. API Error: 401 Invalid bearer token",
      },
      stdout: "",
      stderr: "",
    };
    expect(isClaudeTransientUpstreamError(input)).toBe(false);
    expect(isClaudeProviderQuotaError(input)).toBe(false);
  });

  it("classifies an expired or revoked token in the parsed result as login required", () => {
    // The result event marks the run as a failure and reports an expired token.
    // This is a token failure, so the detector classifies it as login required.
    const parsed = {
      is_error: true,
      subtype: "success",
      result: "Failed to authenticate. Your OAuth access token is expired.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(true);
  });

  it("does not classify a successful probe whose assistant text repeats a token phrase", () => {
    // A healthy run can print an auth phrase in its answer text. The parsed
    // result is a success, so the token-failure markers must not fire on the raw
    // stdout assistant event.
    const parsed = {
      is_error: false,
      subtype: "success",
      result: "hello",
    };
    expect(
      detectClaudeLoginRequired({
        parsed,
        stdout:
          '{"type":"assistant","message":{"content":[{"type":"text","text":"The phrase authentication_failed means an invalid bearer token."}]}}',
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });

  it("does not classify a success whose result text repeats a token phrase", () => {
    // The model's own answer repeats a token phrase, so the phrase lands in the
    // parsed result. The run is a success, so the failure gate keeps it healthy.
    const parsed = {
      is_error: false,
      subtype: "success",
      result: "Sure. An invalid bearer token means authentication_failed.",
    };
    expect(
      detectClaudeLoginRequired({ parsed, stdout: "", stderr: "" }).requiresLogin,
    ).toBe(false);
  });

  it("keeps a transient failure with an assistant token phrase on the transient lane", () => {
    // The run fails on a 503 transient error. The token phrase appears only in
    // the raw stdout assistant event, not the parsed result, so the run stays
    // transient and never classifies as login required.
    const input = {
      parsed: {
        is_error: true,
        subtype: "error_during_execution",
        result: "API Error: 503 service unavailable",
      },
      stdout:
        '{"type":"assistant","message":{"content":[{"type":"text","text":"authentication_failed: the bearer token is invalid"}]}}',
      stderr: "",
    };
    expect(detectClaudeLoginRequired(input).requiresLogin).toBe(false);
    expect(isClaudeTransientUpstreamError(input)).toBe(true);
  });

  it("does not treat a bare token phrase in raw stdout with no parsed result as login required", () => {
    // Untrusted stdout alone must not satisfy a token-failure marker. Only the
    // parsed terminal result fields of a failed run can trip the token markers.
    expect(
      detectClaudeLoginRequired({
        parsed: null,
        stdout: "authentication_failed while the assistant called a tool",
        stderr: "",
      }).requiresLogin,
    ).toBe(false);
  });
});

describe("isClaudeModelNotFoundError", () => {
  it("detects model resolution failures from structured and fallback output", () => {
    expect(isClaudeModelNotFoundError({
      parsed: {
        result: "API Error: 404 model not found: claude-haiku-4-6",
      },
    })).toBe(true);
    expect(isClaudeModelNotFoundError({
      stderr: "Unknown model claude-haiku-4-6",
    })).toBe(true);
  });

  it("does not classify unrelated provider failures as model resolution errors", () => {
    expect(isClaudeModelNotFoundError({
      errorMessage: "API Error: 503 service unavailable",
    })).toBe(false);
  });
});

describe("isClaudeTransientUpstreamError", () => {
  it("classifies the 'out of extra usage' subscription window failure as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
        parsed: {
          is_error: true,
          result: "You're out of extra usage. Resets at 4pm (America/Chicago).",
        },
      }),
    ).toBe(true);
    expect(
      isClaudeTransientUpstreamError({
        errorMessage: "You're out of extra usage · resets 4pm (America/Chicago)",
      }),
    ).toBe(false);
  });

  it("classifies Claude session-limit windows as provider quota and extracts the retry time", () => {
    const now = new Date("2026-04-22T15:15:00.000Z");
    const errorMessage = "You've hit your session limit - resets at 4pm (America/Chicago).";

    expect(isClaudeProviderQuotaError({ errorMessage })).toBe(true);
    expect(isClaudeTransientUpstreamError({ errorMessage })).toBe(false);
    expect(extractClaudeRetryNotBefore({ errorMessage }, now)?.toISOString()).toBe(
      "2026-04-22T21:00:00.000Z",
    );
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

  it("classifies the subscription 5-hour / weekly limit wording as provider quota", () => {
    expect(
      isClaudeProviderQuotaError({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(true);
    expect(
      isClaudeProviderQuotaError({
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

  it("does not classify poisoned previous_message_id errors as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          subtype: "success",
          is_error: true,
          result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
        },
      }),
    ).toBe(false);
  });

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

  it("classifies the session-limit wording as transient", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: {
          is_error: true,
          subtype: "success",
          result: "You've hit your session limit · resets 1pm (Asia/Tokyo)",
        },
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
});

describe("isClaudePoisonedPreviousMessageIdError", () => {
  it("detects the previous_message_id 400 error in the result field", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "",
        errors: [{ message: "400 diagnostics.previous_message_id: must be the `id` from a prior /v1/messages response (starts with `msg_`)" }],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudePoisonedPreviousMessageIdError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudePoisonedPreviousMessageIdError({})).toBe(false);
  });
});

describe("isClaudeRefusalResult", () => {
  it("detects stop_reason: refusal even on a clean (is_error=false) result", () => {
    expect(
      isClaudeRefusalResult({
        type: "result",
        subtype: "success",
        is_error: false,
        stop_reason: "refusal",
        result: "",
      }),
    ).toBe(true);
  });

  it("detects the camelCase stopReason variant", () => {
    expect(isClaudeRefusalResult({ stopReason: "refusal" })).toBe(true);
  });

  it("detects subtype: model_refusal", () => {
    expect(
      isClaudeRefusalResult({ subtype: "model_refusal", is_error: false }),
    ).toBe(true);
  });

  it("is case-insensitive and tolerant of surrounding whitespace", () => {
    expect(isClaudeRefusalResult({ stop_reason: "  Refusal " })).toBe(true);
  });

  it("returns false for ordinary successful turns", () => {
    expect(
      isClaudeRefusalResult({
        subtype: "success",
        is_error: false,
        stop_reason: "end_turn",
        result: "Here is your answer.",
      }),
    ).toBe(false);
  });

  it("returns false for max-turns and other stop reasons", () => {
    expect(isClaudeRefusalResult({ stop_reason: "max_turns" })).toBe(false);
    expect(isClaudeRefusalResult({ subtype: "error_max_turns" })).toBe(false);
  });

  it("returns false for null/empty parsed result", () => {
    expect(isClaudeRefusalResult(null)).toBe(false);
    expect(isClaudeRefusalResult({})).toBe(false);
  });
});

describe("isClaudeUnknownSessionError", () => {
  it("detects the legacy 'no conversation found' message", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Error: No conversation found with session id 1234",
      }),
    ).toBe(true);
  });

  it("detects 'session ... not found' style errors", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [{ message: "Session abc123 not found" }],
      }),
    ).toBe(true);
  });

  it("detects '--resume requires a valid session' validation error from non-UUID input", () => {
    expect(
      isClaudeUnknownSessionError({
        errors: [
          {
            message:
              'Error: --resume requires a valid session ID or session title when used with --print. Usage: claude -p --resume <session-id|title>. Provided value "ses_268c2d0a5ffemYbEaeG7c86Uvo" is not a UUID and does not match any session title.',
          },
        ],
      }),
    ).toBe(true);
  });

  it("returns false for unrelated error text", () => {
    expect(
      isClaudeUnknownSessionError({
        result: "Some other failure",
        errors: [{ message: "Network timeout" }],
      }),
    ).toBe(false);
  });
});

describe("isClaudeImageProcessingError", () => {
  it("detects the 'Could not process image' 400 error in the result field", () => {
    expect(
      isClaudeImageProcessingError({
        subtype: "success",
        is_error: true,
        result: "API Error: 400 Could not process image: image source URL has expired",
      }),
    ).toBe(true);
  });

  it("detects the error in the errors array", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "",
        errors: [{ message: "400 Could not process image" }],
      }),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "could not process image attached to message",
      }),
    ).toBe(true);
  });

  it("returns false for unrelated errors", () => {
    expect(
      isClaudeImageProcessingError({
        is_error: true,
        result: "No conversation found with session id abc-123",
      }),
    ).toBe(false);
  });

  it("returns false for empty parsed result", () => {
    expect(isClaudeImageProcessingError({})).toBe(false);
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

  it("parses the session-limit 'resets 1pm' hint in its explicit timezone", () => {
    const now = new Date("2026-06-12T02:57:50.000Z");
    const extracted = extractClaudeRetryNotBefore(
      { errorMessage: "You've hit your session limit · resets 1pm (Asia/Tokyo)" },
      now,
    );
    expect(extracted?.toISOString()).toBe("2026-06-12T04:00:00.000Z");
  });

  it("returns null when no reset hint is present", () => {
    expect(
      extractClaudeRetryNotBefore({ errorMessage: "Overloaded. Try again later." }, new Date()),
    ).toBeNull();
  });

  // structured rate_limit_event.resetsAt beats the free-text wording.
  it("prefers the structured rate_limit_event reset over the spend-limit wording", () => {
    const resetsAt = 1785829800; // five_hour window, same-day reset
    const stdout = [
      '{"type":"system","subtype":"init","session_id":"s1"}',
      `{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":${resetsAt},"rateLimitType":"five_hour","overageStatus":"rejected","overageResetsAt":1788220800,"overageDisabledReason":"org_level_disabled_until","isUsingOverage":false}}`,
      '{"type":"result","is_error":true,"result":"You\'ve hit your org\'s monthly spend limit"}',
    ].join("\n");
    const extracted = extractClaudeRetryNotBefore(
      {
        parsed: { is_error: true, result: "You've hit your org's monthly spend limit" },
        stdout,
      },
      new Date("2026-08-04T06:34:00.000Z"),
    );
    expect(extracted?.getTime()).toBe(resetsAt * 1000);
  });
});

describe("claudeModelUsageTotals", () => {
  it("sums per-model usage across models and counts cache writes as input", () => {
    const totals = claudeModelUsageTotals({
      "claude-fable-5": {
        inputTokens: 100,
        outputTokens: 70_000,
        cacheReadInputTokens: 250_000,
        cacheCreationInputTokens: 4_000,
        costUSD: 1.2,
      },
      "claude-haiku-4-5": {
        inputTokens: 50,
        outputTokens: 7_000,
        cacheReadInputTokens: 10_000,
        cacheCreationInputTokens: 500,
        costUSD: 0.05,
      },
    });
    expect(totals).toEqual({
      inputTokens: 4_650,
      outputTokens: 77_000,
      cachedInputTokens: 260_000,
    });
  });

  it("returns null for missing or empty modelUsage", () => {
    expect(claudeModelUsageTotals(undefined)).toBeNull();
    expect(claudeModelUsageTotals({})).toBeNull();
  });
});

describe("parseClaudeStreamJson usage extraction", () => {
  const resultEvent = (extra: Record<string, unknown>) =>
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "sess-1",
      result: "done",
      total_cost_usd: 1.25,
      usage: { input_tokens: 10, output_tokens: 1_800, cache_read_input_tokens: 20 },
      ...extra,
    });

  it("prefers modelUsage totals over the main-loop usage block and marks them per-run", () => {
    const parsed = parseClaudeStreamJson(
      `${resultEvent({
        modelUsage: {
          "claude-fable-5": {
            inputTokens: 90,
            outputTokens: 77_000,
            cacheReadInputTokens: 300_000,
            cacheCreationInputTokens: 2_000,
          },
        },
      })}\n`,
    );
    expect(parsed.usage).toEqual({
      inputTokens: 2_090,
      outputTokens: 77_000,
      cachedInputTokens: 300_000,
    });
    expect(parsed.usageBasis).toBe("per_run");
    expect(parsed.costUsd).toBeCloseTo(1.25);
  });

  it("falls back to the result usage block when modelUsage is absent", () => {
    const parsed = parseClaudeStreamJson(`${resultEvent({})}\n`);
    expect(parsed.usage).toEqual({
      inputTokens: 10,
      outputTokens: 1_800,
      cachedInputTokens: 20,
    });
    expect(parsed.usageBasis).toBe("per_run");
  });
});

describe("isClaudeAccountQuotaExhausted", () => {
  // the real measured wording. In the field this run also carried an
  // `api_error_status: 429`, which is the *only* reason it was ever classified as
  // transient — so the fixtures below deliberately omit that field to prove the
  // text alone is now sufficient.
  const SPEND_LIMIT_TEXT =
    "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit";

  it("classifies the monthly spend-limit wording as transient without the 429 field", () => {
    expect(
      isClaudeTransientUpstreamError({
        parsed: { is_error: true, subtype: "error", result: SPEND_LIMIT_TEXT },
      }),
    ).toBe(true);
  });

  it("classifies the reset-less account/org quota wording as account-quota-exhausted", () => {
    expect(
      isClaudeAccountQuotaExhausted({
        parsed: { is_error: true, subtype: "error", result: SPEND_LIMIT_TEXT },
      }),
    ).toBe(true);
    expect(
      isClaudeAccountQuotaExhausted({ errorMessage: "Your credit balance is too low to run this." }),
    ).toBe(true);
    expect(isClaudeAccountQuotaExhausted({ stderr: "insufficient credits" })).toBe(true);
  });

  it("does not treat the 5-hour / weekly / session reset windows as account-quota exhaustion", () => {
    expect(isClaudeAccountQuotaExhausted({ errorMessage: "5-hour limit reached." })).toBe(false);
    expect(
      isClaudeAccountQuotaExhausted({
        errorMessage: "Claude usage limit reached — weekly limit reached. Try again in 2 days.",
      }),
    ).toBe(false);
    expect(
      isClaudeAccountQuotaExhausted({
        parsed: { is_error: true, result: "You've hit your session limit · resets 1pm (Asia/Tokyo)" },
      }),
    ).toBe(false);
    // ...yet those reset windows must still classify as transient so the
    // existing retryNotBefore deferral path keeps handling them.
    expect(isClaudeTransientUpstreamError({ errorMessage: "5-hour limit reached." })).toBe(true);
  });
});

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

describe("parseClaudeStreamJson incompleteToolCall", () => {
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

describe("parseClaudeStreamJson usage cache tokens", () => {
  it("retains cache_creation and cache_read tokens in the usage summary", () => {
    const stdout = streamLines([
      { type: "system", subtype: "init", session_id: "sess-cache", model: "claude-opus-4-8" },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-cache",
        is_error: false,
        result: "done",
        total_cost_usd: 1.23,
        usage: {
          input_tokens: 100,
          output_tokens: 50,
          cache_read_input_tokens: 4000,
          cache_creation_input_tokens: 9000,
        },
      },
    ]);
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.usage).toEqual({
      inputTokens: 100,
      cachedInputTokens: 4000,
      cacheCreationInputTokens: 9000,
      outputTokens: 50,
    });
  });

  it("defaults cache token counts to 0 when the result omits them", () => {
    const stdout = streamLines([
      { type: "system", subtype: "init", session_id: "sess-nocache", model: "claude-opus-4-8" },
      {
        type: "result",
        subtype: "success",
        session_id: "sess-nocache",
        is_error: false,
        result: "done",
        total_cost_usd: 0.1,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);
    const parsed = parseClaudeStreamJson(stdout);
    expect(parsed.usage?.cacheCreationInputTokens).toBe(0);
    expect(parsed.usage?.cachedInputTokens).toBe(0);
  });
});

describe("extractClaudeRateLimitReset", () => {
  it("returns the resetsAt of the last rejected rate_limit_event", () => {
    const stdout = [
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1785800000,"rateLimitType":"five_hour"}}',
      '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1785829800,"rateLimitType":"five_hour"}}',
    ].join("\n");
    expect(extractClaudeRateLimitReset({ stdout })?.getTime()).toBe(1785829800 * 1000);
  });

  it("ignores allowed_warning overage events and never reads overageResetsAt", () => {
    // An allowed_warning overage record carries resetsAt at the calendar-month
    // boundary; using it would re-introduce the one-month-fallback trap.
    const stdout =
      '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","resetsAt":1788220800,"rateLimitType":"overage","overageResetsAt":1788220800}}';
    expect(extractClaudeRateLimitReset({ stdout })).toBeNull();
  });

  it("returns null when stdout carries no structured rate_limit_event", () => {
    expect(
      extractClaudeRateLimitReset({ stdout: '{"type":"result","is_error":true,"result":"boom"}' }),
    ).toBeNull();
    expect(extractClaudeRateLimitReset({ stdout: "" })).toBeNull();
    expect(extractClaudeRateLimitReset({})).toBeNull();
  });
});
