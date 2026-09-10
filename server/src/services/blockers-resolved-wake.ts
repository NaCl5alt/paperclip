/**
 * One place that decides what an `issue_blockers_resolved` wake says.
 *
 * There are two producers: the issue PATCH route, which fires when a blocker reaches a terminal
 * status, and the heartbeat's workspace-finalize hook, which fires the wake the route could not
 * because the readiness check was still holding it behind the finalize barrier. They are not a
 * primary and a fallback — for a blocker completed mid-run the finalize hook is the *only* wake
 * the dependent's owner ever gets.
 *
 * They drifted: `cancelledBlockerIssueIds` was added to the route and not to the finalize hook,
 * so whether the owner heard "a premise died" depended on which producer happened to fire. Both
 * now build the payload here, so the shape cannot diverge again without a test failing.
 */

export type BlockersResolvedWakeDependent = {
  id: string;
  blockerIssueIds: string[];
  cancelledBlockerIssueIds?: string[];
};

export type BlockersResolvedWakeInput = {
  dependent: BlockersResolvedWakeDependent;
  /** The blocker that just reached a terminal status. */
  resolvedBlockerIssueId: string;
  resolvedBlockerStatus: string;
  /** `contextSnapshot.source`, which differs per producer. */
  source: string;
  /** Set by the finalize hook to record that this wake was held back by the barrier. */
  deferredFor?: string;
};

export const BLOCKERS_RESOLVED_WAKE_REASON = "issue_blockers_resolved" as const;

export function buildBlockersResolvedWakeFields(input: BlockersResolvedWakeInput) {
  const cancelledBlockerIssueIds = input.dependent.cancelledBlockerIssueIds ?? [];

  // Two distinct facts. `resolvedByCancellation` is about the blocker that just terminated;
  // `cancelledBlockerIssueIds` is every cancelled blocker of this dependent. Gating the list on
  // the flag hides a cancelled blocker whenever a *different* blocker is the one that completes,
  // which is the ordinary shape once a dependent has more than one blocker.
  const cancellationFields = {
    ...(input.resolvedBlockerStatus === "cancelled" ? { resolvedByCancellation: true } : {}),
    ...(cancelledBlockerIssueIds.length > 0 ? { cancelledBlockerIssueIds } : {}),
  };

  const shared = {
    resolvedBlockerIssueId: input.resolvedBlockerIssueId,
    resolvedBlockerStatus: input.resolvedBlockerStatus,
    blockerIssueIds: input.dependent.blockerIssueIds,
    ...cancellationFields,
  };

  return {
    reason: BLOCKERS_RESOLVED_WAKE_REASON,
    payload: {
      issueId: input.dependent.id,
      ...shared,
      ...(input.deferredFor ? { deferredFor: input.deferredFor } : {}),
    },
    contextSnapshot: {
      issueId: input.dependent.id,
      taskId: input.dependent.id,
      wakeReason: BLOCKERS_RESOLVED_WAKE_REASON,
      source: input.source,
      ...shared,
    },
  };
}

/**
 * The workspace-finalize producer.
 *
 * Extracted from `executeRun` so it can be exercised directly: a structural "does this file
 * import the builder" check cannot tell whether the call is reached or what arguments it gets,
 * and the surrounding hook needs a full run driven to a successful `workspace_finalize` before
 * it executes.
 *
 * Fires the wake that the issue PATCH route could not: while a blocker is still running, the
 * readiness check holds its dependents behind the workspace-finalize barrier, so the route sees
 * no wakeable dependents at all. For a blocker completed mid-run this is the owner's only wake.
 */
export async function fireDeferredBlockerWakes(deps: {
  blockerIssueId: string;
  blockerIssueStatus: string | null;
  listWakeableBlockedDependents: (issueId: string) => Promise<Array<
    BlockersResolvedWakeDependent & { assigneeAgentId: string }
  >>;
  enqueueWakeup: (agentId: string, wake: Record<string, unknown>) => Promise<unknown>;
  onError: (err: unknown, context: Record<string, unknown>) => void;
}) {
  // Only a `done` blocker can be held by the finalize barrier; a cancelled one never had a
  // workspace to finalize, so it resolves its dependents through the route instead.
  if (deps.blockerIssueStatus !== "done") return 0;

  let fired = 0;
  try {
    const dependents = await deps.listWakeableBlockedDependents(deps.blockerIssueId);
    for (const dependent of dependents) {
      await deps
        .enqueueWakeup(dependent.assigneeAgentId, {
          source: "automation",
          triggerDetail: "system",
          ...buildBlockersResolvedWakeFields({
            dependent,
            resolvedBlockerIssueId: deps.blockerIssueId,
            resolvedBlockerStatus: deps.blockerIssueStatus,
            source: "workspace.finalize",
            deferredFor: "workspace_finalize",
          }),
        })
        .then(() => {
          fired += 1;
        })
        .catch((wakeErr) => {
          deps.onError(wakeErr, {
            issueId: deps.blockerIssueId,
            dependentIssueId: dependent.id,
            agentId: dependent.assigneeAgentId,
            failedStage: "enqueue_wake",
          });
        });
    }
  } catch (err) {
    // Distinguished from the per-dependent failure above so the two stay greppable apart: this
    // one means no dependent was reached at all.
    deps.onError(err, { issueId: deps.blockerIssueId, failedStage: "list_dependents" });
  }
  return fired;
}
