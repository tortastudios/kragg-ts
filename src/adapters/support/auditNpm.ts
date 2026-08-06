/**
 * Parser for `npm audit --json`.
 *
 * SCHEMA PROVENANCE. Read from npm's own source — `workspaces/arborist/lib/
 * audit-report.js` and `vuln.js` at the `latest` tag (npm 12.0.2), which are
 * byte-identical to npm 11.19.0 — plus npm's checked-in tap snapshot of real
 * output, and `@npmcli/metavuln-calculator`'s `Advisory` for the `via` object.
 * Nothing was executed.
 *
 *     { "auditReportVersion": 2,
 *       "vulnerabilities": {
 *         "mkdirp": {
 *           "name": "mkdirp", "severity": "high", "isDirect": true,
 *           "via": [ { "source": 42069, "name": "mkdirp",
 *                      "dependency": "mkdirp", "title": "File System
 *                      Pollution", "url": "https://…", "severity": "high",
 *                      "cwe": ["CWE-22"], "cvss": { "score": 7.5,
 *                      "vectorString": "CVSS:3.1/…" }, "range": "<0.5.5" },
 *                    "minimist" ],
 *           "effects": [], "range": "<=0.5.4",
 *           "nodes": ["node_modules/mkdirp"],
 *           "fixAvailable": true | false
 *                         | { "name": "nyc", "version": "15.1.0",
 *                             "isSemVerMajor": true } } },
 *       "metadata": { "vulnerabilities": { info, low, moderate, high,
 *                                          critical, total },
 *                     "dependencies": { prod, dev, optional, peer,
 *                                       peerOptional, total } } }
 *
 * THREE FACTS THAT SHAPE THIS PARSER:
 *
 *  1. `via` is a UNION. A string element is the NAME of the dependency that
 *     transitively introduced the vulnerability, not an advisory. Treating
 *     strings as advisories invents findings; ignoring the objects loses every
 *     real one.
 *  2. THE INSTALLED VERSION IS NOT IN THE REPORT. `nodes` holds paths and
 *     `range` holds the vulnerable range. `fixAvailable.version` is the fix
 *     TARGET, not what is installed. Anything claiming otherwise is guessing.
 *  3. A NETWORK FAILURE ALSO EMITS JSON. `audit-error.js` prints
 *     `{ message, method, uri, headers, statusCode, body }` and no
 *     `auditReportVersion`. That missing key is the discriminator, and it is
 *     the reason this parser demands it rather than defaulting to "no
 *     vulnerabilities found".
 *
 * npm's legacy (npm 6) `{ advisories, actions, metadata }` format is NOT
 * handled: `auditReportVersion` is a hard-coded `2` in every npm from 7
 * onward, so nothing kragg can run produces the old shape. A project on npm 6
 * gets an honest "unrecognised report" rather than a silent pass.
 */

import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asString,
  extractJson,
  isJsonObject,
  objectEntries,
  objectsIn,
} from "./json.ts";
import type { JsonObject } from "./json.ts";
import { excerpt, looksOffline, toSeverity } from "./auditTypes.ts";
import type { Advisory, AuditParse } from "./auditTypes.ts";

/** Parse `npm audit --json` output. Never throws. */
export function parseNpmAudit(stdout: string, stderr: string): AuditParse {
  const parsed = extractJson(stdout);
  if (!isJsonObject(parsed)) {
    return unreadable(stdout, stderr, "npm audit produced no JSON document");
  }
  if (asNumber(parsed, "auditReportVersion") === undefined) {
    // Either the network-failure document or something else entirely. Both
    // are failures; `looksOffline` decides which message to give.
    return unreadable(
      `${stdout}\n${asString(parsed, "message") ?? ""}`,
      stderr,
      "npm audit returned an error document instead of a report " +
        `(${asString(parsed, "message") ?? "no message"})`,
    );
  }

  const vulnerabilities = asObject(parsed, "vulnerabilities");
  if (vulnerabilities === undefined) {
    return { ok: true, advisories: [] };
  }
  const advisories: Advisory[] = [];
  for (const [packageName, entry] of objectEntries(vulnerabilities)) {
    advisories.push(...advisoriesFor(packageName, entry));
  }
  return { ok: true, advisories };
}

/**
 * Every advisory attached to one vulnerable package.
 *
 * A package with only STRING `via` entries is vulnerable purely by
 * transitivity — the real advisory is recorded against the dependency named in
 * the string, which has its own entry in the same report. Emitting a
 * placeholder for it would double-report the same vulnerability under two
 * names, so it yields nothing here and is covered by the entry it points at.
 */
function advisoriesFor(packageName: string, entry: JsonObject): readonly Advisory[] {
  const fixedIn = fixVersion(entry);
  const packageSeverity = toSeverity(asString(entry, "severity"));
  const found: Advisory[] = [];
  for (const via of objectsIn(asArray(entry, "via"))) {
    found.push({
      packageName: asString(via, "name") ?? packageName,
      // npm genuinely does not report it; see the module docs.
      installedVersion: undefined,
      severity: toSeverity(asString(via, "severity")) ?? packageSeverity,
      id: advisoryId(via),
      title: asString(via, "title"),
      url: asString(via, "url"),
      vulnerableRange: asString(via, "range") ?? asString(entry, "range"),
      fixedIn,
    });
  }
  return found;
}

/**
 * `source` is npm's advisory id — a number, e.g. `1094419`.
 *
 * Preferred over parsing the GHSA out of `url`, because `source` is the field
 * npm treats as the identity and it is present even when `url` is not.
 */
function advisoryId(via: JsonObject): string | undefined {
  const source = asNumber(via, "source");
  return source === undefined ? undefined : `npm-${source}`;
}

/**
 * The fixed version, when npm names one.
 *
 * `fixAvailable` is a THREE-WAY union: `false` (no fix), `true` (a fix exists
 * within the current ranges but npm names no version), or an object naming the
 * package and version to move to. Only the object form yields a version;
 * `true` means "run `npm audit fix`" and naming a version we do not have would
 * be a fabrication.
 */
function fixVersion(entry: JsonObject): string | undefined {
  const fix = asObject(entry, "fixAvailable");
  if (fix !== undefined) {
    return asString(fix, "version");
  }
  return asBoolean(entry, "fixAvailable") === true
    ? "a newer version (run `npm audit fix`)"
    : undefined;
}

function unreadable(haystack: string, stderr: string, summary: string): AuditParse {
  const combined = `${haystack}\n${stderr}`;
  return looksOffline(combined)
    ? {
        ok: false,
        reason: "offline",
        message: `npm audit could not reach the advisory database:\n${excerpt(combined)}`,
      }
    : { ok: false, reason: "unreadable", message: `${summary}\n${excerpt(combined)}` };
}
