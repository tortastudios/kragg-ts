/**
 * The one advisory shape every package manager's audit output is normalized
 * into, plus the severity floor and the network-failure detector.
 *
 * FOUR TOOLS, FOUR INCOMPATIBLE JSON FORMATS. This is not an exaggeration:
 * npm emits a keyed-by-package "bulk advisory" report, pnpm emits a
 * keyed-by-advisory-id report whose SHAPE CHANGED between pnpm 10 and 11,
 * yarn classic emits NDJSON of `{type, data}` envelopes, yarn berry emits
 * NDJSON of a rendered TREE with human-readable keys like
 * `"Vulnerable Versions"`, and bun echoes the registry's raw bulk response
 * with no envelope at all. Each has its own parser
 * (`auditNpm.ts`, `auditPnpm.ts`, `auditYarn.ts`, `auditBun.ts`); all four
 * produce `Advisory` values, and only that shape reaches the report.
 *
 * WHAT IS NOT UNIFORMLY AVAILABLE, stated so no parser is tempted to invent
 * it: **npm and bun do not report the INSTALLED version**. npm's report gives
 * `nodes: ["node_modules/foo"]` and a vulnerable `range`, never the version on
 * disk; bun echoes the registry response, which never knew. pnpm
 * (`findings[].version`) and yarn berry (`Tree Versions`) do report it.
 * `installedVersion` is therefore optional and is rendered as `?` when
 * unknown — the same choice `parse_pip_audit_json` makes in the Python
 * sibling — rather than being guessed from a lockfile kragg has not read.
 */

import type { Violation } from "../../engine/models.ts";
import type { PackageManager } from "../../environment/project.ts";

/**
 * Advisory severities, LOWEST FIRST.
 *
 * The order is the comparison: `auditSeverity` names a floor and everything at
 * or above it is reported. Shared by all four tools — they agree on this
 * vocabulary even where they agree on nothing else, because they all consume
 * the same GitHub Advisory Database.
 */
export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;

export type Severity = (typeof SEVERITIES)[number];

/**
 * The default floor.
 *
 * Mirrors bandit's `-ll` in the Python sibling, which reports only
 * medium-and-above. The reasoning transfers exactly: a transitive `info`
 * advisory on a build-time-only package is not something a project should be
 * blocked on, and a gate that blocks on it gets switched off — after which it
 * stops catching the `critical` one too.
 */
export const DEFAULT_SEVERITY_FLOOR: Severity = "high";

/** Narrow an arbitrary string to a known severity. */
export function toSeverity(value: string | undefined): Severity | undefined {
  const lowered = value?.toLowerCase();
  return SEVERITIES.find((severity) => severity === lowered);
}

/**
 * Is `severity` at or above `floor`?
 *
 * An UNKNOWN severity — a value the tool emitted that is not in the
 * vocabulary — is reported regardless of the floor. Fail closed: a severity we
 * cannot rank is not evidence that the vulnerability is unimportant.
 */
export function meetsFloor(severity: Severity | undefined, floor: Severity): boolean {
  if (severity === undefined) {
    return true;
  }
  return SEVERITIES.indexOf(severity) >= SEVERITIES.indexOf(floor);
}

/** One vulnerability, normalized. Optional fields are genuinely unavailable. */
export interface Advisory {
  readonly packageName: string;
  /** `undefined` when the tool does not report it — npm and bun never do. */
  readonly installedVersion?: string | undefined;
  /** `undefined` when the tool emitted a severity outside the vocabulary. */
  readonly severity?: Severity | undefined;
  /** GHSA id preferred, numeric advisory id otherwise. */
  readonly id?: string | undefined;
  readonly title?: string | undefined;
  readonly url?: string | undefined;
  /** The vulnerable semver range, as the advisory states it. */
  readonly vulnerableRange?: string | undefined;
  /** A version known to contain the fix, when the tool names one. */
  readonly fixedIn?: string | undefined;
}

/**
 * What a per-manager parser returns.
 *
 * `unreadable` and `offline` are separated at the PARSER, not guessed later,
 * because for two of these tools the difference is visible only in the
 * document itself: npm emits well-formed JSON on a network failure, just a
 * completely different document (`{ message, method, uri, statusCode }` with
 * no `auditReportVersion`), and yarn berry emits well-formed NDJSON whose
 * lines are `{ type: "error" }` envelopes instead of results. Only the parser
 * is in a position to tell those from a real, empty report.
 */
export type AuditParse =
  | { readonly ok: true; readonly advisories: readonly Advisory[] }
  | { readonly ok: false; readonly reason: "offline" | "unreadable"; readonly message: string };

/** Render one advisory as a violation.
 *
 * Deliberately shaped after `parse_pip_audit_json`:
 *
 *     f"{name} {version} is vulnerable (fixed in: {fixed_in})"
 *
 * with the advisory id as `code` and an upgrade command as the fix hint. The
 * differences are additive and each earns its place: the SEVERITY is in the
 * message because the floor is configurable and a reader needs to see which
 * side of it a finding sits on, and the URL is in the fix hint because an
 * advisory a reader cannot open is one they cannot judge.
 */
export function advisoryViolation(advisory: Advisory, manager: PackageManager): Violation {
  const version = advisory.installedVersion ?? "?";
  const severity = advisory.severity ?? "unknown severity";
  const fix = advisory.fixedIn ?? "no fix released";
  const title = advisory.title === undefined ? "" : ` — ${advisory.title}`;
  return {
    message:
      `${advisory.packageName} ${version} is vulnerable ` +
      `(${severity}; fixed in: ${fix})${title}`,
    // package.json is where the reader acts, even when the vulnerable package
    // is transitive: the fix is an upgrade or an override, both of which are
    // edits to the manifest.
    file: "package.json",
    code: advisory.id ?? "advisory",
    fixHint: fixHint(advisory, manager),
  };
}

function fixHint(advisory: Advisory, manager: PackageManager): string {
  const reference = advisory.url === undefined ? "" : ` (${advisory.url})`;
  if (advisory.fixedIn === undefined) {
    return (
      "no fixed version published; consider an override or removing the " +
      `dependency${reference}`
    );
  }
  return `upgrade: ${upgradeCommand(manager, advisory.packageName, advisory.fixedIn)}${reference}`;
}

/**
 * The command that pulls the fixed version in.
 *
 * `add <pkg>@<version>` rather than a bare `update`, because the vulnerable
 * package is very often TRANSITIVE, and `update` will not move it past a
 * parent's pinned range. Naming the version makes the intent explicit and
 * makes the command work whether the dependency is direct or hoisted.
 */
function upgradeCommand(manager: PackageManager, name: string, version: string): string {
  const commands: Record<PackageManager, string> = {
    pnpm: `pnpm update ${name}@^${version}`,
    npm: `npm install ${name}@^${version}`,
    yarn: `yarn up ${name}@^${version}`,
    bun: `bun update ${name}@^${version}`,
    unknown: `upgrade ${name} to ${version} or later`,
  };
  return commands[manager];
}

/**
 * Evidence that the auditor could not reach the advisory database.
 *
 * THIS IS THE MOST IMPORTANT LIST IN THE FILE. An audit that could not reach
 * the network has found nothing and knows nothing, and those two are not the
 * same thing. Reporting "no vulnerabilities" from a failed request is a false
 * green with real consequences — it is the exact shape of a supply-chain
 * incident going unnoticed — so anything matching here becomes a visible
 * environment failure and never a pass.
 *
 * The system errno patterns are the reliable half: they come from Node's own
 * `FetchError` (`request to <url> failed, reason: getaddrinfo ENOTFOUND …`)
 * and from bun's Rust transport, and they do not change with tool versions.
 * The tool-specific phrases are the second half, each read from the source
 * that emits it.
 */
const NETWORK_FAILURE: readonly RegExp[] = [
  // Node/undici/bun system errors, common to npm, pnpm and yarn.
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bETIMEDOUT\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bENETUNREACH\b/,
  /\bEHOSTUNREACH\b/,
  /\bECONNABORTED\b/,
  /\bCERT_HAS_EXPIRED\b/,
  /\bDEPTH_ZERO_SELF_SIGNED_CERT\b/,
  /\bUNABLE_TO_VERIFY_LEAF_SIGNATURE\b/,
  /network timeout/i,
  /socket hang up/i,
  /request to \S+ failed/i,
  // pnpm's own registry errors.
  /ERR_PNPM_AUDIT_ENDPOINT_NOT_EXISTS/,
  /ERR_PNPM_AUDIT_BAD_RESPONSE/,
  // yarn classic's fetch guard.
  /Unexpected audit response/i,
  // bun's transport failure, and its ">= 400" HTTP guard.
  /audit request failed/i,
];

/** True when the tool's output shows a failed request rather than a result. */
export function looksOffline(text: string): boolean {
  return NETWORK_FAILURE.some((pattern) => pattern.test(text));
}

/**
 * A short, blank-stripped excerpt of tool output for an error message.
 *
 * These tools print stack traces and multi-kilobyte HTTP bodies on failure.
 * The first few non-empty lines carry the cause; the rest costs the reader
 * context they need for the fix.
 */
export function excerpt(text: string, limit = 8): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(0, limit)
    .join("\n");
}
