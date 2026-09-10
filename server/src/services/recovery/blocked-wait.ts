/**
 * Why is a `blocked` issue waiting, and may automation resume it?
 *
 * `blocked` is used for several different waits, and they must not be treated alike.
 * A dependency wait resolves itself when the blocker completes; an approval wait resolves
 * when a human answers; an observation wait resolves when a scheduled monitor fires. Each of
 * those has an event that will eventually arrive.
 *
 * The failure this module exists for is the case with *no* such event: an issue parked in
 * `blocked` with no first-class blocker, no pending interaction or approval, no monitor, no
 * live run and no recovery action. Nothing in the system can ever revisit it, so it stays
 * parked forever (measured parked for 64 days and for 5 days,
 * neither of which ever had a blocker at all).
 *
 * Only that "no wait path" case is resumable. Everything else is left alone, which is what
 * keeps this from unparking manual pauses, live external waits, or unanswered approvals.
 */

export type BlockedWaitKind =
  /** A tree-control pause hold suppresses automation on this issue. */
  | "hold"
  /** A run or queued wake is already going to touch this issue. */
  | "execution"
  /** A recovery action owns the next step. */
  | "recovery"
  /** A human/board decision is outstanding (interaction card or approval). */
  | "approval"
  /** At least one first-class blocker is still unresolved. */
  | "dependency"
  /** A monitor re-check is scheduled in the future. */
  | "observation"
  /** No wait path at all — no event will ever arrive for this issue. */
  | "none";

export type BlockedWaitSignals = {
  unresolvedBlockerCount: number;
  pendingInteractionCount: number;
  pendingApprovalCount: number;
  monitorNextCheckAt: Date | null;
  hasActiveRecoveryAction: boolean;
  hasActiveExecutionPath: boolean;
  isPauseHeld: boolean;
  now: Date;
};

/**
 * Precedence is deliberate: the strongest "leave it alone" signal wins so the reported reason
 * matches the thing that would actually be violated by resuming.
 */
export function classifyBlockedWait(signals: BlockedWaitSignals): BlockedWaitKind {
  if (signals.isPauseHeld) return "hold";
  if (signals.hasActiveExecutionPath) return "execution";
  if (signals.hasActiveRecoveryAction) return "recovery";
  if (signals.pendingInteractionCount > 0 || signals.pendingApprovalCount > 0) return "approval";
  if (signals.unresolvedBlockerCount > 0) return "dependency";
  if (signals.monitorNextCheckAt && signals.monitorNextCheckAt.getTime() > signals.now.getTime()) {
    return "observation";
  }
  return "none";
}

export function isResumableBlockedWait(kind: BlockedWaitKind): boolean {
  return kind === "none";
}

/**
 * Total automatic resumes allowed over an issue's whole life. Without this an agent that keeps
 * re-parking an issue with no wait path would be re-queued forever, which is the
 * `done` <-> reopen ping-pong the mechanism is required not to create.
 */
export const MAX_BLOCKED_RESUMES_PER_ISSUE = 3;

/**
 * How long an issue must sit in `blocked` before automation will resume it.
 *
 * "No wait path exists" is only knowable after whoever parked the issue has finished acting.
 * Recovery escalations, for example, park an issue and then attach a recovery action; resuming
 * inside that window fights the actor that just parked it and produces exactly the park/unpark
 * ping-pong this mechanism must not create.
 */
export const MIN_BLOCKED_PARK_AGE_MS = 15 * 60 * 1000;

export type BlockedResumeHistory = {
  /** `created_at` of every previous automatic resume of this issue, any order. */
  resumeAts: Date[];
  /** `created_at` of the most recent transition *into* `blocked`, or null if unknown. */
  lastBlockedEntryAt: Date | null;
  /** Fallback park time when no activity row records the transition (e.g. pre-activity-log rows). */
  issueUpdatedAt: Date;
  now: Date;
};

export type BlockedResumeDecision =
  | { resume: true }
  | {
      resume: false;
      reason: "already_resumed_this_park" | "resume_budget_exhausted" | "parked_too_recently";
    };

/**
 * Idempotency, decided purely from durable history so it survives restarts, duplicate events
 * and concurrent sweeps:
 *
 * - at most one automatic resume per entry into `blocked` — a duplicate blocker-resolved event
 *   or a second sweep pass finds the earlier resume recorded and does nothing;
 * - at most `MAX_BLOCKED_RESUMES_PER_ISSUE` over the issue's life.
 *
 * `lastBlockedEntryAt === null` means no transition into `blocked` was found in the history
 * window; any prior resume is then treated as covering the current park, which fails safe
 * (skip) rather than resuming repeatedly.
 */
export function decideBlockedResume(history: BlockedResumeHistory): BlockedResumeDecision {
  if (history.resumeAts.length >= MAX_BLOCKED_RESUMES_PER_ISSUE) {
    return { resume: false, reason: "resume_budget_exhausted" };
  }
  const parkAge = history.now.getTime() - (history.lastBlockedEntryAt ?? history.issueUpdatedAt).getTime();
  if (parkAge < MIN_BLOCKED_PARK_AGE_MS) {
    return { resume: false, reason: "parked_too_recently" };
  }
  const parkedAt = history.lastBlockedEntryAt;
  const resumedThisPark = parkedAt
    ? history.resumeAts.some((at) => at.getTime() > parkedAt.getTime())
    : history.resumeAts.length > 0;
  if (resumedThisPark) {
    return { resume: false, reason: "already_resumed_this_park" };
  }
  return { resume: true };
}

/**
 * The `details` fields an activity row uses to describe a status write.
 *
 * `readBlockedResumeHistory` selects park rows by `details.status === "blocked"`, not by action
 * name, so a row that names a status it did not actually write fabricates a park: the settling
 * window restarts and that park's resume allowance re-opens. Writers that only conditionally
 * change the status must therefore only conditionally report it — this happened twice in one
 * commit, in two places 2,300 lines apart, which is why it lives in one function now.
 *
 * `currentStatus` is always reported so readers that just want "where is it now" have a field
 * that is never conditional.
 */
export function statusChangeActivityFields(input: {
  previousStatus: string;
  /** The status this write actually set, or undefined when it deliberately left it alone. */
  writtenStatus?: string;
}) {
  const changed = input.writtenStatus !== undefined && input.writtenStatus !== input.previousStatus;
  return {
    ...(changed ? { status: input.writtenStatus, previousStatus: input.previousStatus } : {}),
    currentStatus: input.writtenStatus ?? input.previousStatus,
  };
}
