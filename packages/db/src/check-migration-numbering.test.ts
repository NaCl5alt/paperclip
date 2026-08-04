import { describe, expect, it } from "vitest";
import {
  checkMigrationNumbering,
  ensureJournalWhenAndIdxOrdering,
  loadJournalEntries,
  loadMigrationFiles,
  type JournalEntry,
} from "./check-migration-numbering.js";

function entry(idx: number, tag: string, when: number): JournalEntry {
  return { idx, tag, when };
}

describe("ensureJournalWhenAndIdxOrdering", () => {
  it("accepts strictly increasing when/idx", () => {
    const entries = [entry(0, "0000_a", 100), entry(1, "0001_b", 200), entry(2, "0002_c", 300)];
    expect(() => ensureJournalWhenAndIdxOrdering(entries, "journal")).not.toThrow();
  });

  it("tolerates benign internal when inversions from merged history", () => {
    // 0001_b < 0000_a is an out-of-order historical entry; only the tail matters.
    const entries = [entry(0, "0000_a", 300), entry(1, "0001_b", 200), entry(2, "0002_c", 400)];
    expect(() => ensureJournalWhenAndIdxOrdering(entries, "journal")).not.toThrow();
  });

  it("rejects a newest entry whose when does not exceed the max prior when", () => {
    const entries = [
      entry(0, "0098_x", 1780534300000),
      entry(1, "0099_y", 1780534400000),
      entry(2, "0100_dup", 1780534400000),
    ];
    expect(() => ensureJournalWhenAndIdxOrdering(entries, "journal")).toThrow(
      /not strictly greater than the max/,
    );
  });

  it("rejects a newest entry with a when below an earlier peak", () => {
    const entries = [entry(0, "0000_a", 500), entry(1, "0001_b", 200)];
    expect(() => ensureJournalWhenAndIdxOrdering(entries, "journal")).toThrow(
      /not strictly greater than the max/,
    );
  });

  it("rejects a non-increasing idx", () => {
    const entries = [entry(5, "0000_a", 100), entry(5, "0001_b", 200)];
    expect(() => ensureJournalWhenAndIdxOrdering(entries, "journal")).toThrow(/`idx`/);
  });

  it("rejects a missing when", () => {
    const entries = [{ idx: 0, tag: "0000_a" }];
    expect(() => ensureJournalWhenAndIdxOrdering(entries, "journal")).toThrow(/`when`/);
  });
});

describe("checkMigrationNumbering", () => {
  it("rejects a duplicate migration number across files", () => {
    const files = ["0000_a.sql", "0001_b.sql", "0001_c.sql"];
    const entries = [entry(0, "0000_a", 1), entry(1, "0001_b", 2), entry(2, "0001_c", 3)];
    expect(() => checkMigrationNumbering(files, entries)).toThrow(/Duplicate migration number/);
  });

  it("rejects when the newest journal when does not exceed the prior max, even if files are ordered", () => {
    const files = ["0099_prev.sql", "0100_next.sql"];
    const entries = [entry(99, "0099_prev", 1780534400000), entry(100, "0100_next", 1780534400000)];
    expect(() => checkMigrationNumbering(files, entries)).toThrow(/not strictly greater than the max/);
  });

  it("accepts a well-formed, strictly increasing set", () => {
    const files = ["0099_prev.sql", "0101_next.sql"];
    const entries = [entry(99, "0099_prev", 1780534300000), entry(101, "0101_next", 1780534500000)];
    expect(() => checkMigrationNumbering(files, entries)).not.toThrow();
  });
});

describe("repository migration journal", () => {
  it("passes every numbering and monotonicity invariant", async () => {
    const files = await loadMigrationFiles();
    const entries = await loadJournalEntries();
    expect(() => checkMigrationNumbering(files, entries)).not.toThrow();
  });
});
