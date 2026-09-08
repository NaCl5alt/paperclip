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
// We require the explicit `unblock owner=` marker (not a bare `owner:`/`action:` pair)
// and do NOT match the structured `External owner:` form here — that is already form 3
// and is filtered out before classification runs.
function detectExternalWait(text: string): { owner: string; action: string } | null {
  // Require the explicit `unblock owner=…` prose marker rather than a bare
  // `owner:`/`action:` pair, which would false-positive on embedded YAML / GH-Actions
  // snippets or unrelated prose (review N1). Missing it is safe: the issue falls through
  // to the unclassifiable nudge rather than being silently marked externally-blocked.
  const owner = text.match(/unblock\s+owner\s*[:=]\s*([^\n/]+?)(?:\s*[/|]|\n|$)/im)?.[1];
  const action = text.match(/(?:^|[\s/])action\s*[:=]\s*(.+?)(?:\n|$)/im)?.[1];
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

// Resolve a year-less date to a concrete UTC day.
//   allowNextYear=true : the next occurrence at/after today (this year, else next).
//   allowNextYear=false: only this-year and only if it is today-or-future; a
//     recently-past date returns null instead of rolling ~1 year forward. This is
//     used for the ambiguous ASCII `M/D` form so "9/1" (a few days ago) is NOT read
//     as a ~360-day wait (review B1).
function resolveYearless(
  m: number,
  d: number,
  nowMs: number,
  allowNextYear: boolean,
): Date | null {
  const now = new Date(nowMs);
  const todayMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const years = allowNextYear
    ? [now.getUTCFullYear(), now.getUTCFullYear() + 1]
    : [now.getUTCFullYear()];
  for (const y of years) {
    if (!isValidYmd(y, m, d)) continue;
    const cand = makeUtcDate(y, m, d);
    if (cand.getTime() >= todayMs) return cand;
  }
  return null;
}

// Words that mark a nearby number as a date rather than a fraction/ratio/version.
const DATE_CUE =
  /(?:by|due|on|until|till|deadline|date|resume|eta|期日|期限|締切|締め切り|予定|再開|着手|まで|日付|以降|頃|予定日|リリース|公開)/i;

function hasDateCueNear(text: string, index: number, length: number): boolean {
  const window = text.slice(Math.max(0, index - 16), index + length + 16);
  return DATE_CUE.test(window);
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

  // Year-less Japanese: M月D日 — the 月/日 markers make it unambiguously a date, so we
  // accept any valid day and allow next-year roll-forward.
  for (const mtch of text.matchAll(/(?<!\d)(\d{1,2})月\s*(\d{1,2})日/g)) {
    push(resolveYearless(Number(mtch[1]), Number(mtch[2]), nowMs, true), mtch[0]);
  }

  // Year-less ASCII M/D — ambiguous with fractions/ratios/versions (`1/2`, `4/3`,
  // `v1/2`). Guards (review B1): (a) no letter/digit/`/`/`_` immediately before (drops
  // `v1/2`, YYYY/MM/DD tails); (b) accept only when the day component is > 12
  // (unambiguously a day) OR an explicit date cue sits nearby; (c) no next-year roll.
  for (const mtch of text.matchAll(/(?<![\d/\p{L}_])(\d{1,2})\/(\d{1,2})(?![\d/])/gu)) {
    const mo = Number(mtch[1]);
    const d = Number(mtch[2]);
    const unambiguousDay = d > 12;
    if (!unambiguousDay && !hasDateCueNear(text, mtch.index ?? 0, mtch[0].length)) continue;
    push(resolveYearless(mo, d, nowMs, false), mtch[0]);
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
