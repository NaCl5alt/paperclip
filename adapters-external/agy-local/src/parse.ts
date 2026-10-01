/**
 * Parser for the `agy --output-format stream-json` NDJSON stream.
 *
 * The Antigravity CLI emits one JSON object per line with a top-level `event`
 * discriminator. Three events matter to Paperclip:
 *
 *   {"event":"init","conversation_id":"…","init":{"cwd":…,"tools":[…],"permission_mode":…}}
 *   {"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE"|"DONE",
 *      "step_type":"user_input"|"agent_response"|"tool","text_delta":"…",
 *      "tool_name":"…","tool_info":{…},"duration_seconds":…,"usage":{…}}}
 *   {"event":"result","result":{"status":"SUCCESS","response":"…","num_turns":1,"usage":{…}}}
 *
 * `usage` on the `result` event is the total for the whole invocation (agy sums
 * the per-step usage), which is why the adapter reports `usageBasis: "per_run"`.
 */

import type { UsageSummary } from "@paperclipai/adapter-utils";

/** A tool the model invoked during the run, reconstructed from paired step_update events. */
export interface AgyToolInvocation {
  stepIndex: number;
  name: string;
  parameters: Record<string, unknown> | null;
  output: string | null;
  durationSeconds: number | null;
  completed: boolean;
  isError: boolean;
}

export interface AgyParsedStream {
  /** agy's conversation id — the resume handle, passed back via --conversation. */
  conversationId: string | null;
  /** Terminal status string from the result event, e.g. "SUCCESS". */
  status: string | null;
  /** Final assistant response text from the result event. */
  response: string | null;
  usage: UsageSummary | undefined;
  /** Reasoning tokens, reported separately by agy and folded into output tokens. */
  thinkingTokens: number | null;
  numTurns: number | null;
  durationSeconds: number | null;
  /** Raw result payload, surfaced to Paperclip as resultJson. */
  resultEvent: Record<string, unknown> | null;
  errorMessage: string | null;
  summary: string | null;
  tools: AgyToolInvocation[];
  /** Tool names agy advertised in the init event. */
  availableTools: string[];
  permissionMode: string | null;
  /** Concatenated assistant text deltas — a fallback when result.response is absent. */
  assistantText: string;
  /** Lines that were not parseable JSON objects. A non-zero count is a protocol drift signal. */
  malformedLines: number;
}

const AGY_SUCCESS_STATUS = "SUCCESS";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readUsage(value: unknown): { usage: UsageSummary; thinkingTokens: number | null } | null {
  const raw = asRecord(value);
  if (!raw) return null;
  const inputTokens = asFiniteNumber(raw.input_tokens) ?? 0;
  const outputTokens = asFiniteNumber(raw.output_tokens) ?? 0;
  const cachedInputTokens = asFiniteNumber(raw.cache_read_tokens);
  const thinkingTokens = asFiniteNumber(raw.thinking_tokens);
  const usage: UsageSummary = { inputTokens, outputTokens };
  if (cachedInputTokens !== null) usage.cachedInputTokens = cachedInputTokens;
  return { usage, thinkingTokens };
}

/**
 * Pull an error string out of a result payload. agy has not been observed
 * emitting a non-SUCCESS result, so this reads the plausible field names rather
 * than committing to one shape.
 */
function readResultError(result: Record<string, unknown>): string | null {
  for (const key of ["error", "error_message", "errorMessage", "message", "detail"]) {
    const found = asTrimmedString(result[key]);
    if (found) return found;
  }
  const nested = asRecord(result.error);
  if (nested) {
    for (const key of ["message", "detail", "description"]) {
      const found = asTrimmedString(nested[key]);
      if (found) return found;
    }
  }
  return null;
}

function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? null;
}

export function parseAgyJsonl(stdout: string): AgyParsedStream {
  const parsed: AgyParsedStream = {
    conversationId: null,
    status: null,
    response: null,
    usage: undefined,
    thinkingTokens: null,
    numTurns: null,
    durationSeconds: null,
    resultEvent: null,
    errorMessage: null,
    summary: null,
    tools: [],
    availableTools: [],
    permissionMode: null,
    assistantText: "",
    malformedLines: 0,
  };

  // Tools are reported twice (ACTIVE then DONE) keyed by step_index, so
  // in-progress calls can be upgraded in place instead of duplicated.
  const toolsByStep = new Map<number, AgyToolInvocation>();
  let lastStepUsage: { usage: UsageSummary; thinkingTokens: number | null } | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (!line.startsWith("{")) continue;

    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(line));
    } catch {
      parsed.malformedLines += 1;
      continue;
    }
    if (!event) {
      parsed.malformedLines += 1;
      continue;
    }

    const kind = asTrimmedString(event.event);

    if (kind === "init") {
      parsed.conversationId = asTrimmedString(event.conversation_id) ?? parsed.conversationId;
      const init = asRecord(event.init);
      if (init) {
        if (Array.isArray(init.tools)) {
          parsed.availableTools = init.tools.filter(
            (value): value is string => typeof value === "string",
          );
        }
        parsed.permissionMode = asTrimmedString(init.permission_mode) ?? parsed.permissionMode;
      }
      continue;
    }

    if (kind === "step_update") {
      const step = asRecord(event.step_update);
      if (!step) continue;
      parsed.conversationId = asTrimmedString(step.conversation_id) ?? parsed.conversationId;

      const stepUsage = readUsage(step.usage);
      if (stepUsage) lastStepUsage = stepUsage;

      const stepType = asTrimmedString(step.step_type);
      const state = asTrimmedString(step.state);

      if (stepType === "agent_response") {
        // text_delta is a true incremental chunk: concatenating every delta in
        // order reconstructs the assistant message.
        if (typeof step.text_delta === "string") parsed.assistantText += step.text_delta;
        continue;
      }

      if (stepType === "tool") {
        const stepIndex = asFiniteNumber(step.step_index);
        if (stepIndex === null) continue;
        const toolInfo = asRecord(step.tool_info);
        const name =
          asTrimmedString(step.tool_name) ??
          (toolInfo ? asTrimmedString(toolInfo.name) : null) ??
          "tool";
        const existing = toolsByStep.get(stepIndex);
        const invocation: AgyToolInvocation = existing ?? {
          stepIndex,
          name,
          parameters: null,
          output: null,
          durationSeconds: null,
          completed: false,
          isError: false,
        };
        invocation.name = name;
        if (toolInfo) {
          const parameters = asRecord(toolInfo.parameters);
          if (parameters) invocation.parameters = parameters;
          const output = asTrimmedString(toolInfo.output);
          if (output) invocation.output = output;
          if (toolInfo.error !== undefined && toolInfo.error !== null) invocation.isError = true;
        }
        const duration = asFiniteNumber(step.duration_seconds);
        if (duration !== null) invocation.durationSeconds = duration;
        if (state === "DONE") invocation.completed = true;
        toolsByStep.set(stepIndex, invocation);
      }
      continue;
    }

    if (kind === "result") {
      const result = asRecord(event.result);
      if (!result) continue;
      parsed.resultEvent = result;
      parsed.conversationId = asTrimmedString(result.conversation_id) ?? parsed.conversationId;
      parsed.status = asTrimmedString(result.status) ?? parsed.status;
      parsed.response = typeof result.response === "string" ? result.response : parsed.response;
      parsed.numTurns = asFiniteNumber(result.num_turns) ?? parsed.numTurns;
      parsed.durationSeconds = asFiniteNumber(result.duration_seconds) ?? parsed.durationSeconds;
      const resultUsage = readUsage(result.usage);
      if (resultUsage) {
        parsed.usage = resultUsage.usage;
        parsed.thinkingTokens = resultUsage.thinkingTokens;
      }
      const resultError = readResultError(result);
      if (resultError) parsed.errorMessage = resultError;
      continue;
    }
  }

  parsed.tools = [...toolsByStep.values()].sort((a, b) => a.stepIndex - b.stepIndex);

  // Fall back to the last step's usage when the run died before emitting a
  // result event, so a crashed run still bills the tokens it consumed.
  if (!parsed.usage && lastStepUsage) {
    parsed.usage = lastStepUsage.usage;
    parsed.thinkingTokens = lastStepUsage.thinkingTokens;
  }

  const responseText = parsed.response ?? parsed.assistantText;
  parsed.summary = firstLine(responseText);

  if (!parsed.errorMessage && parsed.status !== null && parsed.status !== AGY_SUCCESS_STATUS) {
    parsed.errorMessage = `agy finished with status ${parsed.status}`;
  }

  return parsed;
}

/** True when the run reached a result event that reported success. */
export function isAgySuccessResult(parsed: AgyParsedStream): boolean {
  return parsed.status === AGY_SUCCESS_STATUS;
}

const AUTH_PATTERNS: RegExp[] = [
  /not\s+(?:logged\s?in|authenticated|signed\s?in)/i,
  /please\s+(?:log|sign)\s?in/i,
  /authentication\s+(?:required|failed|error)/i,
  /\bunauthenticated\b/i,
  /\bunauthorized\b/i,
  /credentials?\s+(?:not\s+found|missing|expired|invalid)/i,
  /(?:run|use)\s+`?agy\s+(?:login|auth)/i,
  /\b401\b/,
];

const QUOTA_PATTERNS: RegExp[] = [
  /\bquota\s+(?:exceeded|exhausted)/i,
  /\brate\s?limit(?:ed|s)?\b/i,
  /resource[_\s]exhausted/i,
  /too\s+many\s+requests/i,
  /\b429\b/,
];

const TRANSIENT_PATTERNS: RegExp[] = [
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE)\b/,
  /socket\s+hang\s?up/i,
  /network\s+(?:is\s+)?(?:unreachable|error|unavailable)/i,
  /temporarily\s+unavailable/i,
  /connection\s+(?:reset|refused|closed|timed\s?out)/i,
  /\b50[234]\b/,
  /\bUNAVAILABLE\b/,
  /\bDEADLINE_EXCEEDED\b/,
];

const SESSION_UNRECOVERABLE_PATTERNS: RegExp[] = [
  /conversation[^\n]{0,80}not\s+found/i,
  /(?:unknown|invalid|missing|expired)\s+conversation/i,
  /no\s+such\s+conversation/i,
  /conversation[_\s]not[_\s]found/i,
  /failed\s+to\s+(?:load|resume|open)\s+conversation/i,
];

function matchesAny(patterns: RegExp[], ...texts: Array<string | null | undefined>): boolean {
  for (const text of texts) {
    if (!text) continue;
    for (const pattern of patterns) {
      if (pattern.test(text)) return true;
    }
  }
  return false;
}

/**
 * Detect that agy needs an interactive login. Paperclip surfaces this as a
 * distinct error code so the operator sees "authenticate", not "unknown crash".
 */
export function detectAgyAuthRequired(input: {
  stdout?: string | null;
  stderr?: string | null;
  parsed?: AgyParsedStream | null;
}): { requiresAuth: boolean } {
  const resultError = input.parsed?.errorMessage ?? null;
  return {
    requiresAuth: matchesAny(AUTH_PATTERNS, input.stdout, input.stderr, resultError),
  };
}

export function detectAgyQuotaExhausted(input: {
  stdout?: string | null;
  stderr?: string | null;
  parsed?: AgyParsedStream | null;
}): boolean {
  const resultError = input.parsed?.errorMessage ?? null;
  return matchesAny(QUOTA_PATTERNS, input.stdout, input.stderr, resultError);
}

export function isAgyTransientNetworkError(
  stdout?: string | null,
  stderr?: string | null,
): boolean {
  return matchesAny(TRANSIENT_PATTERNS, stdout, stderr);
}

/**
 * True when a resume attempt failed because the conversation is gone. The
 * adapter retries once with a fresh conversation on this signal.
 */
export function isAgySessionUnrecoverableError(
  stdout?: string | null,
  stderr?: string | null,
): boolean {
  return matchesAny(SESSION_UNRECOVERABLE_PATTERNS, stdout, stderr);
}

/** Human-readable failure line for a non-success result event. */
export function describeAgyFailure(parsed: AgyParsedStream): string | null {
  if (parsed.errorMessage) return parsed.errorMessage;
  if (parsed.status !== null && parsed.status !== AGY_SUCCESS_STATUS) {
    return `agy finished with status ${parsed.status}`;
  }
  return null;
}
