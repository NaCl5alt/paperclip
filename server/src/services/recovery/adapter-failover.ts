import type { agents, heartbeatRuns } from "@paperclipai/db";
import { parseObject } from "../../adapters/utils.js";

/**
 * Agent-scoped config key naming the agent that should own recovery when the
 * stranded run failed on a transient upstream (usage / rate-limit) condition.
 * Stored on `agents.adapter_config`. Unset means full backward-compatible
 * fallthrough to the legacy manager/creator/executive owner selection.
 */
export const RECOVERY_FALLBACK_AGENT_CONFIG_KEY = "recoveryFallbackAgentId";

/**
 * Adapter type that a failover routes work to. Today this is fixed to
 * `codex_local` per the approved recovery-failover design; it also doubles as
 * the loop-guard marker (a run already on this adapter must not failover again).
 */
export const FAILOVER_FALLBACK_ADAPTER_TYPE = "codex_local" as const;

type AgentRow = typeof agents.$inferSelect;
type FailoverRunRow = Pick<typeof heartbeatRuns.$inferSelect, "errorCode" | "resultJson">;

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * Resolve the configured failover fallback agent id for a stranded agent.
 *
 * Scope is agent-only today (`adapter_config.recoveryFallbackAgentId`). The
 * resolver is the single seam intended to grow into project/company scope: a
 * future change threads project/company config here and returns the most
 * specific configured value, leaving every caller untouched.
 */
export function resolveRecoveryFallbackAgentId(strandedAgent: AgentRow | null | undefined): string | null {
  if (!strandedAgent) return null;
  const config = parseObject(strandedAgent.adapterConfig);
  return readNonEmptyString(config[RECOVERY_FALLBACK_AGENT_CONFIG_KEY]);
}

/**
 * True when a stranded run failed on a transient upstream usage / rate-limit
 * condition. Mirrors `readHeartbeatRunErrorFamily` in heartbeat.ts: prefer the
 * persisted `resultJson.errorFamily`, else fall back to the adapter error code.
 */
export function isTransientUpstreamFailure(run: FailoverRunRow | null | undefined): boolean {
  if (!run) return false;
  const resultJson = parseObject(run.resultJson);
  const persistedFamily = readNonEmptyString(resultJson.errorFamily);
  if (persistedFamily) return persistedFamily === "transient_upstream";
  return run.errorCode === "codex_transient_upstream" || run.errorCode === "claude_transient_upstream";
}

export type FailoverDecisionReason =
  | "not_transient"
  | "no_fallback_configured"
  | "self_failover"
  | "loop_guard"
  | "fallback_unavailable";

export type FailoverDecision =
  | { failover: true; fallbackAgentId: string; fallbackAdapterType: string }
  | { failover: false; reason: FailoverDecisionReason };

/**
 * Decide whether recovery ownership should fail over to the configured codex
 * fallback agent instead of the legacy owner selection.
 *
 * Failover requires ALL of:
 *  - the stranded run was a transient upstream failure;
 *  - the stranded agent has `recoveryFallbackAgentId` configured;
 *  - the fallback is not the stranded agent itself;
 *  - the stranded run is NOT already on the fallback adapter (codex→codex loop
 *    guard — escalate to the management line instead);
 *  - the resolved fallback agent exists and is invokable.
 *
 * Any unmet condition returns `{ failover: false }` so the caller falls through
 * to the existing manager/creator/executive selection (full backward compat).
 */
export function decideRecoveryFailover(input: {
  transient: boolean;
  strandedAgent: AgentRow | null | undefined;
  fallbackAgent: AgentRow | null | undefined;
  fallbackAgentInvokable: boolean;
}): FailoverDecision {
  if (!input.transient) return { failover: false, reason: "not_transient" };

  const fallbackId = resolveRecoveryFallbackAgentId(input.strandedAgent);
  if (!fallbackId) return { failover: false, reason: "no_fallback_configured" };

  if (input.strandedAgent && fallbackId === input.strandedAgent.id) {
    return { failover: false, reason: "self_failover" };
  }

  // Loop guard: a run already executing on the fallback adapter (codex) must
  // not failover to codex again. Hand back to the management escalation line.
  if (input.strandedAgent?.adapterType === FAILOVER_FALLBACK_ADAPTER_TYPE) {
    return { failover: false, reason: "loop_guard" };
  }

  if (!input.fallbackAgent || input.fallbackAgent.id !== fallbackId || !input.fallbackAgentInvokable) {
    return { failover: false, reason: "fallback_unavailable" };
  }

  return {
    failover: true,
    fallbackAgentId: input.fallbackAgent.id,
    fallbackAdapterType: input.fallbackAgent.adapterType,
  };
}
