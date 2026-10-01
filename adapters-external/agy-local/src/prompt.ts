/**
 * Prompt assembly for an agy run.
 *
 * The section order mirrors the first-party local adapters so an agent behaves
 * the same whichever harness runs it:
 *
 *   instructions → bootstrap (new conversation only) → wake payload →
 *   session handoff → runtime env note → API access note → heartbeat prompt
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  asString,
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  isPaperclipRecoveryWakePayload,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
} from "@paperclipai/adapter-utils/server-utils";

export interface BuildPromptInput {
  config: Record<string, unknown>;
  context: Record<string, unknown>;
  env: Record<string, string>;
  agent: { id: string; companyId: string };
  runId: string;
  /** The conversation being resumed, or null for a fresh conversation. */
  conversationId: string | null;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface BuiltPrompt {
  prompt: string;
  promptMetrics: Record<string, number>;
  /** Operator-facing notes about what went into the prompt. */
  notes: string[];
}

/**
 * Tell the model which PAPERCLIP_* variables it can actually use. Without this
 * the agent has to guess whether control-plane access exists in this run.
 */
function renderPaperclipEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env)
    .filter((key) => key.startsWith("PAPERCLIP_"))
    .sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${keys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
  ].join("\n");
}

/** Spell out the curl recipe for the control plane, including base-URL normalization. */
function renderApiAccessNote(env: Record<string, string>): string {
  if (!env.PAPERCLIP_API_URL || !env.PAPERCLIP_API_KEY) return "";
  return [
    "Paperclip API access note:",
    "Use terminal commands with curl to make Paperclip API requests.",
    "Normalize the base URL before adding API paths:",
    '  PAPERCLIP_API_BASE="${PAPERCLIP_API_URL%/}"; PAPERCLIP_API_BASE="${PAPERCLIP_API_BASE%/api}"',
    "GET example:",
    '  curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" "$PAPERCLIP_API_BASE/api/agents/me"',
    "Scoped issue comment example:",
    '  curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "Content-Type: application/json"' +
      ' -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" -d \'{"body":"Status update from agent."}\'' +
      ' "$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments"',
  ].join("\n");
}

export async function buildAgyPrompt(input: BuildPromptInput): Promise<BuiltPrompt> {
  const { config, context, env, agent, runId, conversationId, onLog } = input;
  const notes: string[] = [];

  const instructionsFilePath = asString(config.instructionsFilePath, "").trim();
  let instructionsPrefix = "";
  if (instructionsFilePath) {
    const instructionsDir = `${path.dirname(instructionsFilePath)}/`;
    try {
      const contents = await fs.readFile(instructionsFilePath, "utf8");
      instructionsPrefix =
        `${contents}\n\n` +
        `The above agent instructions were loaded from ${instructionsFilePath}. ` +
        `Resolve any relative file references from ${instructionsDir}.\n\n`;
      notes.push(
        `Loaded agent instructions from ${instructionsFilePath}`,
        `Prepended instructions + path directive to prompt (relative references from ${instructionsDir}).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await onLog(
        "stdout",
        `[paperclip] Warning: could not read agent instructions file "${instructionsFilePath}": ${reason}\n`,
      );
      notes.push(
        `Configured instructionsFilePath ${instructionsFilePath}, but the file could not be read; continuing without injected instructions.`,
      );
    }
  }

  const templateData = {
    agentId: agent.id,
    companyId: agent.companyId,
    runId,
    company: { id: agent.companyId },
    agent,
    run: { id: runId, source: "on_demand" },
    context,
  };

  const bootstrapPromptTemplate = asString(config.bootstrapPromptTemplate, "");
  const renderedBootstrapPrompt =
    !conversationId && bootstrapPromptTemplate.trim().length > 0
      ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
      : "";

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, {
    resumedSession: Boolean(conversationId),
  });

  // On a resumed conversation the wake payload is the whole delta — repeating
  // the full heartbeat template would re-send context agy already has. Recovery
  // wakes likewise carry their own instructions.
  const promptTemplate = asString(config.promptTemplate, DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE);
  const suppressHeartbeatTemplate =
    (Boolean(conversationId) && wakePrompt.length > 0) ||
    isPaperclipRecoveryWakePayload(context.paperclipWake);
  const renderedPrompt = suppressHeartbeatTemplate
    ? ""
    : renderTemplate(promptTemplate, templateData);

  const sessionHandoffNote = asString(context.paperclipSessionHandoffMarkdown, "").trim();
  const paperclipEnvNote = renderPaperclipEnvNote(env);
  const apiAccessNote = renderApiAccessNote(env);

  const prompt = joinPromptSections([
    instructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    paperclipEnvNote,
    apiAccessNote,
    renderedPrompt,
  ]);

  return {
    prompt,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: instructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      runtimeNoteChars: paperclipEnvNote.length + apiAccessNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
    notes,
  };
}
