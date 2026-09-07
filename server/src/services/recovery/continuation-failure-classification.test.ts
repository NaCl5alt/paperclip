import { describe, expect, it } from "vitest";
import { classifyContinuationFailure } from "./service.js";

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
