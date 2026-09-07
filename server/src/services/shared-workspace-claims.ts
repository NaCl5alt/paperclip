import { stat, realpath } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns, sharedWorkspaceClaims } from "@paperclipai/db";

/**
 * Single-writer claims over on-disk checkout directories (VANA-4055).
 *
 * VANA-4049 recorded contention on `environment_leases` *after* the checkout had
 * already been realized, so it could observe double writers but never exclude
 * them. This service is the exclusion primitive: it is keyed on the physical
 * directory, it is claimed before any git mutation, and the winner is decided by
 * a partial unique index rather than by an in-process lock (which cannot span
 * the multiple server processes / concurrent runs that actually collide).
 */

// A claim whose owning run is terminal, missing, or has shown no liveness signal
// for this long is stealable. Deliberately much larger than the 5 minute orphan
// reaper interval: the reaper is the primary release path for crashed runs, and
// this TTL is only the backstop for when it, too, failed to run.
export const DEFAULT_CLAIM_STALE_AFTER_MS = 30 * 60 * 1000;

const LIVE_RUN_STATUSES = ["queued", "scheduled_retry", "running"] as const;

export type SharedWorkspaceIdentity = {
  /** Host-global identity of the directory; the unique-index key. */
  key: string;
  /** Normalized absolute path, for humans. */
  cwd: string;
  /** How `key` was derived — `inode` is exact, `path` is a best-effort fallback. */
  source: "inode" | "path";
};

export type SharedWorkspaceClaimRow = typeof sharedWorkspaceClaims.$inferSelect;

export type SharedWorkspaceClaimOwner = {
  claimId: string;
  heartbeatRunId: string | null;
  agentId: string | null;
  companyId: string | null;
  cwd: string;
  claimedAt: Date;
};

export type SharedWorkspaceClaimResult =
  | { claimed: true; claim: SharedWorkspaceClaimRow; owner: null }
  | { claimed: false; claim: null; owner: SharedWorkspaceClaimOwner | null };

/**
 * Resolve the physical identity of a checkout directory.
 *
 * String normalization alone is not enough: `/tmp/x`, `/private/tmp/x`,
 * `/tmp/x/` and (on a case-insensitive volume) `/tmp/X` are the same directory
 * and must contend. `stat()` gives the authoritative answer — device + inode —
 * and covers symlinks, bind-style aliases and case folding in one step. When the
 * directory does not exist yet we fall back to the realpath-resolved string,
 * which is still strictly better than the raw input.
 */
export async function resolveSharedWorkspaceIdentity(cwd: string): Promise<SharedWorkspaceIdentity> {
  const absolute = resolvePath(cwd);
  let canonical = absolute;
  try {
    canonical = await realpath(absolute);
  } catch {
    // Path may not exist yet; keep the resolved-but-unlinked form.
  }
  try {
    const info = await stat(canonical);
    return { key: `inode:${info.dev}:${info.ino}`, cwd: canonical, source: "inode" };
  } catch {
    return { key: `path:${canonical}`, cwd: canonical, source: "path" };
  }
}

function isUniqueViolation(error: unknown): boolean {
  const direct = (error as { code?: unknown } | null)?.code;
  const nested = (error as { cause?: { code?: unknown } } | null)?.cause?.code;
  return direct === "23505" || nested === "23505";
}

export function sharedWorkspaceClaimService(
  db: Db,
  options?: { staleAfterMs?: number; now?: () => Date },
) {
  const staleAfterMs = options?.staleAfterMs ?? DEFAULT_CLAIM_STALE_AFTER_MS;
  const now = options?.now ?? (() => new Date());

  async function loadActiveClaim(claimKey: string): Promise<SharedWorkspaceClaimRow | null> {
    return await db
      .select()
      .from(sharedWorkspaceClaims)
      .where(and(eq(sharedWorkspaceClaims.claimKey, claimKey), eq(sharedWorkspaceClaims.status, "active")))
      .then((rows) => rows[0] ?? null);
  }

  /**
   * Is the run that owns `claim` still plausibly writing to the directory?
   *
   * Terminal or vanished runs are dead outright. A run that still looks live is
   * treated as live until the TTL expires — deliberately conservative, because
   * wrongly declaring a live owner dead is the one failure mode that reintroduces
   * the double writer this service exists to prevent. Wrongly declaring a dead
   * owner live only costs the caller an isolated worktree.
   */
  async function isClaimOwnerLive(claim: SharedWorkspaceClaimRow): Promise<boolean> {
    if (!claim.heartbeatRunId) return false;
    const run = await db
      .select({ status: heartbeatRuns.status, updatedAt: heartbeatRuns.updatedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, claim.heartbeatRunId))
      .then((rows) => rows[0] ?? null);
    if (!run) return false;
    if (!(LIVE_RUN_STATUSES as readonly string[]).includes(run.status)) return false;
    const signals = [claim.heartbeatAt, run.updatedAt]
      .map((value) => (value ? new Date(value).getTime() : 0))
      .filter((value) => Number.isFinite(value));
    const lastSignal = signals.length > 0 ? Math.max(...signals) : 0;
    return now().getTime() - lastSignal <= staleAfterMs;
  }

  async function releaseClaimRow(
    claimId: string,
    reason: string,
  ): Promise<boolean> {
    const released = await db
      .update(sharedWorkspaceClaims)
      .set({
        status: "released",
        releasedAt: now(),
        releaseReason: reason,
        updatedAt: now(),
      })
      .where(and(eq(sharedWorkspaceClaims.id, claimId), eq(sharedWorkspaceClaims.status, "active")))
      .returning({ id: sharedWorkspaceClaims.id });
    return released.length > 0;
  }

  function toOwner(claim: SharedWorkspaceClaimRow): SharedWorkspaceClaimOwner {
    return {
      claimId: claim.id,
      heartbeatRunId: claim.heartbeatRunId,
      agentId: claim.agentId,
      companyId: claim.companyId,
      cwd: claim.cwd,
      claimedAt: claim.claimedAt,
    };
  }

  return {
    resolveIdentity: resolveSharedWorkspaceIdentity,
    isClaimOwnerLive,

    /**
     * Claim `identity` as the single writer for `heartbeatRunId`.
     *
     * Idempotent for the run that already owns the claim. Contention with a
     * dead owner is resolved by releasing the stale claim and retrying;
     * contention with a live owner returns `claimed: false` plus the owner so
     * the caller can isolate into its own directory (never share).
     */
    claim: async (input: {
      identity: SharedWorkspaceIdentity;
      companyId: string | null;
      agentId: string | null;
      heartbeatRunId: string;
      metadata?: Record<string, unknown> | null;
    }): Promise<SharedWorkspaceClaimResult> => {
      const { identity } = input;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const inserted = await db
            .insert(sharedWorkspaceClaims)
            .values({
              claimKey: identity.key,
              cwd: identity.cwd,
              companyId: input.companyId,
              agentId: input.agentId,
              heartbeatRunId: input.heartbeatRunId,
              status: "active",
              claimedAt: now(),
              heartbeatAt: now(),
              metadata: {
                identitySource: identity.source,
                ...(input.metadata ?? {}),
              },
            })
            .returning();
          const row = inserted[0];
          if (row) return { claimed: true, claim: row, owner: null };
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }

        const existing = await loadActiveClaim(identity.key);
        if (!existing) continue; // released underneath us; retry the insert.

        if (existing.heartbeatRunId === input.heartbeatRunId) {
          // Same run re-claiming (e.g. predicted cwd == realized cwd). Refresh
          // rather than reporting contention against ourselves.
          const refreshed = await db
            .update(sharedWorkspaceClaims)
            .set({ cwd: identity.cwd, heartbeatAt: now(), updatedAt: now() })
            .where(eq(sharedWorkspaceClaims.id, existing.id))
            .returning()
            .then((rows) => rows[0] ?? existing);
          return { claimed: true, claim: refreshed, owner: null };
        }

        if (await isClaimOwnerLive(existing)) {
          return { claimed: false, claim: null, owner: toOwner(existing) };
        }

        const stolen = await releaseClaimRow(existing.id, "owner_run_not_live");
        if (!stolen) continue; // Someone else released/replaced it; retry.
      }
      const finalOwner = await loadActiveClaim(identity.key);
      return {
        claimed: false,
        claim: null,
        owner: finalOwner && finalOwner.heartbeatRunId !== input.heartbeatRunId ? toOwner(finalOwner) : null,
      };
    },

    /** Refresh the liveness signal of every claim held by a run. */
    touch: async (heartbeatRunId: string): Promise<number> => {
      const rows = await db
        .update(sharedWorkspaceClaims)
        .set({ heartbeatAt: now(), updatedAt: now() })
        .where(
          and(
            eq(sharedWorkspaceClaims.heartbeatRunId, heartbeatRunId),
            eq(sharedWorkspaceClaims.status, "active"),
          ),
        )
        .returning({ id: sharedWorkspaceClaims.id });
      return rows.length;
    },

    /** Release every claim held by a run. Called on run end. */
    releaseForRun: async (heartbeatRunId: string, reason = "run_ended"): Promise<number> => {
      const rows = await db
        .update(sharedWorkspaceClaims)
        .set({
          status: "released",
          releasedAt: now(),
          releaseReason: reason,
          updatedAt: now(),
        })
        .where(
          and(
            eq(sharedWorkspaceClaims.heartbeatRunId, heartbeatRunId),
            eq(sharedWorkspaceClaims.status, "active"),
          ),
        )
        .returning({ id: sharedWorkspaceClaims.id });
      return rows.length;
    },

    /**
     * Backstop sweep: release active claims whose owning run is no longer live.
     * The run-end path is the primary release; this only covers hard crashes.
     */
    reapStaleClaims: async (): Promise<number> => {
      const active = await db
        .select()
        .from(sharedWorkspaceClaims)
        .where(eq(sharedWorkspaceClaims.status, "active"));
      let released = 0;
      for (const claim of active) {
        if (await isClaimOwnerLive(claim)) continue;
        if (await releaseClaimRow(claim.id, "reaped_owner_not_live")) released += 1;
      }
      return released;
    },

    listActiveForRuns: async (heartbeatRunIds: string[]): Promise<SharedWorkspaceClaimRow[]> => {
      if (heartbeatRunIds.length === 0) return [];
      return await db
        .select()
        .from(sharedWorkspaceClaims)
        .where(
          and(
            inArray(sharedWorkspaceClaims.heartbeatRunId, heartbeatRunIds),
            eq(sharedWorkspaceClaims.status, "active"),
          ),
        );
    },
  };
}

export type SharedWorkspaceClaimService = ReturnType<typeof sharedWorkspaceClaimService>;
