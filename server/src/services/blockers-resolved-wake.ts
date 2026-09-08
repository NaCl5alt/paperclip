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
    payload: {
      issueId: input.dependent.id,
      ...shared,
      ...(input.deferredFor ? { deferredFor: input.deferredFor } : {}),
    },
    contextSnapshot: {
      issueId: input.dependent.id,
      taskId: input.dependent.id,
      wakeReason: "issue_blockers_resolved" as const,
      source: input.source,
      ...shared,
    },
  };
}
