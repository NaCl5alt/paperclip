import type { UsageSummary } from "@paperclipai/adapter-utils";
import {
  asString,
  asNumber,
  asBoolean,
  parseObject,
  parseJson,
} from "@paperclipai/adapter-utils/server-utils";

// The legacy login-prompt markers. The Claude CLI prints these words when it
// asks the user to log in. The detector matches them against any probe output
// line, which includes the raw stdout and stderr. This scope is pre-existing.
// It supersedes the fork's narrower CLAUDE_AUTH_REQUIRED_RE (every alternative
// of that regex is present here).
const CLAUDE_LOGIN_PROMPT_RE =
  /(?:not\s+logged\s+in|please\s+log\s+in|please\s+run\s+(?:`?claude\s+login`?|\/login)|login\s+required|requires\s+login|unauthorized|authentication\s+required|invalid\s+api\s+key[\s\S]{0,120}(?:\/login|claude\s+login|log\s+in))/i;

// The token-failure markers. An assistant or model event can print these same
// words as ordinary prose, so the detector matches them only against the parsed
// terminal result fields of a failed run. See detectClaudeLoginRequired.
const CLAUDE_AUTH_TOKEN_FAILURE_RE =
  /(?:authentication[_\s-](?:failed|error)|failed\s+to\s+authenticate|invalid\s+bearer\s+token|(?:invalid|expired|revoked)[\s\S]{0,40}(?:bearer|oauth|access)\s+token|(?:bearer|oauth|access)\s+token[\s\S]{0,40}(?:is\s+)?(?:invalid|expired|revoked))/i;

// OAuth session-expiry wording from the Claude CLI. Matched only
// against parsed.result / structured error messages — never raw stdout/stderr —
// so a prompt that merely quotes this issue cannot flip the
// classifier.
const CLAUDE_OAUTH_SESSION_EXPIRED_RE =
  /(?:failed\s+to\s+authenticate:\s*)?oauth\s+session\s+expired(?:\s+and\s+could\s+not\s+be\s+refreshed)?/i;
const URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

// Tool-call markup that the model is supposed to emit as a structured tool_use
// block but occasionally writes into a plain assistant `text` block instead. When
// that happens the tool is never executed yet the run still reports
// subtype=success. Detect the markup so the adapter can refuse to
// mark such a run as succeeded. The `antml:` prefix variant is also matched.
const TOOL_INVOKE_RE = /<(?:antml:)?invoke\s+name\s*=/i;
const TOOL_PARAMETER_RE = /<(?:antml:)?parameter\s+name\s*=/i;
const TOOL_FUNCTION_CALLS_RE = /<(?:antml:)?function_calls\s*>/i;

// Only inspect the tail of the message: a genuine "tool emitted as text" failure
// terminates inside/just after the markup, so the signature lives near the very
// end. Bounding the window keeps the check conservative — earlier prose that
// merely *describes* the syntax (a code explanation) does not trip it.
const INCOMPLETE_TOOL_CALL_TAIL_CHARS = 2000;

export function detectIncompleteToolCall(text: string | null | undefined): boolean {
  if (!text) return false;
  const tail = text.length > INCOMPLETE_TOOL_CALL_TAIL_CHARS
    ? text.slice(-INCOMPLETE_TOOL_CALL_TAIL_CHARS)
    : text;
  const hasInvoke = TOOL_INVOKE_RE.test(tail);
  const hasParameter = TOOL_PARAMETER_RE.test(tail);
  const hasFunctionCalls = TOOL_FUNCTION_CALLS_RE.test(tail);
  // Require co-occurring invoke+parameter (a full malformed tool call), or the
  // explicit <function_calls> wrapper alongside at least one inner tag. A lone
  // tag is not enough — that keeps false positives on prose/code samples low.
  return (hasInvoke && hasParameter) || (hasFunctionCalls && (hasInvoke || hasParameter));
}

const CLAUDE_TRANSIENT_UPSTREAM_RE =
  /(?:rate[-\s]?limit(?:ed)?|rate_limit_error|too\s+many\s+requests|\b429\b|overloaded(?:_error)?|server\s+overloaded|service\s+unavailable|\b503\b|\b529\b|high\s+demand|try\s+again\s+later|temporarily\s+unavailable|throttl(?:ed|ing)|throttlingexception|servicequotaexceededexception|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|hit\s+your\s+session\s+limit|session\s+limit\s+reached|monthly\s+spend\s+limit|spend\s+limit|usage[-\s]?credits|credit\s+balance\s+is\s+too\s+low|insufficient\s+credits)/i;
const CLAUDE_PROVIDER_QUOTA_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage\b|claude\s+usage\s+limit\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|usage\s+limit\s+reached|usage\s+cap\s+reached|servicequotaexceededexception)/i;
// Reset-less account/org-level quota exhaustion (e.g. a monthly spend limit or a
// depleted credit balance). Unlike the 5-hour / weekly *session* windows, these
// carry no upstream reset time, so waiting out a bounded-retry ladder never
// clears them — the heartbeat hands the issue straight to the recovery fallback
// This deliberately excludes the session-window wording so it never
// steals the existing `retryNotBefore` deferral path.
// the `usage-credits` alternative was removed. It only ever appeared as
// the tail of the real wording ("run /usage-credits to ask your admin…"), which
// still matches via `spend limit`, but the bare token `usage-credits` is also the
// name of a Claude Code slash command echoed into every run's stdout stream (the
// command registry) — so matching it against a full transcript flagged every
// non-quota transient failure as quota-exhausted (measured 197/197 false positive).
const CLAUDE_ACCOUNT_QUOTA_EXHAUSTED_RE =
  /(?:monthly\s+spend\s+limit|spend\s+limit|credit\s+balance\s+is\s+too\s+low|insufficient\s+credits)/i;
const CLAUDE_MODEL_NOT_FOUND_RE =
  /(?:\b404\b[\s\S]{0,120})?(?:model[\s_-]*(?:not[\s_-]*found|does not exist|unknown|invalid)|unknown[\s_-]*model)/i;
const CLAUDE_EXTRA_USAGE_RESET_RE =
  /(?:you(?:'|’)ve\s+hit\s+your\s+session\s+limit|session\s+limit\s+(?:reached|exceeded)|out\s+of\s+extra\s+usage|extra\s+usage|usage\s+limit\s+reached|usage\s+cap\s+reached|5[-\s]?hour\s+limit\s+reached|weekly\s+limit\s+reached|claude\s+usage\s+limit\s+reached)[\s\S]{0,120}?\bresets?\s+(?:at\s+)?([^\n()]+?)(?:\s*\(([^)]+)\))?(?:[.!]|\n|$)/i;

/**
 * Sum the per-model usage ledger from a Claude CLI result event. The result
 * event's top-level `usage` reflects only the main-loop message chain, so it
 * undercounts output tokens whenever subagents or sidechains ran; `modelUsage`
 * is the CLI's authoritative per-model accounting (it is what backs /cost).
 * Cache-creation tokens are billed prompt tokens, so they count as input.
 */
export function claudeModelUsageTotals(modelUsage: unknown): UsageSummary | null {
  const byModel = parseObject(modelUsage);
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
  let sawEntry = false;
  for (const value of Object.values(byModel)) {
    const entry = parseObject(value);
    if (Object.keys(entry).length === 0) continue;
    sawEntry = true;
    inputTokens += asNumber(entry.inputTokens, 0) + asNumber(entry.cacheCreationInputTokens, 0);
    outputTokens += asNumber(entry.outputTokens, 0);
    cachedInputTokens += asNumber(entry.cacheReadInputTokens, 0);
  }
  if (!sawEntry) return null;
  return { inputTokens, outputTokens, cachedInputTokens };
}

export function parseClaudeStreamJson(stdout: string) {
  let sessionId: string | null = null;
  let model = "";
  let finalResult: Record<string, unknown> | null = null;
  const assistantTexts: string[] = [];

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "system" && asString(event.subtype, "") === "init") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      model = asString(event.model, model);
      continue;
    }

    if (type === "assistant") {
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
      const message = parseObject(event.message);
      const content = Array.isArray(message.content) ? message.content : [];
      for (const entry of content) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
        const block = entry as Record<string, unknown>;
        if (asString(block.type, "") === "text") {
          const text = asString(block.text, "");
          if (text) assistantTexts.push(text);
        }
      }
      continue;
    }

    if (type === "result") {
      finalResult = event;
      sessionId = asString(event.session_id, sessionId ?? "") || sessionId;
    }
  }

  const lastAssistantText = assistantTexts.length > 0 ? assistantTexts[assistantTexts.length - 1] ?? "" : "";

  if (!finalResult) {
    return {
      sessionId,
      model,
      costUsd: null as number | null,
      usage: null as UsageSummary | null,
      usageBasis: null as "per_run" | null,
      summary: assistantTexts.join("\n\n").trim(),
      resultJson: null as Record<string, unknown> | null,
      incompleteToolCall: detectIncompleteToolCall(lastAssistantText),
    };
  }

  const modelUsageTotals = claudeModelUsageTotals(finalResult.modelUsage);
  const usageObj = parseObject(finalResult.usage);
  const usage: UsageSummary = modelUsageTotals ?? {
    inputTokens: asNumber(usageObj.input_tokens, 0),
    cachedInputTokens: asNumber(usageObj.cache_read_input_tokens, 0),
    cacheCreationInputTokens: asNumber(usageObj.cache_creation_input_tokens, 0),
    outputTokens: asNumber(usageObj.output_tokens, 0),
  };
  const costRaw = finalResult.total_cost_usd;
  const costUsd = typeof costRaw === "number" && Number.isFinite(costRaw) ? costRaw : null;
  const resultText = asString(finalResult.result, "");
  const summary = asString(finalResult.result, assistantTexts.join("\n\n")).trim();

  return {
    sessionId,
    model,
    costUsd,
    usage,
    // modelUsage covers exactly this CLI invocation, so mark it per-run to
    // keep the server from applying its session-cumulative delta heuristic.
    usageBasis: "per_run" as const,
    summary,
    resultJson: finalResult,
    incompleteToolCall:
      detectIncompleteToolCall(resultText) || detectIncompleteToolCall(lastAssistantText),
  };
}

function extractClaudeErrorMessages(parsed: Record<string, unknown>): string[] {
  const raw = Array.isArray(parsed.errors) ? parsed.errors : [];
  const messages: string[] = [];

  for (const entry of raw) {
    if (typeof entry === "string") {
      const msg = entry.trim();
      if (msg) messages.push(msg);
      continue;
    }

    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      continue;
    }

    const obj = entry as Record<string, unknown>;
    const msg = asString(obj.message, "") || asString(obj.error, "") || asString(obj.code, "");
    if (msg) {
      messages.push(msg);
      continue;
    }

    try {
      messages.push(JSON.stringify(obj));
    } catch {
      // skip non-serializable entry
    }
  }

  return messages;
}

export function extractClaudeLoginUrl(text: string): string | null {
  const match = text.match(URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("claude") || cleaned.includes("anthropic") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

// Collect the parsed terminal result fields that carry an auth failure. The
// CLI writes the token-failure text to the result event, so the detector reads
// the result string, the top-level error field, and the errors array. It never
// reads the raw stdout, so an assistant event cannot inject a token marker.
function collectClaudeTerminalText(parsed: Record<string, unknown>): string {
  return [
    asString(parsed.result, ""),
    asString(parsed.error, ""),
    ...extractClaudeErrorMessages(parsed),
  ]
    .map((field) => field.trim())
    .filter(Boolean)
    .join("\n");
}

// Report whether the parsed terminal result marks the run as an auth failure.
// The token-failure markers apply only to a failed run. A successful probe
// whose answer text repeats an auth phrase does not classify as login required.
function claudeResultIndicatesAuthFailure(parsed: Record<string, unknown>): boolean {
  if (asBoolean(parsed.is_error, false)) return true;
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype.startsWith("error")) return true;
  const status =
    asNumber(parsed.api_error_status, 0) || asNumber(parsed.error_status, 0);
  if (status === 401 || status === 403) return true;
  if (asString(parsed.error, "").trim()) return true;
  return extractClaudeErrorMessages(parsed).length > 0;
}

export function detectClaudeLoginRequired(input: {
  parsed: Record<string, unknown> | null;
  stdout: string;
  stderr: string;
}): { requiresLogin: boolean; loginUrl: string | null } {
  const parsed = input.parsed ?? null;
  const resultText = asString(parsed?.result, "").trim();

  // The legacy login-prompt markers keep their broad scope. They match against
  // every output line, which includes the parsed result, the parsed errors, and
  // the raw stdout and stderr.
  const promptLines = [resultText, ...extractClaudeErrorMessages(parsed ?? {}), input.stdout, input.stderr]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const loginPrompt = promptLines.some((line) => CLAUDE_LOGIN_PROMPT_RE.test(line));

  // The token-failure markers match only against the parsed terminal fields of
  // a failed run. The raw stdout is untrusted, so a model that prints a token
  // phrase, or a successful run that repeats one, does not flip the classifier.
  const tokenFailure =
    parsed !== null &&
    claudeResultIndicatesAuthFailure(parsed) &&
    CLAUDE_AUTH_TOKEN_FAILURE_RE.test(collectClaudeTerminalText(parsed));

  // the CLI's OAuth-expiry wording. Kept as its own check because it
  // does not require `claudeResultIndicatesAuthFailure`, and its haystack is the
  // parsed terminal text only, never raw stdout.
  const oauthSessionExpired =
    parsed !== null && CLAUDE_OAUTH_SESSION_EXPIRED_RE.test(collectClaudeTerminalText(parsed));

  return {
    requiresLogin: loginPrompt || tokenFailure || oauthSessionExpired,
    loginUrl: extractClaudeLoginUrl([input.stdout, input.stderr].join("\n")),
  };
}

export function describeClaudeFailure(parsed: Record<string, unknown>): string | null {
  const subtype = asString(parsed.subtype, "");
  const resultText = asString(parsed.result, "").trim();
  const errors = extractClaudeErrorMessages(parsed);

  let detail = resultText;
  if (!detail && errors.length > 0) {
    detail = errors[0] ?? "";
  }

  const parts = ["Claude run failed"];
  if (subtype) parts.push(`subtype=${subtype}`);
  if (detail) parts.push(detail);
  return parts.length > 1 ? parts.join(": ") : null;
}

export function isClaudeModelNotFoundError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  const messages = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
    parsed ? asString(parsed.result, "") : "",
    ...(parsed ? extractClaudeErrorMessages(parsed) : []),
  ];
  return messages.some((message) => CLAUDE_MODEL_NOT_FOUND_RE.test(message));
}

export function isClaudeMaxTurnsResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "error_max_turns") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) =>
    reason === "max_turns" ||
    reason === "max_turns_exhausted" ||
    reason === "turn_limit" ||
    reason === "turn_limit_exhausted",
  );
}

export function isClaudeRefusalResult(parsed: Record<string, unknown> | null | undefined): boolean {
  if (!parsed) return false;

  // A policy refusal exits the CLI cleanly (exitCode=0, is_error=false), so it
  // must be detected from the structured fields rather than the failure flag.
  const subtype = asString(parsed.subtype, "").trim().toLowerCase();
  if (subtype === "model_refusal" || subtype === "refusal") return true;

  const structuredStopReasons = [
    parsed.stop_reason,
    parsed.stopReason,
    parsed.error_code,
    parsed.errorCode,
  ].map((value) => asString(value, "").trim().toLowerCase());

  return structuredStopReasons.some((reason) => reason === "refusal");
}

export function isClaudeUnknownSessionError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /no conversation found with session id|unknown session|session .* not found|not a valid UUID|--resume requires a valid session|is not a UUID|does not match any session title/i.test(
      msg,
    ),
  );
}

export function isClaudePoisonedPreviousMessageIdError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /diagnostics\.previous_message_id.*starts with `msg_`/i.test(msg),
  );
}

export function isClaudeImageProcessingError(parsed: Record<string, unknown>): boolean {
  const resultText = asString(parsed.result, "").trim();
  const allMessages = [resultText, ...extractClaudeErrorMessages(parsed)]
    .map((msg) => msg.trim())
    .filter(Boolean);

  return allMessages.some((msg) =>
    /could not process image/i.test(msg),
  );
}

function buildClaudeTransientHaystack(
  input: {
    parsed?: Record<string, unknown> | null;
    stdout?: string | null;
    stderr?: string | null;
    errorMessage?: string | null;
  },
  // `stdout` is the FULL stream-json run transcript — every assistant
  // turn, tool output, and the harness command registry (which literally lists
  // slash commands like `usage-credits` / `extra-usage`). Scanning it is fine for
  // the broad transient-upstream classifier, but the account-quota refinement uses
  // narrower, more common wording ("spend limit", "credit balance is too low") that
  // routinely appears in an agent's own prose or the command list. Callers that
  // must not match on transcript content pass `includeStreamTranscript: false` so
  // only the failure surface (errorMessage + parsed.result + parsed errors + the
  // short stderr diagnostic stream) is scanned.
  opts: { includeStreamTranscript?: boolean } = {},
): string {
  const includeStreamTranscript = opts.includeStreamTranscript ?? true;
  const parsed = input.parsed ?? null;
  const resultText = parsed ? asString(parsed.result, "") : "";
  const parsedErrors = parsed ? extractClaudeErrorMessages(parsed) : [];
  return [
    input.errorMessage ?? "",
    resultText,
    ...parsedErrors,
    ...(includeStreamTranscript ? [input.stdout ?? ""] : []),
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

function readTimeZoneParts(date: Date, timeZone: string) {
  const values = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(date).map((part) => [part.type, part.value]),
  );
  return {
    year: Number.parseInt(values.get("year") ?? "", 10),
    month: Number.parseInt(values.get("month") ?? "", 10),
    day: Number.parseInt(values.get("day") ?? "", 10),
    hour: Number.parseInt(values.get("hour") ?? "", 10),
    minute: Number.parseInt(values.get("minute") ?? "", 10),
  };
}

function normalizeResetTimeZone(timeZoneHint: string | null | undefined): string | null {
  const normalized = timeZoneHint?.trim();
  if (!normalized) return null;
  if (/^(?:utc|gmt)$/i.test(normalized)) return "UTC";

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date(0));
    return normalized;
  } catch {
    return null;
  }
}

function dateFromTimeZoneWallClock(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date | null {
  let candidate = new Date(Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0));
  const targetUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = readTimeZoneParts(candidate, input.timeZone);
    const actualUtc = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, 0, 0);
    const offsetMs = targetUtc - actualUtc;
    if (offsetMs === 0) break;
    candidate = new Date(candidate.getTime() + offsetMs);
  }

  const verified = readTimeZoneParts(candidate, input.timeZone);
  if (
    verified.year !== input.year ||
    verified.month !== input.month ||
    verified.day !== input.day ||
    verified.hour !== input.hour ||
    verified.minute !== input.minute
  ) {
    return null;
  }

  return candidate;
}

function nextClockTimeInTimeZone(input: {
  now: Date;
  hour: number;
  minute: number;
  timeZoneHint: string;
}): Date | null {
  const timeZone = normalizeResetTimeZone(input.timeZoneHint);
  if (!timeZone) return null;

  const nowParts = readTimeZoneParts(input.now, timeZone);
  let retryAt = dateFromTimeZoneWallClock({
    year: nowParts.year,
    month: nowParts.month,
    day: nowParts.day,
    hour: input.hour,
    minute: input.minute,
    timeZone,
  });
  if (!retryAt) return null;

  if (retryAt.getTime() <= input.now.getTime()) {
    const nextDay = new Date(Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day + 1, 0, 0, 0, 0));
    retryAt = dateFromTimeZoneWallClock({
      year: nextDay.getUTCFullYear(),
      month: nextDay.getUTCMonth() + 1,
      day: nextDay.getUTCDate(),
      hour: input.hour,
      minute: input.minute,
      timeZone,
    });
  }

  return retryAt;
}

function parseClaudeResetClockTime(clockText: string, now: Date, timeZoneHint?: string | null): Date | null {
  const normalized = clockText.trim().replace(/\s+/g, " ");
  const match = normalized.match(/^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?/i);
  if (!match) return null;

  const hour12 = Number.parseInt(match[1] ?? "", 10);
  const minute = Number.parseInt(match[2] ?? "0", 10);
  if (!Number.isInteger(hour12) || hour12 < 1 || hour12 > 12) return null;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  let hour24 = hour12 % 12;
  if ((match[3] ?? "").toLowerCase() === "p") hour24 += 12;

  if (timeZoneHint) {
    const explicitRetryAt = nextClockTimeInTimeZone({
      now,
      hour: hour24,
      minute,
      timeZoneHint,
    });
    if (explicitRetryAt) return explicitRetryAt;
  }

  const retryAt = new Date(now);
  retryAt.setHours(hour24, minute, 0, 0);
  if (retryAt.getTime() <= now.getTime()) {
    retryAt.setDate(retryAt.getDate() + 1);
  }
  return retryAt;
}

// the claude stream-json stdout carries structured `rate_limit_event`
// records whose `rate_limit_info.resetsAt` (unix seconds) is the authoritative
// reset time. Measured in the field, every rejection is a same-day `five_hour`
// window — the "monthly spend limit" copy is just the wording upstream prints for
// it — so preferring this structured value over the free-text `resets at …` hint
// gives an exact retry time and prevents the wording from being misread as a
// reset-less quota exhaustion. Only `status === "rejected"` events are honoured:
// `allowed_warning` overage records also carry a `resetsAt` (the calendar-month
// boundary), and `overageResetsAt` is never used (that is the month boundary that
// caused the "stuck on a one-month fallback" misread). The last rejected
// event wins.
export function extractClaudeRateLimitReset(input: { stdout?: string | null }): Date | null {
  const stdout = input.stdout ?? "";
  if (!stdout) return null;
  let latest: Date | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const event = parseJson(line);
    if (!event) continue;
    if (asString(event.type, "") !== "rate_limit_event") continue;
    const info = parseObject(event.rate_limit_info);
    if (asString(info.status, "") !== "rejected") continue;
    const resetsAt = info.resetsAt;
    if (typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) continue;
    latest = new Date(resetsAt * 1000);
  }
  return latest;
}

export function extractClaudeRetryNotBefore(
  input: {
    parsed?: Record<string, unknown> | null;
    stdout?: string | null;
    stderr?: string | null;
    errorMessage?: string | null;
  },
  now = new Date(),
): Date | null {
  // Structured reset (rate_limit_event) beats the free-text wording.
  const structured = extractClaudeRateLimitReset({ stdout: input.stdout });
  if (structured) return structured;
  const haystack = buildClaudeTransientHaystack(input);
  const match = haystack.match(CLAUDE_EXTRA_USAGE_RESET_RE);
  if (!match) return null;
  return parseClaudeResetClockTime(match[1] ?? "", now, match[2]);
}

export function isClaudeTransientUpstreamError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  // Deterministic failures are handled by their own classifiers.
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  // Intentionally no `isClaudeProviderQuotaError` guard here: the two predicates
  // overlap by design (session/spend limit text matches both). Callers must
  // evaluate provider quota first and only fall back to the transient branch —
  // see execute.ts (`!providerQuota` gates) and resolveTransientRetryNotBefore
  // (`providerQuota || transientUpstream`). Re-adding the guard flips the
  // classification of quota-shaped failures and breaks parse.test.ts.
  return CLAUDE_TRANSIENT_UPSTREAM_RE.test(haystack);
}

export function isClaudeProviderQuotaError(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const parsed = input.parsed ?? null;
  if (parsed && (isClaudeMaxTurnsResult(parsed) || isClaudeUnknownSessionError(parsed) || isClaudePoisonedPreviousMessageIdError(parsed) || isClaudeImageProcessingError(parsed))) {
    return false;
  }
  const loginMeta = detectClaudeLoginRequired({
    parsed,
    stdout: input.stdout ?? "",
    stderr: input.stderr ?? "",
  });
  if (loginMeta.requiresLogin) return false;

  const haystack = buildClaudeTransientHaystack(input);
  if (!haystack) return false;
  return CLAUDE_PROVIDER_QUOTA_RE.test(haystack);
}

// a reset-less account/org quota exhaustion (monthly spend limit,
// depleted credits) is a sub-class of transient-upstream — it is always also an
// `isClaudeTransientUpstreamError`, but the heartbeat treats it specially by
// handing the issue off immediately instead of retrying. Callers should gate on
// `transientUpstream === true` first; this only refines that classification.
export function isClaudeAccountQuotaExhausted(input: {
  parsed?: Record<string, unknown> | null;
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  // scan only the failure surface, never the full stdout transcript.
  // The quota wording collides with the harness command registry (`usage-credits`)
  // and with an agent's own prose, so matching it against the whole transcript
  // flagged every non-quota transient failure (measured 197/197 false positive on
  // DNS/connection errors). The genuine reset-less quota error always surfaces in
  // errorMessage / parsed.result / stderr, so excluding stdout loses no real signal.
  const haystack = buildClaudeTransientHaystack(input, { includeStreamTranscript: false });
  if (!haystack) return false;
  return CLAUDE_ACCOUNT_QUOTA_EXHAUSTED_RE.test(haystack);
}
