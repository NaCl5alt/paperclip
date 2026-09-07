import type { RealizedExecutionWorkspace } from "./workspace-runtime.js";
import type {
  SharedWorkspaceClaimOwner,
  SharedWorkspaceClaimService,
  SharedWorkspaceIdentity,
} from "./shared-workspace-claims.js";

/**
 * Isolate-on-contention policy for shared checkouts (VANA-4055).
 *
 * Sequencing is the whole point: the claim is taken on the directory the run is
 * *about* to write to, before `ensurePersistedExecutionWorkspaceAvailable` /
 * `realizeExecutionWorkspace` touch git. A claim taken after realization (as in
 * VANA-4049) can only report the race, not win it.
 *
 * On contention the run is not failed — shared-checkout collisions are routine
 * across the fleet, so a hard block would break existing runs. Instead the run
 * is moved into its own git worktree, which satisfies single-writer by giving
 * each writer a different directory. Fail-close is reserved for the case where
 * isolation is impossible: sharing the directory anyway risks losing a
 * concurrent run's work and, on client checkouts, mixing NDA-separated code into
 * one commit — strictly worse than failing the run.
 */

export type SharedWorkspaceWriterMode = "exclusive" | "isolated";

/** How many stable (reusable) isolation slots precede the run-scoped fallback. */
export const STABLE_ISOLATION_SLOTS = 3;

/**
 * Branch names for the isolation candidates, in the order they are tried.
 *
 * The leading slots are stable so that routine contention reuses a few worktrees
 * instead of leaving a fresh one behind on every collision; each is claimed
 * before use, so reuse is still single-writer. The final name carries the run id
 * and is therefore always free, which is what makes isolation reliable when
 * every stable slot is occupied.
 *
 * The distinguishing part comes **first**: `sanitizeBranchName` truncates to 120
 * characters from the end, so a long issue identifier or agent name must not be
 * able to push the slot/run suffix off the end and collapse two runs onto one
 * branch.
 */
export function buildIsolationBranchNames(input: { label: string; runId: string }): string[] {
  const suffix = input.label;
  const names = [`isolated-${suffix}`];
  for (let slot = 2; slot <= STABLE_ISOLATION_SLOTS; slot += 1) {
    names.push(`isolated-${slot}-${suffix}`);
  }
  names.push(`isolated-run-${input.runId.slice(0, 8)}-${suffix}`);
  return names;
}

export class SharedWorkspaceIsolationError extends Error {
  readonly code = "shared_workspace_isolation_failed";
  readonly contendedCwd: string;
  readonly owner: SharedWorkspaceClaimOwner | null;
  override readonly cause?: unknown;

  constructor(message: string, details: { contendedCwd: string; owner: SharedWorkspaceClaimOwner | null; cause?: unknown }) {
    super(message);
    this.name = "SharedWorkspaceIsolationError";
    this.contendedCwd = details.contendedCwd;
    this.owner = details.owner ?? null;
    this.cause = details.cause;
  }
}

export type SharedWorkspaceContention = {
  cwd: string;
  ownerLeaseRunId: string | null;
  ownerAgentId: string | null;
  ownerClaimId: string;
  detectedAt: string;
  resolution: "isolated";
  isolatedCwd: string;
};

export type SharedWorkspaceWriterResult = {
  workspace: RealizedExecutionWorkspace;
  mode: SharedWorkspaceWriterMode;
  /**
   * True when the directory handed back was claimed before any checkout work ran
   * for this run. False means the claim could only be taken after realization
   * (the `git_worktree` path, whose target is not knowable in advance), so git
   * touched the directory first. Recorded because it is the ordering guarantee
   * this whole mechanism turns on, and it is otherwise invisible after the fact.
   */
  claimedBeforeCheckout: boolean;
  claimKey: string | null;
  claimedCwd: string | null;
  contention: SharedWorkspaceContention | null;
  warnings: string[];
};

export type SharedWorkspaceWriterInput = {
  claims: SharedWorkspaceClaimService;
  companyId: string | null;
  agentId: string | null;
  heartbeatRunId: string;
  issueId: string | null;
  /**
   * True when the run is about to write into a checkout that other runs may also
   * be using (`project_primary` / `shared_workspace`). False for runs already
   * configured for `git_worktree`, whose target directory is only known after
   * realization — those are still claimed, just after the fact, and re-isolated
   * on contention.
   */
  expectSharedCheckout: boolean;
  /** Directory the run will write to when `expectSharedCheckout` is true. */
  predictedCwd: string;
  /** Realize the workspace the run was configured for (reuse or fresh). */
  realizeConfigured: () => Promise<RealizedExecutionWorkspace>;
  /**
   * Realize isolation candidate `attempt` (0-based) as a git worktree.
   *
   * Candidates are tried in order and each is claimed before use, so earlier
   * candidates can be *reused* directories: whoever holds one is its single
   * writer, and the next contender simply moves to the next candidate. That
   * bounds the number of isolation worktrees by peak concurrent contention
   * rather than by total contention events. Throwing means isolation failed.
   */
  realizeIsolated: (attempt: number) => Promise<RealizedExecutionWorkspace>;
  /** How many isolation candidates `realizeIsolated` can produce. */
  isolationAttempts: number;
  logger?: { warn: (obj: unknown, msg: string) => void; info?: (obj: unknown, msg: string) => void };
};

export async function acquireSharedWorkspaceWriter(
  input: SharedWorkspaceWriterInput,
): Promise<SharedWorkspaceWriterResult> {
  const { claims } = input;
  const warnings: string[] = [];

  async function claimFor(identity: SharedWorkspaceIdentity) {
    return await claims.claim({
      identity,
      companyId: input.companyId,
      agentId: input.agentId,
      heartbeatRunId: input.heartbeatRunId,
      metadata: { issueId: input.issueId },
    });
  }

  async function isolate(
    contendedCwd: string,
    owner: SharedWorkspaceClaimOwner | null,
  ): Promise<SharedWorkspaceWriterResult> {
    let lastOwner = owner;
    for (let attempt = 0; attempt < input.isolationAttempts; attempt += 1) {
      let isolated: RealizedExecutionWorkspace;
      try {
        isolated = await input.realizeIsolated(attempt);
      } catch (error) {
        // Fail-close: we know another live writer owns the directory and we
        // cannot move out of its way, so continuing would double-write it.
        throw new SharedWorkspaceIsolationError(
          `Shared checkout "${contendedCwd}" is already claimed by another live run and this run could not be isolated into its own worktree.`,
          { contendedCwd, owner: lastOwner, cause: error },
        );
      }
      const isolatedIdentity = await claims.resolveIdentity(isolated.cwd);
      const isolatedClaim = await claimFor(isolatedIdentity);
      if (!isolatedClaim.claimed) {
        // This isolation slot is held by yet another live run; try the next one.
        lastOwner = isolatedClaim.owner ?? lastOwner;
        continue;
      }
      warnings.push(
        `Another live run holds the shared checkout ${contendedCwd}; this run was isolated into ${isolated.cwd}.`,
      );
      input.logger?.warn(
        {
          heartbeatRunId: input.heartbeatRunId,
          issueId: input.issueId,
          contendedCwd,
          ownerRunId: owner?.heartbeatRunId ?? null,
          isolatedCwd: isolated.cwd,
          isolationAttempt: attempt,
        },
        "Shared checkout contended; isolated run into its own worktree",
      );
      return {
        workspace: isolated,
        mode: "isolated",
        claimedBeforeCheckout: input.expectSharedCheckout,
        claimKey: isolatedIdentity.key,
        claimedCwd: isolatedIdentity.cwd,
        contention: {
          cwd: contendedCwd,
          ownerLeaseRunId: owner?.heartbeatRunId ?? null,
          ownerAgentId: owner?.agentId ?? null,
          ownerClaimId: owner?.claimId ?? "",
          detectedAt: new Date().toISOString(),
          resolution: "isolated",
          isolatedCwd: isolated.cwd,
        },
        warnings,
      };
    }
    throw new SharedWorkspaceIsolationError(
      `Shared checkout "${contendedCwd}" is contended and all ${input.isolationAttempts} isolation candidates are held by other live runs.`,
      { contendedCwd, owner: lastOwner },
    );
  }

  if (input.expectSharedCheckout) {
    const predicted = await claims.resolveIdentity(input.predictedCwd);
    const predictedClaim = await claimFor(predicted);
    if (!predictedClaim.claimed) {
      // Contended *before* any git mutation — the case VANA-4049 could only
      // observe after the fact.
      return await isolate(predicted.cwd, predictedClaim.owner);
    }
    const workspace = await input.realizeConfigured();
    const realized = await claims.resolveIdentity(workspace.cwd);
    if (realized.key === predicted.key) {
      return {
        workspace,
        mode: "exclusive",
        claimedBeforeCheckout: true,
        claimKey: predicted.key,
        claimedCwd: predicted.cwd,
        contention: null,
        warnings,
      };
    }
    // Realization landed somewhere other than the predicted directory; the claim
    // must follow the directory actually being written.
    const realizedClaim = await claimFor(realized);
    if (!realizedClaim.claimed) {
      return await isolate(realized.cwd, realizedClaim.owner);
    }
    return {
      workspace,
      mode: "exclusive",
      // The predicted directory was claimed first; realization then moved, and
      // the follow-up claim landed on the directory actually in use.
      claimedBeforeCheckout: true,
      claimKey: realized.key,
      claimedCwd: realized.cwd,
      contention: null,
      warnings,
    };
  }

  const workspace = await input.realizeConfigured();
  const realized = await claims.resolveIdentity(workspace.cwd);
  const realizedClaim = await claimFor(realized);
  if (!realizedClaim.claimed) {
    // Two runs resolved to the same worktree (e.g. concurrent runs of one issue,
    // which render the same branch name). Same hazard, same remedy.
    return await isolate(realized.cwd, realizedClaim.owner);
  }
  return {
    workspace,
    mode: "exclusive",
    claimedBeforeCheckout: false,
    claimKey: realized.key,
    claimedCwd: realized.cwd,
    contention: null,
    warnings,
  };
}
