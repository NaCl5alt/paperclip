import { describe, expect, it } from "vitest";
import { classifyContinuationFailure, isAdapterFailureErrorCode } from "./service.js";

function continuationRun(errorCode: string | null) {
  return {
    id: "run-1",
    agentId: "agent-1",
    status: "failed",
    error: null,
    errorCode,
    contextSnapshot: null,
    livenessState: null,
  };
}

describe("classifyContinuationFailure — deterministic credential failures (VANA-4048)", () => {
  it.each(["claude_auth_required", "acpx_auth_required", "gemini_auth_required"])(
    "treats %s as non-retryable so the issue escalates instead of retrying",
    (errorCode) => {
      const classification = classifyContinuationFailure(continuationRun(errorCode));
      expect(classification.kind).toBe("non_retryable");
      expect(classification.maxAttempts).toBe(0);
      expect(classification.errorCode).toBe(errorCode);
    },
  );

  it("keeps true transient infra failures retryable", () => {
    expect(classifyContinuationFailure(continuationRun("claude_transient_upstream")).kind)
      .toBe("transient_infra");
    expect(classifyContinuationFailure(continuationRun("adapter_failed")).kind)
      .toBe("transient_infra");
  });
});

describe("classifyContinuationFailure — fail-closed shared checkout (VANA-4055 / VANA-4067)", () => {
  const code = "shared_workspace_isolation_failed";

  it("retries a contended checkout with the transient-infra budget", () => {
    // Contention resolves on its own: the run holding the directory finishes,
    // and the next attempt either takes the claim or isolates cleanly.
    const classification = classifyContinuationFailure(continuationRun(code));
    expect(classification.kind).toBe("transient_infra");
    expect(classification.maxAttempts).toBeGreaterThan(0);
  });

  it("does not treat it as an adapter fault, so recovery keeps the issue on its adapter", () => {
    // The consequence of the code it used to collapse onto. `adapter_failed`
    // makes recovery pick an owner on a *different* adapter, which does not
    // free the directory and is not undone once the directory frees.
    expect(isAdapterFailureErrorCode(code)).toBe(false);
    expect(isAdapterFailureErrorCode("adapter_failed")).toBe(true);
  });
});
