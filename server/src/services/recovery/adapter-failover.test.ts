import { describe, expect, it } from "vitest";
import {
  FAILOVER_FALLBACK_ADAPTER_TYPE,
  decideRecoveryFailover,
  isTransientUpstreamFailure,
  resolveRecoveryFallbackAgentId,
} from "./adapter-failover.js";

type AgentLike = {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
};

function agent(overrides: Partial<AgentLike> & { id: string }): AgentLike {
  return {
    companyId: "co-1",
    adapterType: "claude_local",
    adapterConfig: {},
    ...overrides,
  };
}

// Cast helper: production signatures take the full drizzle row but only read a
// few fields; tests provide just those.
const asAgent = (a: AgentLike) => a as never;
const asRun = (r: { errorCode?: string | null; resultJson?: unknown }) => r as never;

describe("resolveRecoveryFallbackAgentId", () => {
  it("returns the configured fallback agent id", () => {
    const a = agent({ id: "claude-1", adapterConfig: { recoveryFallbackAgentId: "codex-1" } });
    expect(resolveRecoveryFallbackAgentId(asAgent(a))).toBe("codex-1");
  });

  it("returns null when unset or blank (backward compatible)", () => {
    expect(resolveRecoveryFallbackAgentId(asAgent(agent({ id: "claude-1" })))).toBeNull();
    expect(
      resolveRecoveryFallbackAgentId(asAgent(agent({ id: "x", adapterConfig: { recoveryFallbackAgentId: "  " } }))),
    ).toBeNull();
    expect(resolveRecoveryFallbackAgentId(null)).toBeNull();
  });
});

describe("isTransientUpstreamFailure", () => {
  it("detects via persisted errorFamily", () => {
    expect(isTransientUpstreamFailure(asRun({ resultJson: { errorFamily: "transient_upstream" } }))).toBe(true);
    expect(isTransientUpstreamFailure(asRun({ resultJson: { errorFamily: "fatal" } }))).toBe(false);
  });

  it("detects via adapter error code", () => {
    expect(isTransientUpstreamFailure(asRun({ errorCode: "claude_transient_upstream" }))).toBe(true);
    expect(isTransientUpstreamFailure(asRun({ errorCode: "codex_transient_upstream" }))).toBe(true);
    expect(isTransientUpstreamFailure(asRun({ errorCode: "some_other_error" }))).toBe(false);
  });

  it("returns false for null run", () => {
    expect(isTransientUpstreamFailure(null)).toBe(false);
  });
});

describe("decideRecoveryFailover", () => {
  const claude = agent({ id: "claude-1", adapterConfig: { recoveryFallbackAgentId: "codex-1" } });
  const codex = agent({ id: "codex-1", adapterType: FAILOVER_FALLBACK_ADAPTER_TYPE });

  it("fails over when transient + configured + fallback invokable", () => {
    const decision = decideRecoveryFailover({
      transient: true,
      strandedAgent: asAgent(claude),
      fallbackAgent: asAgent(codex),
      fallbackAgentInvokable: true,
    });
    expect(decision).toEqual({
      failover: true,
      fallbackAgentId: "codex-1",
      fallbackAdapterType: FAILOVER_FALLBACK_ADAPTER_TYPE,
    });
  });

  it("does not fail over when not transient (regression / legacy selection)", () => {
    const decision = decideRecoveryFailover({
      transient: false,
      strandedAgent: asAgent(claude),
      fallbackAgent: asAgent(codex),
      fallbackAgentInvokable: true,
    });
    expect(decision).toEqual({ failover: false, reason: "not_transient" });
  });

  it("does not fail over when no fallback configured", () => {
    const decision = decideRecoveryFailover({
      transient: true,
      strandedAgent: asAgent(agent({ id: "claude-1" })),
      fallbackAgent: asAgent(codex),
      fallbackAgentInvokable: true,
    });
    expect(decision).toEqual({ failover: false, reason: "no_fallback_configured" });
  });

  it("suppresses codex→codex re-failover via loop guard", () => {
    const strandedCodex = agent({
      id: "codex-stranded",
      adapterType: FAILOVER_FALLBACK_ADAPTER_TYPE,
      adapterConfig: { recoveryFallbackAgentId: "codex-1" },
    });
    const decision = decideRecoveryFailover({
      transient: true,
      strandedAgent: asAgent(strandedCodex),
      fallbackAgent: asAgent(codex),
      fallbackAgentInvokable: true,
    });
    expect(decision).toEqual({ failover: false, reason: "loop_guard" });
  });

  it("does not fail over to itself", () => {
    const selfRef = agent({ id: "claude-1", adapterConfig: { recoveryFallbackAgentId: "claude-1" } });
    const decision = decideRecoveryFailover({
      transient: true,
      strandedAgent: asAgent(selfRef),
      fallbackAgent: asAgent(selfRef),
      fallbackAgentInvokable: true,
    });
    expect(decision).toEqual({ failover: false, reason: "self_failover" });
  });

  it("falls through when fallback is unavailable", () => {
    const decision = decideRecoveryFailover({
      transient: true,
      strandedAgent: asAgent(claude),
      fallbackAgent: asAgent(codex),
      fallbackAgentInvokable: false,
    });
    expect(decision).toEqual({ failover: false, reason: "fallback_unavailable" });
  });
});
