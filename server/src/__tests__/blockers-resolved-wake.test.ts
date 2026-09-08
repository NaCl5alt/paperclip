import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildBlockersResolvedWakeFields } from "../services/blockers-resolved-wake.ts";

const SERVER_SRC = fileURLToPath(new URL("..", import.meta.url));

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

  it("is the only place that builds this wake, so producers cannot drift again", () => {
    // B5 happened because two producers hand-rolled the same payload and only one was updated.
    // For a blocker completed mid-run the finalize hook in heartbeat.ts is the ONLY wake the
    // dependent's owner gets, so a producer that skips this builder silently ships a different
    // contract to some owners.
    const producers = sourceFiles(SERVER_SRC).filter((file) =>
      readFileSync(file, "utf8").includes('reason: "issue_blockers_resolved"'),
    );

    expect(producers.length).toBeGreaterThan(1);
    for (const file of producers) {
      expect(readFileSync(file, "utf8"), file).toContain("buildBlockersResolvedWakeFields");
    }
  });
});
