import { describe, expect, it } from "vitest";
import {
  recoveryAssigneeAdapterOverrides,
  scrubRecoveryModelProfileHints,
  withRecoveryModelProfileHint,
} from "./model-profile-hint.js";

describe("recovery model profile policy", () => {
  it("allows cheap only for status-only recovery and adds guard context", () => {
    expect(withRecoveryModelProfileHint({ issueId: "issue-1" }, "status_only")).toEqual({
      issueId: "issue-1",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
      modelProfile: "cheap",
    });
    expect(recoveryAssigneeAdapterOverrides("status_only")).toEqual({ modelProfile: "cheap" });
  });

  it("supports adapter-aware failover overrides (normal model + adapter type)", () => {
    // Failover recovery does deliverable work on the fallback adapter: no cheap
    // pin, explicit adapter override.
    expect(recoveryAssigneeAdapterOverrides("normal_model", { adapterType: "codex_local" })).toEqual({
      adapterType: "codex_local",
    });
    expect(recoveryAssigneeAdapterOverrides("normal_model")).toEqual({});
    // Blank adapter types are ignored.
    expect(recoveryAssigneeAdapterOverrides("status_only", { adapterType: "  " })).toEqual({
      modelProfile: "cheap",
    });
  });

  it("scrubs inherited cheap hints from normal model source-work retries", () => {
    expect(withRecoveryModelProfileHint({
      issueId: "issue-1",
      retryOfRunId: "run-1",
      modelProfile: "cheap",
      recoveryIntent: "status_only",
      allowDeliverableWork: false,
      allowDocumentUpdates: false,
      resumeRequiresNormalModel: true,
    }, "normal_model")).toEqual({
      issueId: "issue-1",
      retryOfRunId: "run-1",
    });
  });

  it("can scrub copied downstream source-work contexts without applying a profile", () => {
    expect(scrubRecoveryModelProfileHints({
      taskId: "source-task",
      modelProfile: "cheap",
      paperclipModelProfile: { requested: "cheap" },
      allowDocumentUpdates: false,
    })).toEqual({ taskId: "source-task" });
  });
});
