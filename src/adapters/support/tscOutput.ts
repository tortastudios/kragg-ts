/**
 * Parsing `tsc --pretty false` output into violations.
 *
 * Split out of `adapters/tsc.ts`, which had grown past the structure gate's
 * file budget. The seam is the one the adapter already had internally: this
 * module is PURE TEXT -> `Violation[]` with no process, no filesystem and no
 * environment, while `tsc.ts` keeps everything about running the compiler and
 * judging whether the run can be believed. That split is also why this half is
 * testable against recorded compiler output alone.
 *
 * ── OUTPUT FORMAT: WHY TEXT, NOT JSON ──────────────────────────────────────
 * TypeScript 6.0.3 (the version bundled here, and the current release line)
 * HAS NO MACHINE-READABLE DIAGNOSTIC OUTPUT. Verified by reading the compiler
 * option table in `node_modules/typescript/lib/typescript.js`: the only
 * diagnostic-formatting option is `pretty`, and the only `*json*` options are
 * `resolvePackageJsonExports`, `resolvePackageJsonImports` and
 * `resolveJsonModule` — none of which affect reporting. There is no `--format`
 * and no SARIF/JSON reporter to prefer over the text form.
 *
 * So `--pretty false` it is, and that is a better position than it sounds,
 * because in non-pretty mode the format is a two-line function in the compiler
 * (`formatDiagnostic`) rather than a rendering pipeline:
 *
 *     `${relativeFileName}(${line + 1},${character + 1}): ` +
 *     `${diagnosticCategoryName(diagnostic)} TS${diagnostic.code}: ` +
 *     `${flattenDiagnosticMessageText(diagnostic.messageText, newLine)}`
 *
 * Three consequences, all load-bearing and all read off that source:
 *
 *  1. LINE AND COLUMN ARE 1-BASED (`line + 1`, `character + 1`).
 *  2. THE FILE PREFIX IS OPTIONAL. `formatDiagnostic` emits it only
 *     `if (diagnostic.file)`, so a config-level error arrives as a bare
 *     `error TS5058: ...`. Those are the diagnostics that mean the gate could
 *     not run at all — see `CONFIG_ERROR_CODES` in `tsc.ts`.
 *  3. A MULTI-LINE MESSAGE IS ONE DIAGNOSTIC.
 *     `flattenDiagnosticMessageText` joins a `DiagnosticMessageChain` with a
 *     newline plus two spaces of indent per nesting level, so the "Type 'X' is
 *     not assignable to type 'Y'" follow-ons are CONTINUATION LINES of the
 *     diagnostic above them. Emitting one violation per line would report a
 *     single error three or four times, which is what `parse_mypy_output`
 *     effectively does — its regex simply does not match the continuations, so
 *     they are dropped and the explanation is lost. We collapse instead.
 *
 * `--pretty false` also removes the trailing "Found 3 errors in 2 files."
 * summary and its indented `Errors  Files` table: `createReportErrorSummary`
 * returns `undefined` unless pretty is on. Those table rows are indented and
 * would otherwise be swallowed as continuation lines, so the parser keeps a
 * blank-line reset anyway — cheap, and it means the parser stays correct if
 * someone ever runs it over pretty-suppressed-but-summarised output.
 */

import type { Violation } from "../../engine/models.ts";
import { relativeToRoot, violation } from "../linters/json.ts";

/**
 * `file(line,col): category TSxxxx: message`, with the file part optional.
 *
 * `[^(]+` for the file is exact rather than lazy on purpose: a Windows path
 * (`C:\src\a.ts(3,5): ...`) contains a colon and a backslash but never a `(`,
 * so anchoring on the parenthesis is what keeps drive letters from being
 * mistaken for the `line:` separator. The known cost is a source file with a
 * literal `(` in its name, which no supported layout produces.
 *
 * The category alternation is closed to the four `DiagnosticCategory` names
 * (`diagnosticCategoryName` lowercases the enum), so a line of user source
 * echoed into the output cannot masquerade as a diagnostic.
 */
const DIAGNOSTIC =
  /^(?:(?<file>[^(]+)\((?<line>\d+),(?<column>\d+)\): )?(?<category>error|warning|message|suggestion) TS(?<code>\d+): (?<message>.*)$/;

/** An indented follow-on line of the diagnostic above it. */
const CONTINUATION = /^\s+\S/;

/**
 * Parse `tsc --pretty false` output into one violation per diagnostic.
 *
 * TOTAL: never throws, and a line that is not a diagnostic and not a
 * continuation is ignored rather than guessed at.
 *
 * `root` makes the file repo-relative. `tsc` already reports paths relative to
 * its own cwd (`convertToRelativePath` in `formatDiagnostic`), which is the
 * project root, so this is a no-op in the normal case and exists for the
 * diagnostics that carry an absolute path — a file pulled in from outside the
 * project by a path mapping, most often.
 */
export function parseTscOutput(stdout: string, root: string): readonly Violation[] {
  const violations: Violation[] = [];
  let pending: Pending | null = null;

  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") {
      // A blank line ends any diagnostic in progress. See the module header:
      // this is what keeps a summary table (or any indented trailer) from
      // being appended to the last real message.
      pending = flush(pending, violations, root);
      continue;
    }
    const match = DIAGNOSTIC.exec(line);
    if (match?.groups !== undefined) {
      pending = flush(pending, violations, root);
      pending = startDiagnostic(match.groups);
      continue;
    }
    if (pending !== null && CONTINUATION.test(line)) {
      pending.details.push(line.trim());
      continue;
    }
    // Anything else — a banner, a progress line, stray user output — ends the
    // current diagnostic and is dropped. Never guessed at.
    pending = flush(pending, violations, root);
  }
  flush(pending, violations, root);
  return violations;
}

/** A diagnostic being accumulated across its continuation lines. */
interface Pending {
  readonly file: string | undefined;
  readonly line: number | undefined;
  readonly column: number | undefined;
  readonly code: string;
  readonly head: string;
  readonly details: string[];
}

/**
 * The named captures of `DIAGNOSTIC`.
 *
 * Every group is optional in the type even though the regex makes `category`,
 * `code` and `message` mandatory: `RegExpExecArray.groups` is indexed, so the
 * compiler cannot know which names the pattern guarantees, and pretending it
 * can is exactly the cast this codebase does not make.
 */
type DiagnosticGroups = Readonly<Record<string, string | undefined>>;

function startDiagnostic(groups: DiagnosticGroups): Pending {
  return {
    file: groups["file"],
    line: positive(groups["line"]),
    column: positive(groups["column"]),
    code: `TS${groups["code"] ?? ""}`,
    head: groups["message"] ?? "",
    details: [],
  };
}

/**
 * Emit the pending diagnostic, if any.
 *
 * Continuations are joined with a single space rather than kept as newlines:
 * `Violation.message` is rendered inline by the reporter, and a message with
 * embedded newlines breaks the one-finding-per-line contract that makes gate
 * output greppable.
 */
function flush(
  pending: Pending | null,
  into: Violation[],
  root: string,
): null {
  if (pending === null) {
    return null;
  }
  const message = [pending.head, ...pending.details].join(" ").trim();
  into.push(
    violation({
      message: message === "" ? pending.code : message,
      file: pending.file === undefined ? undefined : relativeToRoot(pending.file, root),
      line: pending.line,
      column: pending.column,
      code: pending.code,
    }),
  );
  return null;
}

function positive(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}
