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
  /**
   * The description declares an external wait (`External owner:` + `External action:`), one of the
   * sanctioned `blocked` forms. `no_blocker_relation` does NOT cover this: it only fires at zero
   * relation rows, so an issue that carries BOTH a marker and a blocker relation row would fall
   * through to `none` and be resumed — and `recoverBlockedSilentSinks` never sees it,
   * because an issue with a blocker relation row is not one of its candidates. Without this signal
   * that issue is resumed with a comment claiming no wait path exists, which the marker disproves.
   */
  | "external_wait"
  /**
   * No first-class blocker relation row exists for this issue at all. Responsibility for such an
   * issue belongs to the silent-sink recovery, NOT to
   * dependency-resume: an issue that never had a blocker relation is either still an
   * unstructured prose park (which 4085 structures into a monitor / external-wait marker) or one
   * 4085 already structured (e.g. an `External owner:` / `External action:` marker, for which
   * `BlockedWaitSignals` carries no corresponding field). Either way dependency-resume must leave
   * it alone. This is a responsibility boundary, not an ordering workaround: it holds no matter
   * when this sweep runs relative to 4085, so it cannot be reopened by later re-ordering the
   * recovery call sites.
   */
  | "no_blocker_relation"
  /** No wait path at all — no event will ever arrive for this issue. */
  | "none";

export type BlockedWaitSignals = {
  unresolvedBlockerCount: number;
  /**
   * Total number of `blocks` relation ROWS pointing at this issue, counted regardless of the
   * blocker's status. This is deliberately the row count, not `unresolvedBlockerCount`: an issue
   * whose only blocker was cancelled has `unresolvedBlockerCount === 0` but `blockerRelationRowCount
   * === 1`, and that is exactly the permanent-deadlock case dependency-resume must still own (its
   * single distinctive value — ). The boundary "belongs to silent-sink recovery" is
   * therefore drawn at `blockerRelationRowCount === 0`, never at `unresolvedBlockerCount === 0`.
   */
  blockerRelationRowCount: number;
  pendingInteractionCount: number;
  pendingApprovalCount: number;
  monitorNextCheckAt: Date | null;
  /**
   * The issue declares an external wait via `External owner:` / `External action:` in its
   * description. Derived from the description because that marker is the durable form of the
   * wait; there is no column for it.
   */
  hasExternalWaitMarker: boolean;
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
  // An issue that never had a first-class blocker relation is the silent-sink recovery's domain
  //, not dependency-resume's — see the `no_blocker_relation` doc. This is the last
  // check before `none` so it only reclassifies issues dependency-resume would otherwise resume,
  // while a blocker row that is merely all-terminal still falls through to `none` and
  // stays resumable.
  // Ahead of the row-count boundary: a declared external wait is a real wait whether or not the
  // issue also has a blocker relation row, and the row-count boundary alone would miss the
  // "marker AND blocker row" combination entirely.
  if (signals.hasExternalWaitMarker) return "external_wait";
  if (signals.blockerRelationRowCount === 0) return "no_blocker_relation";
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

/**
 * Version of the approved resume rule: conditions C1–C9 (candidate scope, `classifyBlockedWait`,
 * `decideBlockedResume`, queued wake, invocation budget) plus the limits in this file. The board
 * approves this version and a count limit, not a list of issue ids, so a change to any condition,
 * constant or the candidate scope must not ride along under the old approval: bump this string
 * and report the change as a new diff. The unit test pins every value that forms the rule, so such
 * a change cannot land without also editing that pin.
 */
export const BLOCKED_RESUME_RULE_VERSION = "2026-09-11.v1";

/**
 * Most automatic resumes allowed per company within `BLOCKED_RESUME_WINDOW_MS`, counting both the
 * resumes already made in the window and the ones the current sweep would make. Counting the
 * window and not only the sweep is what stops the 30-second sweep from letting a burst through a
 * few at a time.
 */
export const MAX_BLOCKED_RESUMES_PER_WINDOW = 5;
export const BLOCKED_RESUME_WINDOW_MS = 60 * 60 * 1000;

export type BlockedResumeBatchDecision =
  | { resume: true }
  | { resume: false; reason: "hold_open" | "over_limit" };

/**
 * All or nothing. A batch over the limit resumes none of its issues rather than the first few,
 * because an unusually large batch is itself the sign that the rule may be misclassifying. While a
 * hold is open nothing is resumed at all; only closing the hold releases it, and the next sweep
 * then has to fit under the limit again, so a backlog that built up during the hold cannot drain
 * through without a person looking at it.
 */
export function decideBlockedResumeBatch(input: {
  eligibleCount: number;
  resumedInWindow: number;
  holdOpen: boolean;
}): BlockedResumeBatchDecision {
  if (input.holdOpen) return { resume: false, reason: "hold_open" };
  if (input.resumedInWindow + input.eligibleCount > MAX_BLOCKED_RESUMES_PER_WINDOW) {
    return { resume: false, reason: "over_limit" };
  }
  return { resume: true };
}

/**
 * Flattens text quoted from another issue into one inert line for a system comment. The quote is
 * reference material, not an instruction: links are reduced to their text, and newlines are
 * collapsed so the quote cannot open a heading, list or instruction block of its own.
 */
export function quoteAsReference(text: string, maxChars = 280): string {
  const flat = text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  if (flat.length <= maxChars) return flat;
  return `${flat.slice(0, maxChars).trimEnd()}…`;
}

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
