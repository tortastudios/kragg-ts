/**
 * gitleaks adapter: command surface, exit-code classification, report parsing.
 *
 * ── THE CLI SURFACE THIS TARGETS ───────────────────────────────────────────
 * gitleaks v8, floor `MINIMUM_VERSION` (8.22.0). Verified against the upstream
 * sources, not from memory, because the surface moved twice inside v8:
 *
 *  - `detect` and `protect` were DEPRECATED in v8.19.0 and are `Hidden: true`
 *    in `cmd/detect.go` today. The replacements, per that file's own migration
 *    header, are `gitleaks git <repo>` for history and
 *    `gitleaks dir <path>` for a worktree — `dir` (aliases `file`,
 *    `directory`) is defined in `cmd/directory.go` and is the successor to
 *    `detect --no-git`.
 *  - `--report-path -` (write the report to stdout) arrived in v8.22.0:
 *    `report.StdoutReportPath` exists in v8.22.0's `report/report.go` and does
 *    not exist in v8.21.0's. This is the reason for the version floor, and the
 *    floor is enforced rather than assumed — on an older binary `-` would be
 *    taken as a FILENAME and gitleaks would drop a file called `-`, full of
 *    unredacted credentials, into the project root.
 *
 * We scan the WORKTREE (`dir`), not history (`git`). A secret already
 * committed is an incident to be rotated, not a gate a developer can turn
 * green by editing a file; and re-walking history on every `kragg check` costs
 * seconds to minutes on a real repo. History scanning belongs in CI.
 *
 * ── WHY WE PASS `--exit-code` ──────────────────────────────────────────────
 * `cmd/root.go`'s `findingSummaryAndExit` is explicit:
 *
 *     if err != nil { os.Exit(1) }
 *     if len(findings) != 0 { os.Exit(exitCode) }
 *
 * — so with the DEFAULT `--exit-code 1`, "the scan failed" and "the scan found
 * leaks" are the same status, and no amount of stderr sniffing separates them
 * reliably. Passing a distinctive `--exit-code` makes the two disjoint:
 * `LEAK_EXIT_CODE` means findings, `0` means clean, anything else means the
 * scanner broke. Getting this backwards would report a crashed scanner as a
 * clean repo, which is precisely the failure this gate exists to prevent.
 *
 * ── REDACTION ──────────────────────────────────────────────────────────────
 * gitleaks' JSON carries `Secret`, `Match`, `Line` and `Message` (the commit
 * message). `toViolation` reads an ALLOWLIST of five fields and never touches
 * the rest. Allowlist, not denylist, on purpose: a field gitleaks adds in a
 * future release cannot leak through a list of things we forgot to exclude.
 */

import { isAbsolute, join } from "node:path";

import type { Violation } from "../../engine/models.ts";
import {
  isRecord,
  own,
  plainText,
  positiveInt,
  SECRET_CODE,
  type SecretScanContext,
} from "./types.ts";

/**
 * Oldest gitleaks that supports both `dir` and `--report-path -`.
 *
 * See the module doc: below this, `-` is treated as a filename and the scan
 * writes unredacted secrets to disk. Enforced, never assumed.
 */
export const MINIMUM_VERSION: readonly [number, number, number] = [8, 22, 0];

/**
 * Exit status we ask gitleaks to use when it finds leaks.
 *
 * Any value distinct from gitleaks' own hardcoded error status (1) and from 0
 * works; 66 is chosen because it collides with nothing gitleaks itself emits
 * (it also uses 126 for an unknown flag) and is memorable in a report.
 */
export const LEAK_EXIT_CODE = 66;

/** How a gitleaks exit status should be read, given `LEAK_EXIT_CODE`. */
export type GitleaksExit = "clean" | "leaks" | "error";

/**
 * Classify gitleaks' exit status.
 *
 * The whole point of the module: `0` is a real clean scan, `LEAK_EXIT_CODE` is
 * findings, and EVERYTHING else — including gitleaks' own `1` for a partial or
 * failed scan, and `127` from `runCommand` for a missing binary or a timeout —
 * is a broken scanner. There is deliberately no "unknown, assume clean" case.
 */
export function classifyExit(returncode: number): GitleaksExit {
  if (returncode === 0) {
    return "clean";
  }
  return returncode === LEAK_EXIT_CODE ? "leaks" : "error";
}

/**
 * Parse the output of `gitleaks version`.
 *
 * Accepts `8.28.0`, `v8.28.0` and a trailing pre-release/build suffix, and
 * tolerates surrounding log noise. Returns `null` for anything else —
 * including the literal `unknown` that a `go build` from source without
 * ldflags produces. `null` is treated by the caller as "unusable", not as
 * "probably fine": a version we cannot read is a binary we cannot prove
 * supports `--report-path -`.
 */
export function parseVersion(output: string): readonly [number, number, number] | null {
  const match = /(?:^|[^\d.])v?(\d+)\.(\d+)\.(\d+)/u.exec(output.trim());
  if (match === null) {
    return null;
  }
  const [major, minor, patch] = [match[1], match[2], match[3]].map((part) =>
    Number.parseInt(part ?? "", 10),
  );
  if (major === undefined || minor === undefined || patch === undefined) {
    return null;
  }
  return Number.isNaN(major) || Number.isNaN(minor) || Number.isNaN(patch)
    ? null
    : [major, minor, patch];
}

/** Whether a parsed version is at least `MINIMUM_VERSION`. */
export function versionSupported(version: readonly [number, number, number]): boolean {
  for (let index = 0; index < 3; index += 1) {
    const found = version[index] ?? 0;
    const needed = MINIMUM_VERSION[index] ?? 0;
    if (found !== needed) {
      return found > needed;
    }
  }
  return true;
}

/** The argv for the version probe. */
export function versionCommand(bin: string): readonly string[] {
  return [bin, "version"];
}

/**
 * The argv for one worktree scan.
 *
 * One target per invocation: `dir` takes a single optional positional path.
 * The caller runs this once per configured target and concatenates.
 *
 * `--report-path -` keeps the report — which contains the raw credentials —
 * in a pipe and off the filesystem entirely. `--no-banner` and
 * `--log-level error` keep gitleaks' human chatter out of the way; the report
 * goes to stdout and the chatter to stderr, so they do not mix.
 */
export function scanCommand(context: SecretScanContext, target: string): readonly string[] {
  const command: string[] = [
    context.bin,
    "dir",
    "--no-banner",
    "--log-level",
    "error",
    "--report-format",
    "json",
    "--report-path",
    "-",
    "--exit-code",
    String(LEAK_EXIT_CODE),
  ];
  if (context.baselinePath !== null) {
    command.push("--baseline-path", absolutePath(context.root, context.baselinePath));
  }
  command.push(absolutePath(context.root, target));
  return command;
}

function absolutePath(root: string, path: string): string {
  return isAbsolute(path) ? path : join(root, path);
}

/**
 * Turn a gitleaks JSON report into violations.
 *
 * Returns `null` when the payload is not a JSON array — gitleaks emits `[]`
 * for a clean scan and an array of findings otherwise, so anything else means
 * the report is not a report and the caller must treat the run as broken
 * rather than as clean. An INDIVIDUAL malformed entry is skipped, because one
 * unreadable finding should not discard the readable ones alongside it.
 *
 * gitleaks writes `null` rather than `[]` in some paths; that is accepted as
 * an empty report, since it is unambiguously "no findings".
 */
export function parseReport(payload: string): readonly Violation[] | null {
  const trimmed = payload.trim();
  if (trimmed === "") {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (parsed === null) {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  const violations: Violation[] = [];
  for (const entry of parsed) {
    const violation = toViolation(entry);
    if (violation !== null) {
      violations.push(violation);
    }
  }
  return violations;
}

/**
 * One finding, reduced to the fields that are safe to publish.
 *
 * THE ALLOWLIST, and the reason for each entry:
 *
 *  - `RuleID`      — a rule identifier such as `aws-access-token`. Metadata.
 *  - `Description` — the rule's own description from the gitleaks config.
 *                    Metadata about the RULE, not about the match.
 *  - `File`        — a path. The whole point of the report.
 *  - `StartLine`   — a line number.
 *  - `StartColumn` — a column number.
 *
 * Everything else is dropped, and these three are dropped ON PURPOSE:
 *
 *  - `Secret` and `Match` ARE the credential, verbatim;
 *  - `Line` is the whole source line the credential sits on (it carries
 *    `json:"-"` upstream so it should not appear at all, but a `template`
 *    report or a future change could reintroduce it);
 *  - `Message` is the commit message, arbitrary untrusted prose;
 *  - `Fingerprint`, `Author`, `Email`, `Date`, `Commit`, `Entropy`, `Link`,
 *    `Tags` are not secret but are not actionable in a violation either, and
 *    every field NOT read is one that cannot leak.
 *
 * gitleaks' JSON keys are Go field names (the struct carries no `json:` name
 * tags), so they are PascalCase — `RuleID`, not `ruleId`.
 */
function toViolation(entry: unknown): Violation | null {
  if (!isRecord(entry)) {
    return null;
  }
  const rule = plainText(own(entry, "RuleID"), "unknown-rule");
  const description = plainText(own(entry, "Description"), "");
  const file = plainText(own(entry, "File"), "");
  const detail = description === "" || description === rule ? "" : `: ${description}`;
  return {
    message: `potential secret [${rule}]${detail}`,
    file: file === "" ? undefined : file,
    line: positiveInt(own(entry, "StartLine")),
    column: positiveInt(own(entry, "StartColumn")),
    code: SECRET_CODE,
    fixHint:
      "remove the credential and rotate it — assume it is compromised. If it " +
      "is a fixture or a false positive, add a `gitleaks:allow` comment or " +
      "record it in the baseline named by `secret_baseline`.",
  };
}
