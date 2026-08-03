import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { issueThreadInteractionService } from "../server/src/services/issue-thread-interactions.js";

// One-shot backfill for VANA-2574 / VANA-2571.
//
// Applies the same rule the issue-update service now enforces going forward:
// every *pending* thread interaction on an issue whose status is terminal
// (done / cancelled) is expired — all kinds, not just request_confirmation —
// with result { version: 1, outcome: "issue_closed", issueStatus }.
//
// DRY-RUN BY DEFAULT. Pass --execute to actually write. The real run is gated
// on board review, so this script is not executed as part of the implementation
// task; only its dry-run counts are reported.
//
// Usage:
//   tsx scripts/backfill-expire-pending-interactions-on-terminal-issues.ts             # dry-run
//   tsx scripts/backfill-expire-pending-interactions-on-terminal-issues.ts --company <id>
//   tsx scripts/backfill-expire-pending-interactions-on-terminal-issues.ts --execute   # writes

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function main() {
  const execute = hasFlag("--execute");
  const companyId = parseFlag("--company");

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  const interactions = issueThreadInteractionService(db);

  const result = await interactions.backfillExpirePendingInteractionsOnTerminalIssues({
    companyId,
    dryRun: !execute,
  });

  console.log(`${execute ? "[EXECUTE]" : "[DRY-RUN]"} pending interactions on terminal issues${companyId ? ` (company ${companyId})` : ""}`);
  console.log(`Total: ${result.total}`);
  for (const [status, count] of Object.entries(result.countByStatus)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log("By status / kind:");
  for (const [key, count] of Object.entries(result.countByStatusKind).sort()) {
    console.log(`  ${key}: ${count}`);
  }

  if (result.total === 0) {
    console.log("Nothing to backfill.");
    return;
  }

  if (execute) {
    console.log(`\nExpired ${result.updated} pending interaction(s).`);
  } else {
    console.log("\nDry-run only. Re-run with --execute (after board approval) to apply.");
  }
}

void main()
  .then(() => {
    // The db connection pool keeps the event loop alive; exit explicitly so this
    // one-shot script terminates.
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Backfill failed: ${message}`);
    process.exit(1);
  });
