import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url));
const journalPath = fileURLToPath(new URL("./migrations/meta/_journal.json", import.meta.url));

export type JournalEntry = {
  idx?: number;
  tag?: string;
  when?: number;
};

type JournalFile = {
  entries?: JournalEntry[];
};

export function migrationNumber(value: string): string | null {
  const match = value.match(/^(\d{4})_/);
  return match ? match[1] : null;
}

export function ensureNoDuplicates(values: string[], label: string) {
  const seen = new Map<string, string>();

  for (const value of values) {
    const number = migrationNumber(value);
    if (!number) {
      throw new Error(`${label} entry does not start with a 4-digit migration number: ${value}`);
    }
    const existing = seen.get(number);
    if (existing) {
      throw new Error(`Duplicate migration number ${number} in ${label}: ${existing}, ${value}`);
    }
    seen.set(number, value);
  }
}

export function ensureStrictlyOrdered(values: string[], label: string) {
  const sorted = [...values].sort();
  for (let index = 0; index < values.length; index += 1) {
    if (values[index] !== sorted[index]) {
      throw new Error(
        `${label} are out of order at position ${index}: expected ${sorted[index]}, found ${values[index]}`,
      );
    }
  }
}

export function ensureJournalMatchesFiles(migrationFiles: string[], journalTags: string[]) {
  const journalFiles = journalTags.map((tag) => `${tag}.sql`);

  if (journalFiles.length !== migrationFiles.length) {
    throw new Error(
      `Migration journal/file count mismatch: journal has ${journalFiles.length}, files have ${migrationFiles.length}`,
    );
  }

  for (let index = 0; index < migrationFiles.length; index += 1) {
    const migrationFile = migrationFiles[index];
    const journalFile = journalFiles[index];
    if (migrationFile !== journalFile) {
      throw new Error(
        `Migration journal/file order mismatch at position ${index}: journal has ${journalFile}, files have ${migrationFile}`,
      );
    }
  }
}

/**
 * drizzle's native migrator applies pending migrations only while
 * `folderMillis > lastAppliedCreatedAt` (a single cutoff fetched once per run),
 * so a newly appended migration whose `when` does not exceed the max `when`
 * already in the journal is silently skipped and never runs.
 *
 * We deliberately do NOT require the whole journal to be strictly increasing:
 * merged history legitimately contains internal `when` inversions (older
 * migrations that were only ever applied together on a fresh DB, so the cutoff
 * never bit). Enforcing global monotonicity would fail on that benign history.
 *
 * Instead we enforce the forward-looking invariant that actually matters when
 * appending work: the newest (last) entry must have a strictly greater `when`
 * than every preceding entry, and `idx` must be strictly increasing.
 *
 * NOTE: this static check cannot see a *cross-branch* collision — where a
 * sibling branch's migration was applied to a live DB under a number this branch
 * reuses (the exact VANA-2651 failure). That is inherently DB-aware and is
 * covered by `diagnoseMigrationApplicability` / `pnpm db:check:migrations:db`.
 */
export function ensureJournalWhenAndIdxOrdering(entries: JournalEntry[], label: string) {
  let previousIdx: number | null = null;
  let previousIdxTag: string | null = null;

  entries.forEach((entry, position) => {
    const tag = typeof entry.tag === "string" && entry.tag.length > 0 ? entry.tag : `#${position}`;

    if (typeof entry.when !== "number" || !Number.isFinite(entry.when)) {
      throw new Error(`${label} entry ${tag} is missing a numeric \`when\` timestamp`);
    }
    if (typeof entry.idx !== "number" || !Number.isInteger(entry.idx)) {
      throw new Error(`${label} entry ${tag} is missing an integer \`idx\``);
    }

    if (previousIdx !== null && entry.idx <= previousIdx) {
      throw new Error(
        `${label} \`idx\` is not strictly increasing at ${tag}: ${entry.idx} follows ${previousIdx} (${previousIdxTag}).`,
      );
    }

    previousIdx = entry.idx;
    previousIdxTag = tag;
  });

  if (entries.length >= 2) {
    const last = entries[entries.length - 1];
    const lastTag =
      typeof last.tag === "string" && last.tag.length > 0 ? last.tag : `#${entries.length - 1}`;
    const lastWhen = last.when as number;
    let maxPriorWhen = -Infinity;
    let maxPriorTag = "";
    for (let index = 0; index < entries.length - 1; index += 1) {
      const priorWhen = entries[index].when as number;
      if (priorWhen > maxPriorWhen) {
        maxPriorWhen = priorWhen;
        maxPriorTag = entries[index].tag ?? `#${index}`;
      }
    }
    if (lastWhen <= maxPriorWhen) {
      throw new Error(
        `${label} newest entry ${lastTag} has \`when\`=${lastWhen} which is not strictly greater than the max ` +
          `existing \`when\`=${maxPriorWhen} (${maxPriorTag}). A newly appended migration whose \`when\` does not ` +
          "exceed every prior migration is skipped by drizzle and never runs; bump its `when` above the max.",
      );
    }
  }
}

export async function loadMigrationFiles(): Promise<string[]> {
  return (await readdir(migrationsDir)).filter((entry) => entry.endsWith(".sql")).sort();
}

export async function loadJournalEntries(): Promise<JournalEntry[]> {
  const rawJournal = await readFile(journalPath, "utf8");
  const journal = JSON.parse(rawJournal) as JournalFile;
  return journal.entries ?? [];
}

export function checkMigrationNumbering(migrationFiles: string[], journalEntries: JournalEntry[]) {
  ensureNoDuplicates(migrationFiles, "migration files");
  ensureStrictlyOrdered(migrationFiles, "migration files");

  const journalTags = journalEntries.map((entry, index) => {
    if (typeof entry.tag !== "string" || entry.tag.length === 0) {
      throw new Error(`Migration journal entry ${index} is missing a tag`);
    }
    return entry.tag;
  });

  ensureNoDuplicates(journalTags, "migration journal");
  ensureStrictlyOrdered(journalTags, "migration journal");
  ensureJournalMatchesFiles(migrationFiles, journalTags);
  ensureJournalWhenAndIdxOrdering(journalEntries, "migration journal");
}

async function main() {
  const migrationFiles = await loadMigrationFiles();
  const journalEntries = await loadJournalEntries();
  checkMigrationNumbering(migrationFiles, journalEntries);
}

// Only run the check when executed directly, not when imported by tests.
const isDirectRun = process.argv[1] === fileURLToPath(import.meta.url);
if (isDirectRun) {
  await main();
}
