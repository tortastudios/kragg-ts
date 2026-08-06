/**
 * Shared `// kragg: ignore` suppression for native AST gates.
 *
 * Ported from `kragg/src/kragg/gates/suppress.py` (which reads Python's
 * `# kragg: ignore`). A reviewed-safe site is silenced with a suppress comment
 * on any line the flagged node spans. Suppression is per-site and visible in
 * diffs, so every exemption is reviewable exactly where it happens — there is
 * deliberately no file-level or project-level "disable" switch.
 *
 * ACCEPTED SYNTAX — exact, case-sensitive substring match on the line. The
 * line must contain either the literal text of `SUPPRESS_LINE_COMMENT` (a
 * `//` comment) or the literal text of `SUPPRESS_BLOCK_COMMENT` (the same
 * words in a `/*`-`*` `/` comment); both are declared as constants below so
 * the exact spelling lives in code rather than in prose. Usage:
 *
 *     const parsed = eval(src);        // kragg: ignore
 *
 * One space after the comment opener, one space after the colon, all
 * lowercase. Nothing else is accepted:
 * not `//kragg: ignore`, not `// KRAGG: IGNORE`, not `// kragg:ignore`. The
 * rigidity is the point — one spelling is greppable, and an exemption that is
 * hard to write by accident is hard to sprinkle around by accident. Trailing
 * text after the marker is allowed, so a reason can be given:
 * `// kragg: ignore — reviewed, the input is a compile-time constant`.
 *
 * Matching is line-based rather than AST-comment-based, matching the Python
 * original. That means the marker also suppresses when it appears inside a
 * string literal on the spanned line. Accepted: a false suppression needs
 * someone to write the exact marker into their own source, and the line-based
 * rule keeps this module independent of any particular parser.
 */

/** Line-comment form of the suppression marker. */
export const SUPPRESS_LINE_COMMENT = "// kragg: ignore";

/** Block-comment form, for suppressing inside an expression or JSX. */
export const SUPPRESS_BLOCK_COMMENT = "/* kragg: ignore */";

/** True when this single line of source carries a suppression marker. */
export function lineSuppressed(line: string): boolean {
  return (
    line.includes(SUPPRESS_LINE_COMMENT) || line.includes(SUPPRESS_BLOCK_COMMENT)
  );
}

/**
 * True when any line in the 1-based inclusive span carries the marker.
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
export function suppressed(
  lines: readonly string[],
  startLine: number,
  endLine: number = startLine,
): boolean {
  const last = Math.max(startLine, endLine);
  for (let line = startLine; line <= last; line += 1) {
    const index = line - 1;
    if (index < 0 || index >= lines.length) {
      continue;
    }
    const text = lines[index];
    if (text !== undefined && lineSuppressed(text)) {
      return true;
    }
  }
  return false;
}
