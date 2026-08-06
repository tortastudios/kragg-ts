/**
 * Parsers for yarn's two audit commands, which share a name and nothing else.
 *
 * SCHEMA PROVENANCE. yarn classic from `yarnpkg/yarn@master`
 * (`src/cli/commands/audit.js`, `src/reporters/json-reporter.js`, v1.22.22);
 * yarn berry from `yarnpkg/berry@master`
 * (`packages/plugin-npm-cli/sources/commands/npm/audit.ts`,
 * `npmAuditUtils.ts`, `yarnpkg-core/sources/treeUtils.ts`, v4.18.0). Nothing
 * was executed.
 *
 * ── CLASSIC (yarn 1) — `yarn audit --json` ─────────────────────────────────
 * NDJSON, one envelope per line:
 *
 *     {"type":"auditAdvisory","data":{
 *        "resolution":{"id":1094419,"path":"a>b>ms","dev":false,…},
 *        "advisory":{ "id":1094419,"module_name":"ms","title":"…",
 *                     "url":"…","severity":"moderate",
 *                     "vulnerable_versions":"<2.0.0",
 *                     "patched_versions":">=2.0.0",
 *                     "findings":[{"version":"0.7.1","paths":[…]}] }}}
 *     {"type":"auditSummary","data":{"vulnerabilities":{…},…}}
 *
 * Note `data` wraps `{resolution, advisory}` — the advisory is NOT the whole
 * payload. The advisory itself is the same npm-6 shape pnpm 10 emits, so
 * `parsePnpmAudit`'s per-advisory reader is reused rather than duplicated.
 *
 * EXIT CODE WARNING, and it is a real trap: yarn classic returns a BITMASK —
 * `info=1, low=2, moderate=4, high=8, critical=16`, summed. A run finding a
 * critical vulnerability exits 16. Any caller treating "non-zero" as "the tool
 * crashed" gets it exactly backwards, and `--level` does NOT change the
 * bitmask. `adapters/audit.ts` therefore never infers a crash from the exit
 * code for this tool.
 *
 * ── BERRY (yarn 2+) — `yarn npm audit --json` ──────────────────────────────
 * Also NDJSON, but of a RENDERED TREE, with display strings as keys:
 *
 *     {"value":"lodash","children":{
 *        "ID":1065657,"Issue":"Prototype Pollution in lodash",
 *        "URL":"https://github.com/advisories/GHSA-…","Severity":"high",
 *        "Vulnerable Versions":"<4.17.21","Tree Versions":["4.17.15"],
 *        "Dependents":["my-app@workspace:."]}}
 *
 * `ID` and `URL` are omitted when undefined. `Tree Versions` is the INSTALLED
 * version — berry is the only yarn that reports it. There is no fixed-version
 * field at all, so `fixedIn` is genuinely unknown here and is left undefined
 * rather than inferred from the vulnerable range.
 *
 * TWO BERRY-SPECIFIC TRAPS, both handled:
 *
 *  1. DEPRECATIONS ARE INJECTED AS FAKE ADVISORIES, with a STRING `ID` of the
 *     form `"<pkg> (deprecation)"` and severity `moderate`. A deprecated
 *     package is not a vulnerability, and reporting it as one under a security
 *     gate is how a security gate loses its credibility. `adapters/audit.ts`
 *     passes `--no-deprecations`; this parser drops them as well, because the
 *     flag is version-dependent and the belt-and-braces costs one comparison.
 *  2. "NO VULNERABILITIES" IS NOT AN EMPTY STREAM. Berry emits a report line
 *     `{"type":"info",…,"data":"No audit suggestions"}`. An error is the same
 *     envelope with `"type":"error"`. Distinguishing those from result lines
 *     is what keeps a failed request from reading as a clean audit.
 */

import {
  asArray,
  asNumber,
  asObject,
  asString,
  objectsIn,
  parseNdjson,
  stringsIn,
} from "./json.ts";
import type { JsonObject } from "./json.ts";
import { excerpt, looksOffline, toSeverity } from "./auditTypes.ts";
import type { Advisory, AuditParse } from "./auditTypes.ts";

/** Which yarn a project uses. They need different commands and parsers. */
export type YarnFlavor = "classic" | "berry";

/** Parse `yarn audit --json` (yarn 1). */
export function parseYarnClassicAudit(stdout: string, stderr: string): AuditParse {
  const documents = parseNdjson(stdout);
  if (documents.length === 0) {
    return failure(`${stdout}\n${stderr}`, "yarn audit produced no JSON lines");
  }

  let sawSummary = false;
  const advisories: Advisory[] = [];
  for (const document of documents) {
    const type = asString(document, "type");
    if (type === "auditSummary") {
      sawSummary = true;
      continue;
    }
    if (type === "error") {
      // The JSON reporter writes errors to STDERR, but a merged stream or a
      // future version could put one here; it is a failure either way.
      return failure(`${stdout}\n${stderr}`, `yarn audit reported an error: ${dataText(document)}`);
    }
    if (type !== "auditAdvisory") {
      continue;
    }
    const advisory = asObject(asObject(document, "data") ?? {}, "advisory");
    if (advisory !== undefined) {
      advisories.push(fromNpm6Advisory(advisory));
    }
  }

  if (!sawSummary && advisories.length === 0) {
    // NDJSON that parsed but described nothing. A completed clean audit always
    // ends with `auditSummary`, so its absence means the run did not finish.
    return failure(
      `${stdout}\n${stderr}`,
      "yarn audit produced no advisories and no summary line (the run did not complete)",
    );
  }
  return { ok: true, advisories };
}

/** Parse `yarn npm audit --json` (yarn 2+). */
export function parseYarnBerryAudit(stdout: string, stderr: string): AuditParse {
  const documents = parseNdjson(stdout);
  if (documents.length === 0) {
    return failure(`${stdout}\n${stderr}`, "yarn npm audit produced no JSON lines");
  }

  let sawReportLine = false;
  const advisories: Advisory[] = [];
  for (const document of documents) {
    const children = asObject(document, "children");
    const value = asString(document, "value");
    if (children === undefined || value === undefined) {
      const type = asString(document, "type");
      if (type === "error") {
        return failure(
          `${stdout}\n${stderr}`,
          `yarn npm audit reported an error: ${dataText(document)}`,
        );
      }
      sawReportLine = sawReportLine || type === "info";
      continue;
    }
    // A node we RECOGNISED counts as evidence the run completed, even when it
    // is dropped as a deprecation notice. Without this, a project whose only
    // findings are deprecations would look like a run that never finished.
    sawReportLine = true;
    const advisory = fromBerryNode(value, children);
    if (advisory !== undefined) {
      advisories.push(advisory);
    }
  }

  if (advisories.length === 0 && !sawReportLine) {
    return failure(
      `${stdout}\n${stderr}`,
      "yarn npm audit produced neither results nor a report line",
    );
  }
  return { ok: true, advisories };
}

/**
 * The npm-6 advisory object, shared by yarn classic and pnpm 9/10.
 *
 * Only the first `findings[].version` is taken: yarn classic emits one
 * `auditAdvisory` line PER RESOLUTION PATH, so the versions are already
 * separated across lines and expanding them again would multiply the report.
 */
function fromNpm6Advisory(advisory: JsonObject): Advisory {
  const firstFinding = objectsIn(asArray(advisory, "findings"))[0];
  const numericId = asNumber(advisory, "id");
  return {
    packageName: asString(advisory, "module_name") ?? "unknown",
    installedVersion: firstFinding === undefined ? undefined : asString(firstFinding, "version"),
    severity: toSeverity(asString(advisory, "severity")),
    id:
      asString(advisory, "github_advisory_id") ??
      (numericId === undefined ? undefined : `npm-${numericId}`),
    title: asString(advisory, "title"),
    url: asString(advisory, "url"),
    vulnerableRange: asString(advisory, "vulnerable_versions"),
    fixedIn: asString(advisory, "patched_versions"),
  };
}

/** One berry tree node, or `undefined` for an injected deprecation notice. */
function fromBerryNode(packageName: string, children: JsonObject): Advisory | undefined {
  const id = berryId(children);
  if (id !== undefined && id.endsWith("(deprecation)")) {
    return undefined;
  }
  const versions = stringsIn(asArray(children, "Tree Versions"));
  return {
    packageName,
    installedVersion: versions.length === 0 ? undefined : versions.join(", "),
    severity: toSeverity(asString(children, "Severity")),
    id,
    title: asString(children, "Issue"),
    url: asString(children, "URL"),
    vulnerableRange: asString(children, "Vulnerable Versions"),
    // Berry's report carries no fixed version. Leaving this undefined is the
    // honest answer; deriving one from `Vulnerable Versions` would be a guess
    // presented as a fact in a fix hint.
    fixedIn: undefined,
  };
}

/** Berry's `ID` is a number for real advisories and a string for deprecations. */
function berryId(children: JsonObject): string | undefined {
  const text = asString(children, "ID");
  if (text !== undefined) {
    return text;
  }
  const numeric = asNumber(children, "ID");
  return numeric === undefined ? undefined : `npm-${numeric}`;
}

/** The human-readable `data` of a report envelope, whatever its type. */
function dataText(document: JsonObject): string {
  return asString(document, "data") ?? "no detail";
}

function failure(combined: string, summary: string): AuditParse {
  return looksOffline(combined)
    ? {
        ok: false,
        reason: "offline",
        message: `yarn could not reach the advisory database:\n${excerpt(combined)}`,
      }
    : { ok: false, reason: "unreadable", message: `${summary}\n${excerpt(combined)}` };
}
