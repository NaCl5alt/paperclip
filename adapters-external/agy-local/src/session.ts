/**
 * Session codec for agy conversations.
 *
 * Paperclip persists whatever `sessionParams` the adapter returns and hands it
 * back on the next heartbeat. The stored shape is:
 *
 *   { conversationId: string, cwd: string, workspaceId?, repoUrl?, repoRef? }
 *
 * `cwd` is part of the identity because an agy conversation is bound to the
 * directory it was created in; resuming it elsewhere would give the model a
 * transcript describing files that are not there.
 */

import type { AdapterSessionCodec, AdapterSessionManagement } from "@paperclipai/adapter-utils";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read a conversation id out of stored params, tolerating both this adapter's
 * `conversationId` key and the generic `sessionId` key that older Paperclip
 * rows (and the legacy single-session view) use.
 */
function readConversationId(params: Record<string, unknown>): string {
  return asTrimmedString(params.conversationId) || asTrimmedString(params.sessionId);
}

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown): Record<string, unknown> | null {
    // A bare string is the legacy single-session representation.
    if (typeof raw === "string") {
      const conversationId = raw.trim();
      return conversationId.length > 0 ? { conversationId } : null;
    }
    const record = asRecord(raw);
    if (!record) return null;
    const conversationId = readConversationId(record);
    if (conversationId.length === 0) return null;
    const params: Record<string, unknown> = { conversationId };
    for (const key of ["cwd", "workspaceId", "repoUrl", "repoRef"]) {
      const value = asTrimmedString(record[key]);
      if (value.length > 0) params[key] = value;
    }
    return params;
  },

  serialize(params: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!params) return null;
    const conversationId = readConversationId(params);
    if (conversationId.length === 0) return null;
    const serialized: Record<string, unknown> = { conversationId };
    for (const key of ["cwd", "workspaceId", "repoUrl", "repoRef"]) {
      const value = asTrimmedString(params[key]);
      if (value.length > 0) serialized[key] = value;
    }
    return serialized;
  },

  getDisplayId(params: Record<string, unknown> | null): string | null {
    if (!params) return null;
    const conversationId = readConversationId(params);
    return conversationId.length > 0 ? conversationId : null;
  },
};

/**
 * agy resumes conversations natively but does not document an automatic
 * compaction strategy, so `nativeContextManagement` stays "unknown" and
 * Paperclip keeps its threshold-based session rotation active. These are the
 * same defaults Paperclip applies to the gemini_local lane this replaces.
 */
export const sessionManagement: AdapterSessionManagement = {
  supportsSessionResume: true,
  nativeContextManagement: "unknown",
  defaultSessionCompaction: {
    enabled: true,
    maxSessionRuns: 200,
    maxRawInputTokens: 2_000_000,
    maxSessionAgeHours: 72,
  },
};
