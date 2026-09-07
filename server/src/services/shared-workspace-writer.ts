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
  /** Realize a run-private git worktree. Throwing here means isolation failed. */
  realizeIsolated: () => Promise<RealizedExecutionWorkspace>;
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
    let isolated: RealizedExecutionWorkspace;
    try {
      isolated = await input.realizeIsolated();
    } catch (error) {
      // Fail-close: we know another live writer owns the directory and we cannot
      // move out of its way, so continuing would double-write it.
      throw new SharedWorkspaceIsolationError(
        `Shared checkout "${contendedCwd}" is already claimed by another live run and this run could not be isolated into its own worktree.`,
        { contendedCwd, owner, cause: error },
      );
    }
    const isolatedIdentity = await claims.resolveIdentity(isolated.cwd);
    const isolatedClaim = await claimFor(isolatedIdentity);
    if (!isolatedClaim.claimed) {
      throw new SharedWorkspaceIsolationError(
        `Isolated worktree "${isolated.cwd}" for the contended checkout "${contendedCwd}" is itself claimed by another live run.`,
        { contendedCwd, owner: isolatedClaim.owner },
      );
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
      },
      "Shared checkout contended; isolated run into its own worktree",
    );
    return {
      workspace: isolated,
      mode: "isolated",
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
    claimKey: realized.key,
    claimedCwd: realized.cwd,
    contention: null,
    warnings,
  };
}
