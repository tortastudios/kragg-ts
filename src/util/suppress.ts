/**
 * Shared `// kragg: ignore -- <reason>` suppression for native AST gates.
 *
 * Ported from `kragg/src/kragg/gates/suppress.py` (which reads Python's
 * `# kragg: ignore`). A reviewed-safe site is silenced with a suppress comment
 * on any line the flagged node spans. Suppression is per-site and visible in
 * diffs, so every exemption is reviewable exactly where it happens — there is
 * deliberately no file-level or project-level "disable" switch.
 *
 * ACCEPTED SYNTAX — exact, case-sensitive substring match on the line. The
 * line must contain either the literal text of `SUPPRESS_LINE_COMMENT` (a
 * `//` comment) or the literal text of `SUPPRESS_BLOCK_COMMENT` (the opener of
 * a `/*`-`*` `/` comment), FOLLOWED BY A REASON; both markers are declared as
 * constants below so the exact spelling lives in code rather than in prose.
 * Usage:
 *
 *     const parsed = eval(src);        // kragg: ignore -- input is a compile-time constant
 *     const parsed = eval(src);        /* kragg: ignore -- input is a compile-time constant *\/
 *
 * One space after the comment opener, one space after the colon, all
 * lowercase. Nothing else is accepted:
 * not `//kragg: ignore`, not `// KRAGG: IGNORE`, not `// kragg:ignore`. The
 * rigidity is the point — one spelling is greppable, and an exemption that is
 * hard to write by accident is hard to sprinkle around by accident.
 *
 * THE REASON IS NOT OPTIONAL (TOR-1377). A bare `// kragg: ignore` is NOT
 * honoured: the gate reports the finding it tried to silence, with a note
 * naming the bare marker, so an unexplained exemption can neither accumulate
 * quietly nor hide the finding it was written over. The reason is whatever
 * follows the marker on the line (for the block form: up to the closing
 * `*\/`), after the punctuation people put between the two — `--`, `—`,
 * `:` — is stripped, exactly as `typing-strictness` judges a bare
 * `@ts-expect-error`. Its CONTENT is not judged; that is what review is for,
 * and `kragg brief` lists every added or removed marker with its reason so a
 * reviewer sees each one.
 *
 * DIVERGES from the Python sibling, whose `# kragg: ignore` needs no reason.
 * Documented in README.md and docs/spec-conformance.md.
 *
 * Matching is line-based rather than AST-comment-based, matching the Python
 * original. That means the marker also suppresses when it appears inside a
 * string literal on the spanned line. Accepted: a false suppression needs
 * someone to write the exact marker into their own source, and the line-based
 * rule keeps this module independent of any particular parser.
 */

/** Line-comment form of the suppression marker; the reason follows it. */
export const SUPPRESS_LINE_COMMENT = "// kragg: ignore";

/**
 * Block-comment form, for suppressing inside an expression or JSX. This is
 * the OPENER: the reason follows, and the comment closes with `*\/`.
 */
export const SUPPRESS_BLOCK_COMMENT = "/* kragg: ignore";

/** Punctuation people put between the marker and the actual reason. */
const REASON_LEAD = /^[\s:—–-]+/u;

/**
 * What one line, or one span, says about suppression.
 *
 * Three states, never two: `honoured` carries the reason so a reviewer (and
 * `kragg brief`) can quote it; `bare` is a marker with no reason, which is
 * reported rather than obeyed; `none` is an ordinary line.
 */
export type Suppression =
  | { readonly kind: "honoured"; readonly reason: string }
  | { readonly kind: "bare"; readonly line: number }
  | { readonly kind: "none" };

const NONE: Suppression = { kind: "none" };

/**
 * Classify one line of source. `line` is the 1-based number reported back in
 * a `bare` result; it is purely a label and defaults to 1.
 */
export function lineSuppression(text: string, line = 1): Suppression {
  const reason = markerReason(text);
  if (reason === null) {
    return NONE;
  }
  return reason === "" ? { kind: "bare", line } : { kind: "honoured", reason };
}

/** The reason text after the marker, `""` for a bare marker, `null` for no marker. */
function markerReason(text: string): string | null {
  const lineAt = text.indexOf(SUPPRESS_LINE_COMMENT);
  if (lineAt !== -1) {
    return trimReason(text.slice(lineAt + SUPPRESS_LINE_COMMENT.length));
  }
  const blockAt = text.indexOf(SUPPRESS_BLOCK_COMMENT);
  if (blockAt === -1) {
    return null;
  }
  const rest = text.slice(blockAt + SUPPRESS_BLOCK_COMMENT.length);
  const close = rest.indexOf("*/");
  return trimReason(close === -1 ? rest : rest.slice(0, close));
}

function trimReason(text: string): string {
  return text.replace(REASON_LEAD, "").trim();
}

/**
 * Classify a 1-based inclusive span: `honoured` if any line in it carries a
 * marker with a reason, else `bare` if any line carries a bare marker, else
 * `none`.
 *
 * `startLine` and `endLine` are 1-based to match every TypeScript/Node
 * diagnostic and the `Violation.line` field; `lines` is 0-based, and the
 * conversion happens here and nowhere else. Out-of-range indices are skipped
 * rather than throwing, as in the Python original — a node whose reported
 * span disagrees with the file we read is a bug in the caller, but it must
 * not crash the gate, and skipping means "not suppressed", so the violation
 * is still reported. Fail closed.
 *
 * `endLine` defaults to `startLine`, covering the single-line case.
 */
export function suppression(
  lines: readonly string[],
  startLine: number,
  endLine: number = startLine,
): Suppression {
  let bare: Suppression = NONE;
  const last = Math.max(startLine, endLine);
  for (let line = startLine; line <= last; line += 1) {
    const text = lines[line - 1];
    if (text === undefined) {
      continue;
    }
    const found = lineSuppression(text, line);
    if (found.kind === "honoured") {
      return found;
    }
    if (found.kind === "bare" && bare.kind === "none") {
      bare = found;
    }
  }
  return bare;
}

/** True when the span carries a marker WITH a reason. A bare marker is false. */
export function suppressed(
  lines: readonly string[],
  startLine: number,
  endLine: number = startLine,
): boolean {
  return suppression(lines, startLine, endLine).kind === "honoured";
}

/**
 * The message a gate reports for a finding whose marker had no reason: the
 * original message plus a note naming the bare marker and the form that would
 * have been honoured. Unchanged for `honoured` (the caller should not be
 * reporting at all) and for `none`.
 */
export function unhonouredMessage(message: string, marker: Suppression): string {
  if (marker.kind !== "bare") {
    return message;
  }
  return (
    `${message} (the \`${SUPPRESS_LINE_COMMENT}\` on line ${marker.line} names no ` +
    `reason and is not honoured; write \`${SUPPRESS_LINE_COMMENT} -- <why this site is safe>\`)`
  );
}
