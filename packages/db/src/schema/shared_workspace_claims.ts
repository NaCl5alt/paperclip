import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";

/**
 * Single-writer claims over on-disk checkout directories.
 *
 * Unlike `environment_leases.shared_workspace_cwd` (VANA-4049) this table is
 * keyed on the *physical* directory alone and is claimed **before** any git
 * mutation happens, so it can actually exclude concurrent writers rather than
 * only record that they collided:
 *
 * - `claim_key` is a host-global filesystem identity (`dev:ino`, falling back to
 *   the realpath) — not `(company_id, cwd)`. The directory being protected is a
 *   host resource, and two companies (or two spellings of the same path) that
 *   resolve to one inode must contend.
 * - The partial unique index makes "at most one active claim per directory" a DB
 *   invariant, so the guarantee holds across processes, not just in-process.
 * - Claims are released at run end and are additionally bounded by a liveness
 *   check on the owning heartbeat run (terminal run => stale claim is stealable).
 *
 * This is deliberately a different layer from the issue-level checkout lock
 * (`issues.checkout_run_id`), which is a liveness lock over an *issue* and says
 * nothing about who may write to a directory.
 */
export const sharedWorkspaceClaims = pgTable(
  "shared_workspace_claims",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Host-global filesystem identity of the claimed directory.
    claimKey: text("claim_key").notNull(),
    // Normalized absolute path, for operators reading the table.
    cwd: text("cwd").notNull(),
    companyId: uuid("company_id").references(() => companies.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
    heartbeatRunId: uuid("heartbeat_run_id").references(() => heartbeatRuns.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
    heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    releasedAt: timestamp("released_at", { withTimezone: true }),
    releaseReason: text("release_reason"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    activeKeyUq: uniqueIndex("shared_workspace_claims_active_key_uq")
      .on(table.claimKey)
      .where(sql`${table.status} = 'active'`),
    // Second key on the normalized path. The two indexes cover each other's blind
    // spot: an inode changes when a checkout is deleted and re-cloned mid-claim
    // (same path, new inode), and a path string differs between case-aliased or
    // not-yet-created spellings of one directory (same inode, new path). A writer
    // must win both to be admitted.
    activeCwdUq: uniqueIndex("shared_workspace_claims_active_cwd_uq")
      .on(table.cwd)
      .where(sql`${table.status} = 'active'`),
    runIdx: index("shared_workspace_claims_run_idx").on(table.heartbeatRunId, table.status),
    statusHeartbeatIdx: index("shared_workspace_claims_status_heartbeat_idx").on(table.status, table.heartbeatAt),
  }),
);
