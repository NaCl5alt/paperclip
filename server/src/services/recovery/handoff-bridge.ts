import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Redactor applied to handoff bodies before they are persisted. Injected by the
 * caller (the recovery service passes `redactSensitiveText`) rather than
 * imported here: that keeps this module's graph free of the heavy
 * `@paperclipai/adapter-utils` barrel and makes the unit tests hermetic.
 */
export type Redactor = (input: string) => string;

/**
 * Resolve the Claude Code config dir. Mirrors `claudeConfigDir()` in
 * `@paperclipai/adapter-claude-local/server` (quota.ts) — inlined so the
 * recovery hot path does not pull the adapter's heavy execute/pty module graph
 * just to read a directory. Keep in sync with that source of truth.
 */
function claudeConfigDir(): string {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv.trim().length > 0) return fromEnv.trim();
  return path.join(os.homedir(), ".claude");
}

/**
 * Document key for the cross-adapter context handoff attached to a failover
 * recovery issue. The codex recovery owner is directed to read it first.
 */
export const HANDOFF_DOCUMENT_KEY = "handoff";
export const HANDOFF_DOCUMENT_TITLE = "Context handoff";

/** issue document body hard cap (`upsertIssueDocumentSchema`, 512KB). */
export const HANDOFF_MAX_BYTES = 512 * 1024;
/** keep a generous margin below the hard cap for headers/redaction growth. */
const HANDOFF_BODY_BUDGET_BYTES = 480 * 1024;
const DEFAULT_RECENT_TURNS = 20;
const MAX_TOOL_BLOCK_CHARS = 1_200;

type TranscriptTurn = {
  role: "user" | "assistant" | "system" | "tool" | "other";
  text: string;
};

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/**
 * Render a single Claude session JSONL content payload (string or block array)
 * into readable text. Tool calls/results are summarized and truncated.
 */
function renderContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      parts.push(entry);
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const block = entry as Record<string, unknown>;
    const type = asString(block.type);
    if (type === "text") {
      const text = asString(block.text).trim();
      if (text) parts.push(text);
    } else if (type === "tool_use") {
      const name = asString(block.name) || "tool";
      const input = block.input === undefined ? "" : truncate(JSON.stringify(block.input), MAX_TOOL_BLOCK_CHARS);
      parts.push(`↳ tool_use(${name}): ${input}`);
    } else if (type === "tool_result") {
      const resultText = typeof block.content === "string"
        ? block.content
        : JSON.stringify(block.content ?? "");
      parts.push(`↳ tool_result: ${truncate(resultText, MAX_TOOL_BLOCK_CHARS)}`);
    } else if (type === "thinking") {
      // Drop reasoning blocks: not replayable cross-adapter and noisy.
      continue;
    }
  }
  return parts.join("\n").trim();
}

/**
 * Parse a Claude Code session transcript (line-delimited JSON) into ordered
 * readable turns. Defensive against malformed lines and schema drift.
 */
export function parseClaudeSessionTranscript(jsonl: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = asString(event.type);
    if (type === "summary") {
      const text = asString(event.summary).trim();
      if (text) turns.push({ role: "system", text: `(prior summary) ${text}` });
      continue;
    }
    const message = (event.message && typeof event.message === "object")
      ? (event.message as Record<string, unknown>)
      : null;
    const role = asString(message?.role) || (type === "user" || type === "assistant" ? type : "");
    const text = renderContent(message?.content);
    if (!text) continue;
    const normalizedRole: TranscriptTurn["role"] =
      role === "user" || role === "assistant" || role === "system" ? role : "other";
    turns.push({ role: normalizedRole, text });
  }
  return turns;
}

function renderTurn(turn: TranscriptTurn): string {
  const label = turn.role === "user"
    ? "User"
    : turn.role === "assistant"
      ? "Assistant"
      : turn.role === "system"
        ? "System"
        : "Other";
  return `### ${label}\n\n${turn.text}`;
}

/**
 * Build the markdown body for a context handoff from parsed turns. Keeps the
 * most recent `recentTurns` turns in full and summarizes older turns to a
 * single count line, then enforces the body byte budget by dropping the oldest
 * full turns first. Sensitive text is redacted.
 */
export function renderHandoffMarkdown(input: {
  turns: TranscriptTurn[];
  header: string;
  redact: Redactor;
  recentTurns?: number;
  maxBytes?: number;
}): string {
  const recentTurns = input.recentTurns ?? DEFAULT_RECENT_TURNS;
  const maxBytes = input.maxBytes ?? HANDOFF_BODY_BUDGET_BYTES;
  const total = input.turns.length;
  let recent = input.turns.slice(Math.max(0, total - recentTurns));
  let older = total - recent.length;

  const assemble = () => {
    const sections: string[] = [input.header];
    if (older > 0) {
      sections.push(`> Earlier context: ${older} earlier turn(s) omitted; full text below covers the most recent ${recent.length}.`);
    }
    sections.push("## Recent transcript\n");
    for (const turn of recent) sections.push(renderTurn(turn));
    return input.redact(sections.join("\n\n"));
  };

  let body = assemble();
  // Enforce byte budget: drop the oldest full turn (counting it as summarized).
  while (byteLength(body) > maxBytes && recent.length > 1) {
    recent = recent.slice(1);
    older += 1;
    body = assemble();
  }
  if (byteLength(body) > maxBytes) {
    body = `${body.slice(0, maxBytes)}\n\n… [handoff truncated to fit document size limit]`;
  }
  return body;
}

async function findSessionFile(rootDir: string, sessionId: string, maxDepth = 6): Promise<string | null> {
  const target = `${sessionId}.jsonl`;
  async function search(dirPath: string, depth: number): Promise<string | null> {
    const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isFile() && entry.name === target) return path.join(dirPath, entry.name);
    }
    if (depth >= maxDepth) return null;
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const found = await search(path.join(dirPath, entry.name), depth + 1);
      if (found) return found;
    }
    return null;
  }
  return search(rootDir, 0);
}

/**
 * Resolve and read a stopped claude run's session transcript from the local
 * `~/.claude/projects/**` tree. Returns null when not found locally (e.g. the
 * run executed on a remote target whose transcript lives on the remote host).
 */
export async function resolveLocalClaudeTranscript(sessionId: string): Promise<string | null> {
  const projectsRoot = path.join(claudeConfigDir(), "projects");
  const file = await findSessionFile(projectsRoot, sessionId);
  if (!file) return null;
  return readFile(file, "utf8").catch(() => null);
}

export type HandoffCaptureResult = {
  captured: boolean;
  body: string;
  note: string;
};

/**
 * Build a handoff document body for a failover recovery issue. Captures the
 * stopped claude run's session transcript (recent turns full + older
 * summarized). When the transcript cannot be resolved locally (remote target),
 * returns a graceful degraded body explaining the gap rather than failing.
 *
 * The transcript reader is injectable for testing.
 */
export async function buildHandoffDocument(input: {
  sessionId: string | null;
  strandedAgentName: string;
  strandedAdapterType: string;
  fallbackAdapterType: string;
  sourceIssueLink: string;
  runLink: string;
  redact: Redactor;
  recentTurns?: number;
  maxBytes?: number;
  readTranscript?: (sessionId: string) => Promise<string | null>;
}): Promise<HandoffCaptureResult> {
  const read = input.readTranscript ?? resolveLocalClaudeTranscript;
  const guidance = [
    "# Context handoff",
    "",
    "**Read this before doing anything else.** The previous run hit a transient upstream usage/rate-limit failure and work was failed over to a different adapter to preserve momentum.",
    "",
    `- Source issue: ${input.sourceIssueLink}`,
    `- Stopped run: ${input.runLink}`,
    `- Original adapter: \`${input.strandedAdapterType}\` (agent: ${input.strandedAgentName})`,
    `- Recovery adapter: \`${input.fallbackAdapterType}\``,
    "",
    "Native session resume is impossible across adapters; this document reconstructs the prior conversation context so you can continue without re-deriving it. Tool calls are summarized and reasoning blocks are dropped (not replayable cross-adapter).",
  ].join("\n");

  if (!input.sessionId) {
    return {
      captured: false,
      body: `${guidance}\n\n## Recent transcript\n\n_No session id was recorded for the stopped run, so its transcript could not be captured. Rebuild context from the source issue and its comments/documents._`,
      note: "handoff_no_session_id",
    };
  }

  const jsonl = await read(input.sessionId).catch(() => null);
  if (!jsonl) {
    return {
      captured: false,
      body: `${guidance}\n\n## Recent transcript\n\n_The stopped run's session transcript (\`${input.sessionId}\`) was not resolvable on this host. This typically means the run executed on a remote target whose transcript lives remotely. Rebuild context from the source issue and its comments/documents._`,
      note: "handoff_transcript_unavailable",
    };
  }

  const turns = parseClaudeSessionTranscript(jsonl);
  if (turns.length === 0) {
    return {
      captured: false,
      body: `${guidance}\n\n## Recent transcript\n\n_The session transcript was found but contained no readable turns._`,
      note: "handoff_empty_transcript",
    };
  }

  const body = renderHandoffMarkdown({
    turns,
    header: guidance,
    redact: input.redact,
    recentTurns: input.recentTurns,
    maxBytes: input.maxBytes,
  });
  return { captured: true, body, note: "handoff_captured" };
}
