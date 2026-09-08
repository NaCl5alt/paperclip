import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  BLOCKERS_RESOLVED_WAKE_REASON,
  buildBlockersResolvedWakeFields,
  fireDeferredBlockerWakes,
} from "../services/blockers-resolved-wake.ts";

const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));
// Absolute path, not a suffix match: a future `foo-blockers-resolved-wake.ts` must not be exempt.
const OWNER_MODULE = join(SERVER_SRC, "services", "blockers-resolved-wake.ts");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      return entry === "__tests__" || entry === "node_modules" ? [] : sourceFiles(full);
    }
    return entry.endsWith(".ts") ? [full] : [];
  });
}

const dependent = {
  id: "dependent-1",
  blockerIssueIds: ["blocker-done", "blocker-cancelled"],
  cancelledBlockerIssueIds: ["blocker-cancelled"],
};

describe("buildBlockersResolvedWakeFields", () => {
  it("reports a cancelled blocker even when a different blocker is the one that completed", () => {
    const fields = buildBlockersResolvedWakeFields({
      dependent,
      resolvedBlockerIssueId: "blocker-done",
      resolvedBlockerStatus: "done",
      source: "issue.blockers_resolved",
    });

    expect(fields.payload).toMatchObject({
      issueId: "dependent-1",
      resolvedBlockerIssueId: "blocker-done",
      resolvedBlockerStatus: "done",
      cancelledBlockerIssueIds: ["blocker-cancelled"],
    });
    // The resolution itself was not a cancellation.
    expect(fields.payload).not.toHaveProperty("resolvedByCancellation");
    expect(fields.contextSnapshot).not.toHaveProperty("resolvedByCancellation");
  });

  it("flags the resolution when the blocker that terminated was itself cancelled", () => {
    const fields = buildBlockersResolvedWakeFields({
      dependent,
      resolvedBlockerIssueId: "blocker-cancelled",
      resolvedBlockerStatus: "cancelled",
      source: "issue.blockers_resolved",
    });

    expect(fields.payload).toMatchObject({
      resolvedByCancellation: true,
      cancelledBlockerIssueIds: ["blocker-cancelled"],
    });
    expect(fields.contextSnapshot).toMatchObject({ resolvedByCancellation: true });
  });

  it("omits the cancelled list entirely when there is nothing to report", () => {
    const fields = buildBlockersResolvedWakeFields({
      dependent: { id: "dependent-2", blockerIssueIds: ["blocker-done"] },
      resolvedBlockerIssueId: "blocker-done",
      resolvedBlockerStatus: "done",
      source: "issue.blockers_resolved",
    });

    expect(fields.payload).not.toHaveProperty("cancelledBlockerIssueIds");
    expect(fields.contextSnapshot).not.toHaveProperty("cancelledBlockerIssueIds");
  });

  it("gives both producers the same facts, differing only in provenance", () => {
    // The finalize hook is not a fallback: when a blocker completes mid-run it is the ONLY wake
    // the dependent's owner receives. Anything the route says, it has to say too.
    const fromRoute = buildBlockersResolvedWakeFields({
      dependent,
      resolvedBlockerIssueId: "blocker-done",
      resolvedBlockerStatus: "done",
      source: "issue.blockers_resolved",
    });
    const fromFinalize = buildBlockersResolvedWakeFields({
      dependent,
      resolvedBlockerIssueId: "blocker-done",
      resolvedBlockerStatus: "done",
      source: "workspace.finalize",
      deferredFor: "workspace_finalize",
    });

    expect(fromFinalize.payload).toMatchObject({
      ...fromRoute.payload,
      deferredFor: "workspace_finalize",
    });
    const { source: _routeSource, ...routeFacts } = fromRoute.contextSnapshot;
    expect(fromFinalize.contextSnapshot).toMatchObject(routeFacts);
    expect(fromFinalize.contextSnapshot.source).toBe("workspace.finalize");
  });

  it("is the only source file allowed to name this wake reason", () => {
    // B5 happened because two producers hand-rolled the same payload and only one was updated.
    // The builder now supplies `reason` as well, so any file that still names the wake in a
    // `reason:`/`wakeReason:` position is building it by hand — including a second producer
    // inside an existing file, which a per-file "does it import the builder" check cannot see.
    //
    // Matched as a regex over the assignment rather than as a bare substring so that swapping
    // to single quotes, a template literal, or concatenation does not slip past, and so that
    // prose (comments, log messages, SQL) naming the reason is not falsely blocked.
    const producerPattern = /(reason|wakeReason)\s*:\s*(["'`]|.*\+\s*["'`])[^"'`]*issue_blockers_resolved/;
    const offenders = sourceFiles(SERVER_SRC)
      .filter((file) => file !== OWNER_MODULE && !file.endsWith(".test.ts"))
      .filter((file) => producerPattern.test(readFileSync(file, "utf8")));

    expect(offenders).toEqual([]);
  });

  describe("fireDeferredBlockerWakes", () => {
    function stubs(dependents: Array<Record<string, unknown>>) {
      const wakes: Array<{ agentId: string; wake: Record<string, unknown> }> = [];
      const errors: unknown[] = [];
      return {
        wakes,
        errors,
        deps: {
          listWakeableBlockedDependents: async () => dependents as never,
          enqueueWakeup: async (agentId: string, wake: Record<string, unknown>) => {
            wakes.push({ agentId, wake });
          },
          onError: (err: unknown) => errors.push(err),
        },
      };
    }

    const dependentWithCancelled = {
      id: "dependent-1",
      assigneeAgentId: "agent-2",
      blockerIssueIds: ["blocker-done", "blocker-cancelled"],
      cancelledBlockerIssueIds: ["blocker-cancelled"],
    };

    it("hands the dependent's cancelled blockers to the owner", async () => {
      const { wakes, deps } = stubs([dependentWithCancelled]);

      const fired = await fireDeferredBlockerWakes({
        blockerIssueId: "blocker-done",
        blockerIssueStatus: "done",
        ...deps,
      });

      expect(fired).toBe(1);
      expect(wakes).toHaveLength(1);
      expect(wakes[0].agentId).toBe("agent-2");
      expect(wakes[0].wake.reason).toBe(BLOCKERS_RESOLVED_WAKE_REASON);
      expect(wakes[0].wake.payload).toMatchObject({
        issueId: "dependent-1",
        resolvedBlockerIssueId: "blocker-done",
        resolvedBlockerStatus: "done",
        cancelledBlockerIssueIds: ["blocker-cancelled"],
        deferredFor: "workspace_finalize",
      });
      expect(wakes[0].wake.contextSnapshot).toMatchObject({
        source: "workspace.finalize",
        cancelledBlockerIssueIds: ["blocker-cancelled"],
      });
    });

    it("does nothing unless the blocker actually reached done", async () => {
      for (const status of ["cancelled", "in_progress", null]) {
        const { wakes, deps } = stubs([dependentWithCancelled]);

        const fired = await fireDeferredBlockerWakes({
          blockerIssueId: "blocker-1",
          blockerIssueStatus: status,
          ...deps,
        });

        expect(fired, `status ${status}`).toBe(0);
        expect(wakes, `status ${status}`).toEqual([]);
      }
    });

    it("keeps firing the remaining dependents when one wake throws", async () => {
      const errors: Array<Record<string, unknown>> = [];
      const wakes: string[] = [];
      const fired = await fireDeferredBlockerWakes({
        blockerIssueId: "blocker-done",
        blockerIssueStatus: "done",
        listWakeableBlockedDependents: async () =>
          [
            { ...dependentWithCancelled, id: "dependent-1", assigneeAgentId: "agent-a" },
            { ...dependentWithCancelled, id: "dependent-2", assigneeAgentId: "agent-b" },
          ] as never,
        enqueueWakeup: async (agentId: string) => {
          if (agentId === "agent-a") throw new Error("queue full");
          wakes.push(agentId);
        },
        onError: (err, context) => errors.push(context),
      });

      expect(fired).toBe(1);
      expect(wakes).toEqual(["agent-b"]);
      expect(errors).toEqual([
        expect.objectContaining({ failedStage: "enqueue_wake", dependentIssueId: "dependent-1" }),
      ]);
    });

    it("reports a lookup failure instead of throwing into the run finalizer", async () => {
      const errors: Array<Record<string, unknown>> = [];
      const fired = await fireDeferredBlockerWakes({
        blockerIssueId: "blocker-done",
        blockerIssueStatus: "done",
        listWakeableBlockedDependents: async () => {
          throw new Error("db down");
        },
        enqueueWakeup: async () => undefined,
        onError: (err, context) => errors.push(context),
      });

      expect(fired).toBe(0);
      // A batch-wide failure must not read like a single dependent failing.
      expect(errors).toEqual([expect.objectContaining({ failedStage: "list_dependents" })]);
    });
  });
});
