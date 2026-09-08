/**
 * The two exemption sections of `kragg brief` (TOR-1377): what this change
 * set suppressed, and what it accepted as legacy debt.
 *
 * Both are things a reviewer cannot see from the file list. A
 * `// kragg: ignore -- <reason>` is one line in a diff of hundreds, and a new
 * entry in the baseline is a line in a JSON file most reviewers scroll past.
 * Listing them under their own headings — with the reason quoted, and with a
 * bare marker called out as NOT honoured — is what makes an exemption a
 * reviewed decision rather than an accumulated one.
 *
 * DIVERGES from `brief.py`, which has neither section: the Python sibling
 * requires no suppression reason and has no violation baseline.
 *
 * Suppressions are diffed per changed file as a MULTISET of marker lines, base
 * revision against working tree, keyed on the trimmed line text. A marker
 * that merely moved (its text unchanged, its line shifted) cancels out; one
 * whose reason was edited shows as one removal and one addition, which is
 * the honest reading — the reviewer is being asked to accept a different
 * justification.
 *
 * The baseline section diffs the base revision of the file against the
 * working tree by entry identity, and flags as STALE every current entry
 * whose accepted line no longer exists in its file — a deleted or renamed
 * file, or a rewritten line. That is a cheap necessary condition, not the
 * full stale set; `kragg check` computes the exact one, because it has the
 * gate results in hand and this command deliberately does not run them.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { showAtRef } from "../../git/changes.ts";
import {
  baselineEntries,
  entryKey,
  lineFingerprint,
  readBaseline,
  type BaselineEntry,
} from "../../policy/baseline.ts";
import type { KraggPolicy } from "../../policy/policy.ts";
import { lineSuppression } from "../../util/suppress.ts";

/** What both sections need: the repo, the diff base, and the file cap. */
export interface ExemptionContext {
  readonly root: string;
  /** From `diffBase`; the same base `changedFiles` diffed against. */
  readonly base: string;
  readonly policy: KraggPolicy;
}

/** `## Suppressions` — markers added or removed in the changed files. */
export async function suppressionSection(
  ctx: ExemptionContext,
  changed: readonly string[],
): Promise<string[]> {
  const lines: string[] = [];
  for (const file of changed) {
    const before = markers((await showAtRef(ctx.root, ctx.base, file)) ?? "");
    const after = markers(readText(join(ctx.root, file)) ?? "");
    for (const marker of after) {
      if (!take(before, marker.text)) {
        lines.push(`- added ${file}:${marker.line} — ${marker.reason}`);
      }
    }
    for (const marker of before) {
      lines.push(`- removed ${file}:${marker.line} — ${marker.reason}`);
    }
  }
  return section("Suppressions", capped(lines, ctx.policy.maxViolationsPerGate));
}

/** One marker line: where it is, and its reason (or that it has none). */
interface Marker {
  readonly line: number;
  readonly text: string;
  readonly reason: string;
}

function markers(source: string): Marker[] {
  const found: Marker[] = [];
  source.split(/\r?\n/u).forEach((text, index) => {
    const marker = lineSuppression(text, index + 1);
    if (marker.kind === "honoured") {
      found.push({ line: index + 1, text: text.trim(), reason: marker.reason });
    } else if (marker.kind === "bare") {
      found.push({ line: index + 1, text: text.trim(), reason: "NO REASON (not honoured; the finding is reported)" });
    }
  });
  return found;
}

/** Remove one marker with this text from the list; false when none is left. */
function take(pool: Marker[], text: string): boolean {
  const index = pool.findIndex((marker) => marker.text === text);
  if (index === -1) {
    return false;
  }
  pool.splice(index, 1);
  return true;
}

/** `## Baseline` — entries added, removed, or gone stale. */
export async function baselineSection(ctx: ExemptionContext): Promise<string[]> {
  const relative = ctx.policy.baseline;
  if (relative === undefined) {
    return section("Baseline", [], "none configured");
  }
  const current = readBaseline(ctx.root, relative).entries;
  const before = baseEntries((await showAtRef(ctx.root, ctx.base, relative)) ?? "", relative);
  const lines: string[] = [];
  const pool = [...before];
  for (const entry of current) {
    const index = pool.findIndex((old) => entryKey(old) === entryKey(entry));
    if (index === -1) {
      lines.push(`- added ${describe(entry)}`);
    } else {
      pool.splice(index, 1);
    }
  }
  for (const entry of pool) {
    lines.push(`- removed ${describe(entry)}`);
  }
  for (const entry of current) {
    if (isStale(ctx.root, entry)) {
      lines.push(`- stale ${describe(entry)} (accepted line no longer in the file; re-run \`kragg check --update-baseline\`)`);
    }
  }
  return section("Baseline", capped(lines, ctx.policy.maxViolationsPerGate));
}

/**
 * The base revision's entries, or none when it did not exist or was not a
 * baseline. An unreadable base revision makes every current entry "added",
 * which over-reports rather than hides.
 */
function baseEntries(text: string, relative: string): readonly BaselineEntry[] {
  if (text === "") {
    return [];
  }
  try {
    return baselineEntries(JSON.parse(text), `${relative}@base#`);
  } catch {
    return [];
  }
}

/** True when the entry's accepted line cannot be found in its file any more. */
function isStale(root: string, entry: BaselineEntry): boolean {
  if (entry.fingerprint === "") {
    return false;
  }
  if (!existsSync(join(root, entry.file))) {
    return true;
  }
  const text = readText(join(root, entry.file)) ?? "";
  return !text.split(/\r?\n/u).some((line) => lineFingerprint(line) === entry.fingerprint);
}

function describe(entry: BaselineEntry): string {
  const code = entry.code === null ? "" : ` ${entry.code}`;
  return `${entry.gate} ${entry.file}${code} — ${entry.message}`;
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Cap a list the way the critical section is capped, naming the remainder. */
function capped(lines: readonly string[], cap: number): string[] {
  if (cap === 0 || lines.length <= cap) {
    return [...lines];
  }
  return [...lines.slice(0, cap), `- +${lines.length - cap} more`];
}

function section(title: string, lines: readonly string[], empty = "none"): string[] {
  return [`## ${title}`, ...(lines.length === 0 ? [empty] : lines), ""];
}
