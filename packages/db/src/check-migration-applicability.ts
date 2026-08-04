import { diagnoseMigrationApplicability } from "./client.js";
import { resolveMigrationConnection } from "./migration-runtime.js";

const jsonMode = process.argv.includes("--json");

function toError(error: unknown, context = "Migration applicability check failed"): Error {
  if (error instanceof Error) return error;
  if (error === undefined) return new Error(context);
  if (typeof error === "string") return new Error(`${context}: ${error}`);

  try {
    return new Error(`${context}: ${JSON.stringify(error)}`);
  } catch {
    return new Error(`${context}: ${String(error)}`);
  }
}

async function main(): Promise<void> {
  const connection = await resolveMigrationConnection();

  try {
    const diagnostic = await diagnoseMigrationApplicability(connection.connectionString);

    if (jsonMode) {
      console.log(JSON.stringify({ source: connection.source, ...diagnostic }));
    } else {
      if (diagnostic.unresolvedAppliedHashes.length > 0) {
        console.warn(
          `WARNING: ${diagnostic.unresolvedAppliedHashes.length} applied migration hash(es) via ${connection.source} ` +
            `do not exist in this branch (likely a cross-branch numbering collision): ` +
            diagnostic.unresolvedAppliedHashes.join(", "),
        );
      }
      for (const skippable of diagnostic.skippablePendingMigrations) {
        console.error(
          `ERROR: pending migration ${skippable.fileName} has when=${skippable.when} <= max applied ` +
            `created_at=${skippable.maxAppliedCreatedAt}; drizzle skips it forever. Renumber it and bump its ` +
            `journal \`when\` above ${skippable.maxAppliedCreatedAt}.`,
        );
      }
      if (
        diagnostic.unresolvedAppliedHashes.length === 0 &&
        diagnostic.skippablePendingMigrations.length === 0
      ) {
        console.log(`Migrations are cross-branch applicable via ${connection.source}`);
      }
    }

    // Unresolved applied hashes are a warning (a sibling migration legitimately
    // applied to this DB is not fatal). A skippable pending migration is fatal:
    // it can never apply via drizzle and must be renumbered.
    if (diagnostic.skippablePendingMigrations.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    await connection.stop();
  }
}

main().catch((error) => {
  const err = toError(error, "Migration applicability check failed");
  process.stderr.write(`${err.stack ?? err.message}\n`);
  process.exit(1);
});
