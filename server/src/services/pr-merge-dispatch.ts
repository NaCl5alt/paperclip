import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { documentService } from "./documents.js";
import { heartbeatService } from "./heartbeat.js";
import { logActivity, type LogActivityInput } from "./activity-log.js";
import { queueIssueAssignmentWakeup, type IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";

/**
 * Opt 1 system-actor PR-merge wake (Phase 1, engine-side re-verification).
 *
 * The dispatch engine composes system-action service primitives directly — exactly as routine
 * run-issue creation does — so cross-group targets are woken without ever passing through the
 * HTTP cross-agent mutation guard (no `req.actor.type === "system"` exception口 is created).
 * Complete Mediation is enforced server-side here: the engine independently re-verifies that the
 * PR record exists on the target's `pr-links` document before performing any wake (Fail Securely).
 *
 * Delivery contract: **at-least-once**. The idempotency writeback happens after the comment and the
 * wake, so if the `processedMergeShas` writeback loses its `baseRevisionId` race (or otherwise
 * fails), a webhook redelivery re-reads the SHA as unprocessed and wakes a second time. This is the
 * deliberate trade: a duplicate resume wake is recoverable, a dropped one strands the target. Do not
 * "fix" it by reserving the SHA before the wake — that converts the failure mode into at-most-once
 * and silently loses merges.
 *
 * Re-verification scope: the assert binds the *target identity* (repo + PR number / URL must exist
 * on the target's pr-links), not the SHA — `mergeCommitSha`/`headSha` are trusted from the trigger.
 * Phase 1 accepts this because the webhook path authenticates via HMAC upstream. See finding 3.
 */

export const PR_LINKS_DOCUMENT_KEY = "pr-links";
const DISPATCH_ACTOR_ID = "pr-merge-dispatcher";
const JSON_FENCE_RE = /```json\s*\n([\s\S]*?)\n```/i;

export type PrMergeDispatchSource = "webhook" | "schedule" | "manual" | "api";
export type PrMergeDispatchResolution = "engine_resolve" | "engine_reverify";

export type PrMergeDispatchOutcome =
  | "woken"
  | "duplicate"
  | "unmatched"
  | "ignored_unmerged"
  | "ignored_terminal"
  | "unassigned_escalated";

const OUTCOME_ACTION: Record<PrMergeDispatchOutcome, string> = {
  woken: "dispatch.pr_merge_wake",
  duplicate: "dispatch.pr_merge_duplicate",
  unmatched: "dispatch.pr_merge_unmatched",
  ignored_unmerged: "dispatch.pr_merge_ignored_unmerged",
  ignored_terminal: "dispatch.pr_merge_ignored_terminal",
  unassigned_escalated: "dispatch.pr_merge_unassigned_escalated",
};

/**
 * A terminal target has nothing left to resume, so a late/stale PR merge must not mutate it.
 * `queueIssueAssignmentWakeup` only skips `backlog`, and `addComment` does not gate on status, so
 * without this guard a merged PR would post a system marker comment on — and wake the assignee of —
 * an issue that was already completed or deliberately abandoned. Resurrecting a `cancelled` issue
 * from a webhook is the worst case. The design is silent on terminal targets;
 * this is the Fail Securely reading of it.
 */
const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);

export interface PrNaturalKey {
  repo: string;
  prNumber: number;
  prUrl?: string | null;
  headBranch?: string | null;
  headSha?: string | null;
  mergeCommitSha?: string | null;
  /** GitHub `pull_request.merged`. Only `true` triggers a wake (closed-unmerged is ignored). */
  merged?: boolean;
}

interface PrLinkRecord {
  repo?: string;
  prNumber?: number;
  prUrl?: string | null;
  headBranch?: string | null;
  headSha?: string | null;
  recordedAt?: string;
  recordedByAgentId?: string | null;
  processedMergeShas?: string[];
  [key: string]: unknown;
}

export interface PrMergeDispatchResult {
  outcome: PrMergeDispatchOutcome;
  targetIssueId: string | null;
  idempotencyKey: string | null;
  escalatedAgentIds: string[];
}

type IssueSvc = ReturnType<typeof issueService>;
type DocumentSvc = ReturnType<typeof documentService>;

export interface PrMergeDispatchDeps {
  issues: Pick<IssueSvc, "getById" | "addComment">;
  documents: Pick<DocumentSvc, "getIssueDocumentByKey" | "upsertIssueDocument">;
  heartbeat: IssueAssignmentWakeupDeps;
  logActivity: (input: LogActivityInput) => Promise<void>;
  /**
   * Resolves the owning-group manager(s) to escalate an unassigned matched target to (design §6).
   * Automatic assignee selection is intentionally out of scope for Phase 1; when omitted, an
   * unassigned target only receives the system marker comment + idempotent writeback.
   */
  resolveEscalationTargets?: (issue: {
    id: string;
    companyId: string;
  }) => Promise<Array<{ agentId: string; name?: string | null }>>;
}

function parsePrLinksDocument(body: string): {
  records: PrLinkRecord[];
  render: (records: PrLinkRecord[]) => string;
} {
  const fence = JSON_FENCE_RE.exec(body);
  const jsonText = fence ? fence[1] : body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw unprocessable("pr-links document body is not valid JSON");
  }

  let records: PrLinkRecord[];
  let container: "array" | "object";
  if (Array.isArray(parsed)) {
    records = parsed as PrLinkRecord[];
    container = "array";
  } else if (parsed && typeof parsed === "object" && Array.isArray((parsed as { links?: unknown }).links)) {
    records = (parsed as { links: PrLinkRecord[] }).links;
    container = "object";
  } else {
    throw unprocessable("pr-links document is missing a links array");
  }

  const render = (next: PrLinkRecord[]) => {
    const value = container === "array" ? next : { ...(parsed as Record<string, unknown>), links: next };
    const json = JSON.stringify(value, null, 2);
    if (fence) {
      return `${body.slice(0, fence.index)}\`\`\`json\n${json}\n\`\`\`${body.slice(fence.index + fence[0].length)}`;
    }
    return json;
  };

  return { records, render };
}

function findMatchingRecord(records: PrLinkRecord[], key: PrNaturalKey): PrLinkRecord | null {
  const byNumber = records.find(
    (record) => record.repo === key.repo && Number(record.prNumber) === Number(key.prNumber),
  );
  if (byNumber) return byNumber;
  if (key.prUrl) {
    const byUrl = records.find((record) => record.prUrl === key.prUrl);
    if (byUrl) return byUrl;
  }
  return null;
}

function buildResumeCommentBody(
  key: PrNaturalKey,
  source: PrMergeDispatchSource,
  mentions: Array<{ agentId: string; name?: string | null }>,
): string {
  const prLink = key.prUrl ? `[#${key.prNumber}](${key.prUrl})` : `#${key.prNumber}`;
  const lines = [
    "<!-- paperclip:pr-merge-wake v1 -->",
    "**PR merged — auto-resume (system)**",
    "",
    `- repo: ${key.repo}`,
    `- pr: ${prLink}`,
    `- merge: ${key.mergeCommitSha ?? key.headSha ?? "(unknown sha)"}`,
    `- source: ${source}`,
    "",
    "PR がマージされました。この issue の作業を再開してください（resume）。",
  ];
  if (mentions.length > 0) {
    const list = mentions
      .map((mention) => `[@${mention.name ?? "owner"}](agent://${mention.agentId})`)
      .join(" ");
    lines.push("", `担当未設定のため、所有グループ統括 ${list} に assign を依頼します。`);
  }
  return lines.join("\n");
}

/**
 * System-actor PR-merge wake for a single engine-resolved/reverified target.
 *
 * `targetIssueId` is the candidate the engine resolved (Phase 1 = dispatcher agent提示, re-verified
 * here; Phase 2 = engine `resolveMatchedTarget`). A `null` candidate means the engine could not
 * resolve a target (unmatched) — no mutation is performed.
 */
export async function dispatchPrMergeWake(
  deps: PrMergeDispatchDeps,
  args: {
    targetIssueId: string | null;
    prNaturalKey: PrNaturalKey;
    source: PrMergeDispatchSource;
    resolution?: PrMergeDispatchResolution;
    routineRunId?: string | null;
    triggerId?: string | null;
  },
): Promise<PrMergeDispatchResult> {
  const { prNaturalKey: key, source } = args;
  const resolution = args.resolution ?? "engine_reverify";

  // §3 step2 — engine could not resolve a target. No target, no mutation.
  if (!args.targetIssueId) {
    logger.warn({ repo: key.repo, prNumber: key.prNumber, source }, "pr-merge dispatch: unmatched (no target)");
    return { outcome: "unmatched", targetIssueId: null, idempotencyKey: null, escalatedAgentIds: [] };
  }

  const issue = await deps.issues.getById(args.targetIssueId);
  // Invalid candidate (engine提示した id が存在しない) — Fail Securely.
  if (!issue) {
    throw unprocessable("pr-merge dispatch: target issue not found", { targetIssueId: args.targetIssueId });
  }

  const auditBase = {
    routineRunId: args.routineRunId ?? null,
    triggerId: args.triggerId ?? null,
    source,
    repo: key.repo,
    prNumber: key.prNumber,
    prUrl: key.prUrl ?? null,
    mergeCommitSha: key.mergeCommitSha ?? null,
    resolution,
  };

  const audit = (outcome: PrMergeDispatchOutcome, extra: Record<string, unknown> = {}) =>
    deps.logActivity({
      companyId: issue.companyId,
      actorType: "system",
      actorId: DISPATCH_ACTOR_ID,
      action: OUTCOME_ACTION[outcome],
      entityType: "issue",
      entityId: issue.id,
      details: { ...auditBase, outcome, ...extra },
    });

  // §3 step1 — closed-unmerged is never woken.
  if (key.merged !== true) {
    await audit("ignored_unmerged");
    return { outcome: "ignored_unmerged", targetIssueId: issue.id, idempotencyKey: null, escalatedAgentIds: [] };
  }

  // §3 step1b — a terminal target is never mutated or woken. Audited (not silent) so a merge that
  // lands after closure is still traceable, and — like `ignored_unmerged` — no writeback happens,
  // so the decision is re-evaluated from scratch if the same PR is redelivered.
  if (TERMINAL_ISSUE_STATUSES.has(issue.status)) {
    await audit("ignored_terminal", { issueStatus: issue.status });
    return { outcome: "ignored_terminal", targetIssueId: issue.id, idempotencyKey: null, escalatedAgentIds: [] };
  }

  const idempotencyKey = key.mergeCommitSha ?? key.headSha ?? null;
  if (!idempotencyKey) {
    throw unprocessable("pr-merge dispatch: merged PR is missing both mergeCommitSha and headSha");
  }

  // §3 step4 — re-verification (Complete Mediation). The PR record MUST exist on the target's
  // pr-links document, otherwise this is not a legitimate matched target → throw, no wake.
  const prLinksDoc = await deps.documents.getIssueDocumentByKey(issue.id, PR_LINKS_DOCUMENT_KEY);
  if (!prLinksDoc) {
    throw unprocessable("pr-merge dispatch: target has no pr-links document", { targetIssueId: issue.id });
  }
  const { records, render } = parsePrLinksDocument(prLinksDoc.body ?? "");
  const record = findMatchingRecord(records, key);
  if (!record) {
    throw unprocessable("pr-merge dispatch: PR record not found on target pr-links (re-verify failed)", {
      targetIssueId: issue.id,
      repo: key.repo,
      prNumber: key.prNumber,
    });
  }

  // §3 step5 — idempotency keyed on merge commit SHA (webhook redelivery / re-merge).
  const processed = Array.isArray(record.processedMergeShas) ? record.processedMergeShas : [];
  if (processed.includes(idempotencyKey)) {
    await audit("duplicate", { idempotencyKey });
    return { outcome: "duplicate", targetIssueId: issue.id, idempotencyKey, escalatedAgentIds: [] };
  }

  const assigneeAgentId = issue.assigneeAgentId;
  const escalationTargets =
    assigneeAgentId == null && deps.resolveEscalationTargets
      ? await deps.resolveEscalationTargets({ id: issue.id, companyId: issue.companyId })
      : [];

  // §3 step6a — system-authored resume marker comment (actor {} → authorType "system", guard 非経由).
  await deps.issues.addComment(issue.id, buildResumeCommentBody(key, source, escalationTargets), {}, {
    authorType: "system",
  });

  // §3 step6b — wake the assignee with system权限. Unassigned → §6 escalation.
  let outcome: PrMergeDispatchOutcome;
  const escalatedAgentIds: string[] = [];
  if (assigneeAgentId) {
    await queueIssueAssignmentWakeup({
      heartbeat: deps.heartbeat,
      issue: { id: issue.id, assigneeAgentId, status: issue.status },
      reason: "pr_merge_dispatch",
      mutation: "comment",
      contextSource: "pr-merge-dispatch",
      requestedByActorType: "system",
    });
    outcome = "woken";
  } else {
    for (const target of escalationTargets) {
      await deps.heartbeat.wakeup(target.agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "pr_merge_dispatch_unassigned",
        payload: { issueId: issue.id, repo: key.repo, prNumber: key.prNumber },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: { issueId: issue.id, source: "pr-merge-dispatch" },
      });
      escalatedAgentIds.push(target.agentId);
    }
    outcome = "unassigned_escalated";
  }

  // §3 step6c / §7 — system writeback of the idempotency state (optimistic lock on baseRevisionId).
  record.processedMergeShas = Array.from(new Set([...processed, idempotencyKey]));
  await deps.documents.upsertIssueDocument({
    issueId: issue.id,
    key: PR_LINKS_DOCUMENT_KEY,
    title: prLinksDoc.title ?? null,
    format: prLinksDoc.format ?? "markdown",
    body: render(records),
    baseRevisionId: prLinksDoc.latestRevisionId,
  });

  // §3 step6d / §8 — audit with the firing source.
  await audit(outcome, { idempotencyKey, escalatedAgentIds });

  return { outcome, targetIssueId: issue.id, idempotencyKey, escalatedAgentIds };
}

/**
 * Factory wiring real service primitives. Used by the Phase 1 internal dispatch call site
 * (company-scoped endpoint / routine `api` trigger) and the Phase 2 `dispatchRoutineRun` hook.
 */
export function prMergeDispatchService(
  db: Db,
  deps: {
    heartbeat?: IssueAssignmentWakeupDeps;
    resolveEscalationTargets?: PrMergeDispatchDeps["resolveEscalationTargets"];
  } = {},
) {
  const issues = issueService(db);
  const documents = documentService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);
  const composedDeps: PrMergeDispatchDeps = {
    issues,
    documents,
    heartbeat,
    logActivity: (input) => logActivity(db, input),
    resolveEscalationTargets: deps.resolveEscalationTargets,
  };
  return {
    dispatchPrMergeWake: (args: Parameters<typeof dispatchPrMergeWake>[1]) =>
      dispatchPrMergeWake(composedDeps, args),
  };
}
