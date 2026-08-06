/**
 * Parser for `bun audit --json`.
 *
 * SCHEMA PROVENANCE. Read from bun's source on `main`
 * (`src/runtime/cli/audit_command.rs`) plus bun's own captured registry
 * fixture (`test/cli/install/registry/fixtures/audit/audit-fixtures.json`) and
 * the `bun audit` docs. `bun audit` landed in Bun 1.2.15 and gained
 * `--audit-level` / `--prod` / `--ignore` in 1.2.21; current Bun is 1.3.14.
 * Nothing was executed.
 *
 * `--json` DOES NOT PRODUCE A REPORT. It echoes the registry's raw bulk
 * response, verbatim, with no envelope, no metadata, no counts, and no
 * dependency paths:
 *
 *     { "ms": [ { "id": 1094419,
 *                 "url": "https://github.com/advisories/GHSA-w9mr-4mfr-499f",
 *                 "title": "Vercel ms Inefficient Regular Expression …",
 *                 "severity": "moderate",
 *                 "vulnerable_versions": "<2.0.0",
 *                 "cwe": ["CWE-1333"],
 *                 "cvss": { "score": 5.3, "vectorString": "CVSS:3.1/…" } } ] }
 *
 * The bun source is explicit — `if json_output { write_all(&response_text) }`
 * — so this is the registry's document, not bun's.
 *
 * THREE CONSEQUENCES, all of them limitations rather than bugs, and all of
 * them reported rather than papered over:
 *
 *  1. NO INSTALLED VERSION. The registry never knew it. `installedVersion`
 *     stays undefined and the violation renders `?`, exactly as it does for
 *     npm.
 *  2. NO FIXED VERSION. There is no `patched_versions` in the bulk response,
 *     so `fixedIn` is undefined and the fix hint says so instead of naming a
 *     version nobody told us.
 *  3. `--audit-level` AND `--ignore` ARE IGNORED IN JSON MODE. bun applies
 *     them only in its pretty-printed path. kragg's own severity floor is
 *     applied to the parsed advisories, so the filter still happens — it just
 *     happens here rather than in bun.
 *
 * OFFLINE: bun never emits JSON on failure. Its transport error path prints
 * `audit request failed` (or `error: audit request failed (status 503)`) to
 * stderr as plain text and aborts. That leaves stdout empty, which is exactly
 * why an empty stdout is treated as a failure here and not as "no
 * vulnerabilities" — the difference between those two readings is the
 * difference between a warning and a silent false green.
 */

import { asNumber, asString, extractJson, isJsonObject, objectsIn, prop } from "./json.ts";
import type { JsonObject } from "./json.ts";
import { excerpt, looksOffline, toSeverity } from "./auditTypes.ts";
import type { Advisory, AuditParse } from "./auditTypes.ts";

/** Parse `bun audit --json` output. Never throws. */
export function parseBunAudit(stdout: string, stderr: string): AuditParse {
  if (stdout.trim() === "") {
    return failure(
      `${stdout}\n${stderr}`,
      "bun audit produced no output (it writes nothing to stdout when the request fails)",
    );
  }
  const parsed = extractJson(stdout);
  if (!isJsonObject(parsed)) {
    return failure(`${stdout}\n${stderr}`, "bun audit produced no JSON document");
  }

  const advisories: Advisory[] = [];
  for (const packageName of Object.keys(parsed)) {
    const entries = prop(parsed, packageName);
    if (!Array.isArray(entries)) {
      // The bulk response maps every key to an ARRAY. A key holding anything
      // else means this is some other document that happens to be JSON, and
      // reading it as an empty audit would be a green gate built from a
      // misread.
      return failure(
        `${stdout}\n${stderr}`,
        "bun audit output is not a registry bulk-advisory document",
      );
    }
    for (const entry of objectsIn(entries)) {
      advisories.push(toAdvisory(packageName, entry));
    }
  }
  return { ok: true, advisories };
}

function toAdvisory(packageName: string, entry: JsonObject): Advisory {
  const numericId = asNumber(entry, "id");
  return {
    packageName,
    installedVersion: undefined,
    severity: toSeverity(asString(entry, "severity")),
    id:
      ghsaFromUrl(asString(entry, "url")) ??
      (numericId === undefined ? undefined : `npm-${numericId}`),
    title: asString(entry, "title"),
    url: asString(entry, "url"),
    vulnerableRange: asString(entry, "vulnerable_versions"),
    fixedIn: undefined,
  };
}

/**
 * Recover the GHSA identifier from the advisory URL.
 *
 * The bulk response has no GHSA field, but its `url` is a GitHub advisory
 * permalink whose last segment IS the identifier. Preferring it over the
 * numeric id makes bun's findings line up with the other three tools' output,
 * which matters in a polyglot repo running more than one of them.
 */
function ghsaFromUrl(url: string | undefined): string | undefined {
  const match = url === undefined ? null : /(GHSA-[\w-]+)/u.exec(url);
  return match?.[1];
}

function failure(combined: string, summary: string): AuditParse {
  return looksOffline(combined)
    ? {
        ok: false,
        reason: "offline",
        message: `bun audit could not reach the advisory database:\n${excerpt(combined)}`,
      }
    : { ok: false, reason: "unreadable", message: `${summary}\n${excerpt(combined)}` };
}
