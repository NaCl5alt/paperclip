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
 *
 * VANA-4071: the enforcement above only makes sense for **git-managed** shared
 * checkouts. A non-git shared workspace (the agent home directory, a plain
 * project workspace) cannot be moved into a git worktree — there is no repo to
 * cut one from — and it has no concurrent-git-index failure mode to protect
 * against in the first place. The whole failure this module prevents (two live
 * writers committing over each other) is git-specific. So for a non-git
 * contended checkout the run fails **open**: it shares the directory, exactly as
 * every run did before VANA-4055 added enforcement. Fail-close stays the rule
 * for git checkouts where isolation is genuinely impossible. This is why the
 * 2026-09-07 rollout of the git-only fail-close regressed: in production most
 * shared workspaces are not git repositories, so fail-close was the main path,
 * not the exception, and routine same-agent overlap dropped runs on startup.
 */

export type SharedWorkspaceWriterMode = "exclusive" | "isolated" | "shared";

/**
 * How many stable (reusable) isolation slots precede the run-scoped fallback.
 *
 * Slot names are derived from the issue identifier (or agent name), so reuse
 * happens across *runs of one issue*, not across issues. The number of isolation
 * worktrees is therefore bounded by the number of distinct issues that ever
 * contend — better than one worktree per contention event, but NOT bounded by
 * peak concurrency. Reclamation is tracked separately; slots are deliberately
 * not shared between issues, which would bound the count but would also let one
 * issue's half-finished edits appear in another issue's working directory.
 */
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

/**
 * Run error code recorded when isolation was required but impossible.
 *
 * Exported because the code has to be recognised in three places that must not
 * drift: the throw site (this module), the setup-failure handler that copies it
 * onto `heartbeat_runs.error_code` (heartbeat.ts), and continuation
 * classification (recovery/service.ts). Before it was propagated, a fail-close
 * was recorded as the generic `adapter_failed`, which put shared-checkout
 * contention into the adapter-failure class and re-routed the issue to a
 * different adapter for what is a local directory conflict.
 */
export const SHARED_WORKSPACE_ISOLATION_FAILURE_CODE = "shared_workspace_isolation_failed";

export class SharedWorkspaceIsolationError extends Error {
  readonly code = SHARED_WORKSPACE_ISOLATION_FAILURE_CODE;
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
   * True when every directory this run wrote to was claimed before any checkout
   * work ran against it. False means the claim could only be taken after
   * realization — the configured `git_worktree` path, whose target depends on
   * template rendering the caller does not resolve up front — so git touched the
   * directory first. Recorded because it is the ordering guarantee this whole
   * mechanism turns on, and is otherwise invisible after the fact.
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
   * Where isolation candidate `attempt` (0-based) *would* be realized, resolved
   * without touching it.
   *
   * Required because realizing a `git_worktree` is not read-only: an existing
   * worktree at the target path is reused, which runs the configured
   * `provisionCommand` inside it. Since the leading candidates are stable,
   * reusable slots, a slot may already belong to another live run — so it must
   * be claimed before it is realized, exactly as the shared checkout is.
   * Returning null means the path cannot be resolved (e.g. not a git checkout).
   */
  resolveIsolationCandidateCwd: (attempt: number) => Promise<string | null>;
  /** Realize isolation candidate `attempt`, which this run has already claimed. */
  realizeIsolated: (attempt: number) => Promise<RealizedExecutionWorkspace>;
  /** How many isolation candidates the two callbacks above can produce. */
  isolationAttempts: number;
  /**
   * Whether the contended checkout is a git repository (VANA-4071).
   *
   * Isolation-or-fail-close only applies to git-managed checkouts: a non-git
   * shared directory cannot be moved into a worktree and has no concurrent-git
   * failure mode to protect against, so on contention it is shared (fail-open)
   * rather than failed. Optional so existing call sites keep the fail-close
   * behaviour by default; absence is read as "assume git-managed", which never
   * fails a run open by accident. Production wires this to `isGitCheckout`
   * (a `git rev-parse --git-dir`), which resolves any directory that is not
   * positively a git checkout — including one that cannot be read — as non-git,
   * i.e. shared. That is deliberate: after the 2026-09-07 fail-close regression,
   * the safe default for this fleet is to share rather than drop a run, and a
   * directory that does not resolve as git has no git index to corrupt. If the
   * callback itself throws (as opposed to returning false), the `.catch` below
   * treats that as git-managed and fails closed; the wired `isGitCheckout` never
   * throws, so the effective rule is "share unless positively git-managed".
   */
  isCheckoutGitManaged?: (cwd: string) => Promise<boolean>;
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
    alreadyRealized?: RealizedExecutionWorkspace,
  ): Promise<SharedWorkspaceWriterResult> {
    // VANA-4071 fail-open: a non-git contended checkout cannot be isolated into a
    // worktree and has no concurrent-git failure mode, so share it rather than
    // fail the run. Default to git-managed when the callback is absent or errors,
    // which keeps the fail-close path for anything we cannot positively confirm
    // is non-git. `realizeConfigured` is only reached on the shared-checkout path
    // (where it has not run yet); the git_worktree path passes its already
    // realized workspace, but that path is always git so this branch is unreached.
    const contendedIsGitManaged = input.isCheckoutGitManaged
      ? await input.isCheckoutGitManaged(contendedCwd).catch(() => true)
      : true;
    if (!contendedIsGitManaged) {
      const workspace = alreadyRealized ?? (await input.realizeConfigured());
      warnings.push(
        `Another live run holds the non-git shared checkout ${contendedCwd}; sharing it because it cannot be isolated into a worktree and has no concurrent-git failure mode.`,
      );
      input.logger?.info?.(
        {
          heartbeatRunId: input.heartbeatRunId,
          issueId: input.issueId,
          contendedCwd,
          ownerRunId: owner?.heartbeatRunId ?? null,
        },
        "Non-git shared checkout contended; sharing it (fail-open)",
      );
      return {
        workspace,
        mode: "shared",
        claimedBeforeCheckout: false,
        claimKey: null,
        claimedCwd: null,
        contention: null,
        warnings,
      };
    }

    let lastOwner = owner;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < input.isolationAttempts; attempt += 1) {
      // Claim the slot before realizing it. Realizing first would reuse — and
      // run provisioning inside — a worktree another live run is working in,
      // which is the same double-write this whole path exists to prevent.
      const candidateCwd = await input.resolveIsolationCandidateCwd(attempt).catch((error: unknown) => {
        lastError = error;
        return null;
      });
      if (!candidateCwd) break;
      const candidateIdentity = await claims.resolveIdentity(candidateCwd);
      const candidateClaim = await claimFor(candidateIdentity);
      if (!candidateClaim.claimed) {
        // Slot belongs to another live run; move on without touching it.
        lastOwner = candidateClaim.owner ?? lastOwner;
        continue;
      }

      let isolated: RealizedExecutionWorkspace;
      try {
        isolated = await input.realizeIsolated(attempt);
      } catch (error) {
        await claims
          .releaseClaim(candidateClaim.claim.id, "isolation_realize_failed")
          .catch(() => false);
        lastError = error;
        break;
      }

      const isolatedIdentity = await claims.resolveIdentity(isolated.cwd);
      // Re-resolve the candidate now that it exists, and compare *that* to where
      // realization landed. Two things change across realization for a directory
      // that never moved: the key (`path:<cwd>` before it exists, `inode:` after)
      // and, under a symlinked parent, the normalized path itself (realpath only
      // resolves once the directory is there). Comparing the pre-realization
      // identity on either field reports "moved" when nothing did — which then
      // releases the run's own claim and leaves it writing an unclaimed worktree.
      const candidateAfterRealize = await claims.resolveIdentity(candidateCwd);
      if (isolatedIdentity.cwd !== candidateAfterRealize.cwd) {
        // Realization landed somewhere other than the target — the branch was
        // already registered to a different worktree. Claim where we actually
        // are, and give back the slot we reserved but did not use.
        const actualClaim = await claimFor(isolatedIdentity);
        if (!actualClaim.claimed) {
          await claims.releaseClaim(candidateClaim.claim.id, "isolation_target_moved").catch(() => false);
          lastOwner = actualClaim.owner ?? lastOwner;
          continue;
        }
        // Only release the reservation when it is a different row. `claimFor`
        // can resolve to the *same* row via the cwd index, and releasing that
        // would drop the claim we just confirmed.
        //
        // NOTE: this guard and the re-resolved `cwd` comparison above are two
        // independent fixes for the same hole — either alone is sufficient, so
        // neither dies to a mutation of the other, and no honest test separates
        // them (while the comparison is correct, one inode cannot present two
        // normalized paths, so the same-row case is unreachable). What *is*
        // pinned is that breaking BOTH fails closed via the ownership
        // post-condition below rather than silently double-writing. Both are
        // kept deliberately; do not delete one on the grounds that the other
        // covers it.
        if (actualClaim.claim.id !== candidateClaim.claim.id) {
          await claims.releaseClaim(candidateClaim.claim.id, "isolation_target_moved").catch(() => false);
        }
      } else if (isolatedIdentity.key !== candidateIdentity.key) {
        // Same directory, now with an inode. Re-key the existing row so the
        // claim is stored under the identity later contenders will compute.
        await claimFor(isolatedIdentity);
      }

      // The post-condition this whole path exists for: the run leaves holding a
      // live claim on the directory it is about to write.
      const holdsIsolatedDirectory = await claims.holdsActiveClaim({
        heartbeatRunId: input.heartbeatRunId,
        cwd: isolatedIdentity.cwd,
      });
      if (!holdsIsolatedDirectory) {
        throw new SharedWorkspaceIsolationError(
          `Isolated worktree "${isolated.cwd}" is not claimed by this run after isolation; refusing to write an unclaimed checkout.`,
          { contendedCwd, owner: lastOwner },
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
          isolationAttempt: attempt,
        },
        "Shared checkout contended; isolated run into its own worktree",
      );
      return {
        workspace: isolated,
        mode: "isolated",
        claimedBeforeCheckout: true,
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
    // Fail-close: another live writer owns the directory and we could not move
    // out of its way, so continuing would double-write it.
    throw new SharedWorkspaceIsolationError(
      `Shared checkout "${contendedCwd}" is already claimed by another live run and this run could not be isolated into its own worktree.`,
      { contendedCwd, owner: lastOwner, cause: lastError },
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
    // which render the same branch name). Same hazard, same remedy. This path is
    // reached only for git_worktree runs, so the fail-open branch inside
    // `isolate` never fires; the realized workspace is passed so that, if it
    // ever did, it would reuse this checkout instead of realizing a second time.
    return await isolate(realized.cwd, realizedClaim.owner, workspace);
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
