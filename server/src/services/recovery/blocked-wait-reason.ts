// Classifies *why* a blocked issue is waiting, from its free-text description and
// latest comment. Used by the silent-sink recovery in recovery/service.ts to
// convert an unstructured ("prose") blocked issue into one of the sanctioned
// structured forms instead of blindly flipping it back to `todo`.
//
// Sanctioned structured blocked forms (see reference: blocked has three forms):
//   1. a first-class blocker relation      -> handled upstream (relation exists)
//   2. a scheduled monitor (monitorNextCheckAt) -> "due_date" here
//   3. an `External owner:` / `External action:` wait marker -> "external_wait" here
//
// IMPORTANT (verified against b78b3fee7): `tickDueIssueMonitors` only fires a wake
// for issues in `in_progress`/`in_review`, NOT `blocked`. So setting
// monitorNextCheckAt on a blocked issue does NOT auto-fire a run — it structures the
// wait for visibility/queryability (dashboards, liveness classifier) while keeping
// "待機 run は焚かない". Callers must not assume a blocked+monitor issue auto-resumes.
//
// This module is a pure function set (no DB, no clock beyond the injected nowMs) so
// the detection heuristics can be unit-tested in isolation.

export type BlockedWaitReason =
  | { kind: "due_date"; at: Date; matchedText: string }
  | { kind: "external_wait"; owner: string; action: string }
  | { kind: "unclassifiable" };

export interface BlockedWaitReasonInput {
  description: string | null | undefined;
  latestComment: string | null | undefined;
  nowMs: number;
}

const MAX_FUTURE_DATE_MS = 400 * 24 * 60 * 60 * 1000; // ignore absurdly-far matches

// --- external / resource wait -------------------------------------------------

// Prose unblock markers agents write today, e.g.
//   "unblock owner=orch-comm / action=(1)KiCad導入 (2)…"
//   "owner: orch-comm  action: install KiCad"
// We deliberately do NOT match the structured `External owner:` form here — that is
// already form 3 and is filtered out before classification runs.
function detectExternalWait(text: string): { owner: string; action: string } | null {
  const owner =
    text.match(/unblock\s+owner\s*[:=]\s*([^\n/]+?)(?:\s*[/|]|\n|$)/im)?.[1] ??
    text.match(/(?:^|\n)\s*owner\s*[:=]\s*([^\n/]+?)(?:\s*[/|]|\n|$)/im)?.[1];
  const action =
    text.match(/(?:^|[\s/])action\s*[:=]\s*(.+?)(?:\n|$)/im)?.[1];
  if (!owner || !action) return null;
  const ownerTrim = owner.trim();
  const actionTrim = action.trim();
  if (!ownerTrim || !actionTrim) return null;
  return { owner: ownerTrim.slice(0, 120), action: actionTrim.slice(0, 240) };
}

// --- due-date wait ------------------------------------------------------------

function isValidYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function makeUtcDate(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

// Resolve a year-less M/D (or M月D日) to the next occurrence at or after `today`
// (in UTC): this year if still upcoming, otherwise next year.
function resolveYearless(m: number, d: number, nowMs: number): Date | null {
  const now = new Date(nowMs);
  const thisYear = now.getUTCFullYear();
  for (const y of [thisYear, thisYear + 1]) {
    if (!isValidYmd(y, m, d)) continue;
    const cand = makeUtcDate(y, m, d);
    if (cand.getTime() >= Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) {
      return cand;
    }
  }
  return null;
}

function collectDates(text: string, nowMs: number): { at: Date; matchedText: string }[] {
  const out: { at: Date; matchedText: string }[] = [];
  const push = (at: Date | null, matchedText: string) => {
    if (at) out.push({ at, matchedText });
  };

  // ISO / full slash / Japanese full date: YYYY-MM-DD, YYYY/MM/DD, YYYY年M月D日
  for (const re of [
    /(\d{4})-(\d{1,2})-(\d{1,2})/g,
    /(\d{4})\/(\d{1,2})\/(\d{1,2})/g,
    /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日/g,
  ]) {
    for (const mtch of text.matchAll(re)) {
      const y = Number(mtch[1]);
      const mo = Number(mtch[2]);
      const d = Number(mtch[3]);
      if (isValidYmd(y, mo, d)) push(makeUtcDate(y, mo, d), mtch[0]);
    }
  }

  // Year-less Japanese: M月D日 (skip ones already consumed by the full form above by
  // requiring no preceding 年-digit is impractical; duplicates are harmless — we take
  // the earliest future date at the end).
  for (const mtch of text.matchAll(/(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g)) {
    push(resolveYearless(Number(mtch[1]), Number(mtch[2]), nowMs), mtch[0]);
  }

  // Year-less M/D: require it is NOT part of a YYYY/MM/DD (negative lookbehind for a
  // digit+slash) and NOT followed by /digit (which would make it M/D/… ).
  for (const mtch of text.matchAll(/(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    push(resolveYearless(Number(mtch[1]), Number(mtch[2]), nowMs), mtch[0]);
  }

  return out;
}

function detectDueDate(text: string, nowMs: number): { at: Date; matchedText: string } | null {
  const future = collectDates(text, nowMs)
    .filter((c) => c.at.getTime() > nowMs && c.at.getTime() - nowMs <= MAX_FUTURE_DATE_MS)
    .sort((a, b) => a.at.getTime() - b.at.getTime());
  return future[0] ?? null;
}

export function classifyBlockedWaitReason(input: BlockedWaitReasonInput): BlockedWaitReason {
  const text = [input.description ?? "", input.latestComment ?? ""].join("\n\n");
  if (!text.trim()) return { kind: "unclassifiable" };

  // External/resource wait is more specific than a bare date reference, so it wins
  // when both are present (a resource blocker is the operative reason).
  const external = detectExternalWait(text);
  if (external) return { kind: "external_wait", owner: external.owner, action: external.action };

  const due = detectDueDate(text, input.nowMs);
  if (due) return { kind: "due_date", at: due.at, matchedText: due.matchedText };

  return { kind: "unclassifiable" };
}
