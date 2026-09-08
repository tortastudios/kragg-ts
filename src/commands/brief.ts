/**
 * `kragg brief` — the change set, digested for a human reviewer.
 *
 * The port of `kragg/src/kragg/brief.py` and its `cmd_brief`. The premise from
 * kragg's README: a vibe-coded change is sane when a reviewer can grasp it in
 * minutes. So the brief answers three questions in markdown a PR description
 * can take verbatim — WHAT MOVED (files, grouped by area), WHAT IT RISKS
 * (critical functions touched, with fan-in), and WHETHER IT WAS CHECKED (the
 * last recorded gate run).
 *
 * The middle section is the one that does not exist anywhere else. A reviewer
 * skimming twelve changed files cannot tell which of them is load-bearing;
 * `.kragg/criticality.json` can, and says so with a number.
 *
 * ── NOT A GIT REPOSITORY IS NOT AN EMPTY CHANGE SET ────────────────────────
 * `changedFiles` returns `null` for "git cannot answer" and `[]` for "nothing
 * changed", and that distinction is load-bearing here exactly as it is for
 * `check --changed`: a brief that printed "0 files changed" outside a
 * repository would be a confident, wrong answer. {@link buildBrief} propagates
 * the `null` and {@link runBrief} turns it into the specific stderr message
 * `cmd_brief` prints, with `EXIT_ENVIRONMENT` — a broken environment, not a
 * failed review.
 *
 * ── TWO DELIBERATE DIVERGENCES FROM `brief.py` ─────────────────────────────
 * 1. FILE SET IS TS/JS ONLY. `brief.py` runs its own `git diff --name-only`
 *    and lists every changed path, `README.md` included. This uses
 *    `git/changes.ts`, which additionally filters to `SOURCE_EXTENSIONS`. The
 *    alternative was a second, parallel git query in this file — and the whole
 *    reason `changes.ts` exists is that "what changed" must have ONE
 *    implementation, or `brief` and `check --changed` eventually disagree
 *    about what this change set is. A brief that agrees with the gates and
 *    omits `package.json` is more useful than one that lists everything and
 *    quietly diverges. Documented rather than hidden: the stats line says
 *    "source files changed", not "files changed".
 * 2. NO `+added / -deleted` COUNTS. Python computes them from `git diff
 *    --numstat`, which would mean re-deriving the merge-base that
 *    `changes.ts` resolves privately. Duplicating that resolution is how the
 *    two end up diffing against different bases. Line counts are the least
 *    informative thing on the Python line anyway — the reviewer is about to
 *    read the diff.
 *
 * ── THE GATE SECTION IS EVIDENCE FROM ELSEWHERE, AND SAYS SO ───────────────
 * `## Last gate run` is not a run. It is a summary of `.kragg/history.jsonl`,
 * written by some earlier `kragg check` — possibly at a different commit, on
 * a different working tree, before every file listed above it existed. Read
 * without that context, "last run: PASS" under a list of twelve changed files
 * reads as "these twelve files passed", which is the single most dangerous
 * sentence this document could imply. So the section names its source, says
 * nothing was re-run for the brief, and prints the recorded commit against
 * the current one whenever the two disagree. It never carries a gate's raw
 * tool output either: a scanner's stdout pasted into a review digest is how
 * an untrusted string ends up read as a finding.
 *
 * ── A CHANGE SET CAN ALSO BE TOO BIG TO READ ───────────────────────────────
 * `--path` narrows the digest to one area and `--limit` bounds the file
 * lists, with `--limit 0` / `--all` restoring the full listing. The budget is
 * DISPLAY ONLY: the stats line and the critical-function analysis both use
 * the whole (path-filtered) change set, and a trimmed list says so on its own
 * line. See `commands/inventory.ts`.
 */

import { EXIT_ENVIRONMENT, EXIT_OK, EXIT_USAGE } from "../engine/report.ts";
import { readRuns, renderStatusLines, type JournalEntry } from "../engine/journal.ts";
import { changedFiles, gitDirty, gitSha } from "../git/changes.ts";
import { criticalFunctions } from "../gates/testDepth/criticalFunctions.ts";
import type { TypeScriptApi } from "../analysis/sourceFile.ts";
import { loadPolicy, PolicyError, type KraggPolicy } from "../policy/policy.ts";
import {
  applyBudget,
  DEFAULT_LIMIT,
  normalizePath,
  truncationNote,
  underAnyPath,
  type Budgeted,
} from "./inventory.ts";

/** What `cmd_brief` prints to stderr when git cannot answer. */
export const NOT_A_REPOSITORY_MESSAGE = "not a git repository (required for brief)";

/** Where the gate section's numbers come from, stated in the document itself. */
export const JOURNAL_PROVENANCE =
  "From `.kragg/history.jsonl`, recorded by an earlier `kragg check`. " +
  "Nothing was re-run for this brief.";

/** How many journal entries the gate section summarises, as in Python. */
const JOURNAL_WINDOW = 10;

/** Inputs for {@link runBrief}. Everything optional so the CLI can pass a subset. */
export interface BriefOptions {
  /** Project root. Defaults to the current working directory. */
  readonly root?: string | undefined;
  /**
   * Ref to diff against. `null`/absent is the working tree against `HEAD`; a
   * branch name diffs from the merge base, so `--since main` reports what this
   * branch changed and not what main gained underneath it.
   */
  readonly since?: string | null | undefined;
  /** Pre-loaded policy. Loaded from the root when absent. */
  readonly policy?: KraggPolicy | undefined;
  /** Compiler used to map modules to files. Defaults to the project's own. */
  readonly api?: TypeScriptApi | undefined;
  /** `--path`: narrow the digest to changed files under these prefixes. */
  readonly paths?: readonly string[] | undefined;
  /** `--limit`: changed files to list. `0` lists them all. */
  readonly limit?: number | undefined;
}

/**
 * Print the markdown brief.
 *
 * `EXIT_ENVIRONMENT` when git cannot answer — the one non-zero outcome, and
 * it says the tool could not run, not that the change is bad.
 */
export async function runBrief(options: BriefOptions = {}): Promise<number> {
  const root = options.root ?? process.cwd();
  let policy: KraggPolicy;
  try {
    policy = options.policy ?? loadPolicy(root);
  } catch (error) {
    if (error instanceof PolicyError) {
      process.stderr.write(`${error.message}\n`);
      return EXIT_USAGE;
    }
    throw error;
  }
  // Under `exactOptionalPropertyTypes` an absent key and a present-but-
  // undefined one are different things, so `api: undefined` is a type error
  // and the key must be omitted rather than set. Named, because a conditional
  // spread buried in a call argument is hard to read as deliberate.
  const apiOption = options.api === undefined ? {} : { api: options.api };
  const text = await buildBrief({
    root,
    since: options.since ?? null,
    policy,
    paths: options.paths ?? [],
    limit: options.limit ?? DEFAULT_LIMIT,
    ...apiOption,
  });
  if (text === null) {
    process.stderr.write(`${NOT_A_REPOSITORY_MESSAGE}\n`);
    return EXIT_ENVIRONMENT;
  }
  process.stdout.write(text);
  return EXIT_OK;
}

/** Resolved inputs for {@link buildBrief}. */
export interface BuildBriefOptions {
  readonly root: string;
  readonly since: string | null;
  readonly policy: KraggPolicy;
  readonly api?: TypeScriptApi | undefined;
  /** Path prefixes to keep. Absent or empty keeps the whole change set. */
  readonly paths?: readonly string[] | undefined;
  /** Changed files to list; `0` lists them all. Absent means no budget. */
  readonly limit?: number | undefined;
}

/**
 * Build the markdown brief, or `null` when git cannot answer.
 *
 * Separated from {@link runBrief} so the document is testable without a
 * process: it is a pure function of the repository state.
 */
export async function buildBrief(options: BuildBriefOptions): Promise<string | null> {
  const { policy } = options;
  const changed = await changedFiles(options.root, options.since, [
    ...policy.sourcePaths,
    ...policy.testPaths,
    ".",
  ]);
  if (changed === null) {
    return null;
  }
  const paths = options.paths ?? [];
  const visible = changed.filter(
    (file) => !isArtifact(file) && (paths.length === 0 || underAnyPath(file, paths)),
  );
  const lines = [
    "# Change brief",
    "",
    statsLine(visible.length, options.since),
    "",
    // The budget applies to the LISTING only. `statsLine` above and
    // `criticalSection` below both read `visible`, so a trimmed list never
    // changes the count a reviewer is told or the risk analysis they get.
    ...groupedSections(applyBudget(visible, options.limit ?? 0), policy),
    ...criticalSection(options, visible),
    ...(await gateSection(options.root)),
  ];
  return `${lines.join("\n").replace(/\s+$/, "")}\n`;
}

/* --- Sections ------------------------------------------------------------- */

function statsLine(count: number, since: string | null): string {
  const noun = count === 1 ? "source file" : "source files";
  return `${count} ${noun} changed vs ${since ?? "HEAD"}`;
}

/**
 * Changed files under `## Source` / `## Tests` / `## Other`.
 *
 * The three headings are Python's, and the order is fixed rather than derived
 * so two briefs of the same change set are byte-identical — a brief that
 * reshuffles its own sections is useless as a PR description you re-generate.
 */
function groupedSections(
  changed: Budgeted<string>,
  policy: KraggPolicy,
): string[] {
  const groups = new Map<string, string[]>([
    ["Source", []],
    ["Tests", []],
    ["Other", []],
  ]);
  for (const name of changed.entries) {
    groups.get(area(name, policy))?.push(name);
  }
  const lines: string[] = [];
  for (const title of ["Source", "Tests", "Other"]) {
    const members = groups.get(title) ?? [];
    if (members.length === 0) {
      continue;
    }
    lines.push(`## ${title}`);
    lines.push(...members.map((name) => `- ${name}`));
    lines.push("");
  }
  const note = truncationNote(changed, "changed files");
  if (note !== null) {
    lines.push(note, "");
  }
  return lines;
}

/**
 * Which area a path belongs to.
 *
 * TESTS WIN TIES. A repo whose policy lists `.` as a source path — or one
 * with `src/` holding colocated `*.test.ts` — would otherwise file every test
 * under Source and leave the Tests section permanently empty, which is the
 * section a reviewer checks first.
 */
function area(name: string, policy: KraggPolicy): string {
  if (underAnyPath(name, policy.testPaths) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(name)) {
    return "Tests";
  }
  return underAnyPath(name, policy.sourcePaths) ? "Source" : "Other";
}

/**
 * Critical functions defined in the changed files, ranked by fan-in.
 *
 * This is the section the reviewer reads to decide how hard to look. It is
 * empty on most changes, and that emptiness is itself the signal — Python
 * prints `none` rather than omitting the heading, and so does this.
 *
 * CAPPED at `maxViolationsPerGate`, which Python is not. The rank makes the
 * cap safe: the entries that fall off are the lowest-fan-in ones. A first
 * commit touching every file otherwise renders a hundred-line section that a
 * reviewer scrolls past, taking the top of the list — the part that mattered
 * — with it. The changed-file lists above are NOT capped, because those are
 * the change set itself rather than derived analysis of it.
 */
function criticalSection(
  options: BuildBriefOptions,
  changed: readonly string[],
): string[] {
  const changedSet = new Set(changed);
  const touched = criticalFunctions(
    options.root,
    options.policy.sourcePaths,
    options.api === undefined ? {} : { api: options.api },
  )
    .filter((critical) => changedSet.has(critical.file))
    .sort((left, right) => right.fanIn - left.fanIn);
  const cap = options.policy.maxViolationsPerGate;
  const lines = ["## Critical functions touched"];
  if (touched.length === 0) {
    lines.push("none");
  } else {
    lines.push(
      ...touched
        .slice(0, cap)
        .map(
          (critical) =>
            `- \`${critical.qualname}\` (fan-in ${critical.fanIn}) in ${critical.file}`,
        ),
    );
    if (touched.length > cap) {
      lines.push(`- +${touched.length - cap} more, ranked by fan-in`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * The last recorded gate run, from `.kragg/history.jsonl`, labelled as such.
 *
 * Reading the journal is the whole point — `brief` must never run a gate, or
 * a review digest becomes a minutes-long build — but a recorded verdict is
 * evidence about the commit it was recorded at, not about the change set
 * above it. The provenance line and {@link staleness} are what keep the two
 * apart, so a stale PASS cannot be read as this change having been checked.
 */
async function gateSection(root: string): Promise<string[]> {
  const runs = readRuns(root, JOURNAL_WINDOW);
  const lines = ["## Last gate run", JOURNAL_PROVENANCE];
  const last = runs.at(-1);
  if (last === undefined) {
    lines.push("no recorded runs (run `kragg check`)");
    return lines;
  }
  lines.push(...renderStatusLines(runs));
  const note = staleness(last, await gitSha(root), await gitDirty(root));
  if (note !== null) {
    lines.push(note);
  }
  return lines;
}

/**
 * Why the recorded verdict may not describe the change set above, or `null`.
 *
 * Three ways it can fail to, in the order they mislead: a different commit, a
 * commit nobody can identify, and the same commit checked with the tree in a
 * different state. A clean tree at the recorded commit is the one case where
 * the verdict really does describe what is here, and then this says nothing.
 */
function staleness(
  last: JournalEntry,
  head: string | null,
  dirty: boolean,
): string | null {
  const recorded = last.git_sha;
  if (recorded === null || head === null) {
    return "stale: recorded against an unidentified commit — re-run `kragg check`.";
  }
  if (recorded !== head) {
    return (
      `stale: recorded at ${recorded}, but HEAD is ${head} — ` +
      "that verdict predates the change set above. Re-run `kragg check`."
    );
  }
  if (last.git_dirty || dirty) {
    return (
      `stale: recorded at ${recorded} with uncommitted changes in the tree — ` +
      "what was checked is not necessarily what is listed above."
    );
  }
  return null;
}

/* --- Helpers -------------------------------------------------------------- */

/**
 * kragg's own artifacts, excluded from the brief.
 *
 * `.kragg/` holds the run journal, the criticality graph and the map — all
 * written BY the tool producing this document. Listing them as changes the
 * reviewer should look at is noise, and Python excludes them for the same
 * reason.
 */
function isArtifact(name: string): boolean {
  return normalizePath(name).startsWith(".kragg/");
}
