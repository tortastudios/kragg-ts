/**
 * Parser for `pnpm audit --json`.
 *
 * SCHEMA PROVENANCE. Read from pnpm's source at `v10.34.5`
 * (`lockfile/audit/src/types.ts`) and on `main` for pnpm 11.20.0 / 12.0.0-rc
 * (`pnpm11/deps/compliance/audit/src/types.ts` and `index.ts`), plus the Rust
 * rewrite's `report.rs`. Nothing was executed.
 *
 * **THE SHAPE CHANGED BETWEEN pnpm 10 AND pnpm 11**, and both are handled
 * because a project pins its own pnpm:
 *
 *   pnpm 9/10 — the legacy npm-6 report, proxied from
 *   `/-/npm/v1/security/audits`:
 *
 *     { "actions": [...], "muted": [],
 *       "advisories": { "1094419": {
 *           "id": 1094419, "module_name": "ms", "title": "…",
 *           "url": "https://github.com/advisories/GHSA-…",
 *           "severity": "moderate",
 *           "vulnerable_versions": "<2.0.0", "patched_versions": ">=2.0.0",
 *           "cwe": ["CWE-1333"], "cves": [...],
 *           "findings": [{ "version": "0.7.1", "paths": ["a > b > ms"] }],
 *           … } },
 *       "metadata": { "vulnerabilities": {…}, "totalDependencies": 42 } }
 *
 *   pnpm 11/12 — pnpm now calls the BULK endpoint and synthesizes the report
 *   itself. `actions` and `muted` are gone, most advisory prose is gone,
 *   `cwe` became a comma-joined STRING, `patched_versions` became OPTIONAL,
 *   and `severity` gained `info`.
 *
 * One parser covers both because the fields kragg reports — `module_name`,
 * `severity`, `title`, `url`, `vulnerable_versions`, `patched_versions`,
 * `findings[].version` — survived the change. The two that did not are read
 * defensively: `cwe` as either array or string (kragg does not report it
 * either way), and `patched_versions` as genuinely absent rather than as
 * "no fix". pnpm's own source carries a comment making that second point;
 * treating a missing `patched_versions` as "unfixable" would tell a project to
 * live with a vulnerability that has a published fix.
 *
 * WHAT pnpm GIVES THAT npm DOES NOT: `findings[].version` is the INSTALLED
 * version. It is the reason a pnpm project's audit report is more actionable
 * than an npm one, and it is read here.
 *
 * ON `--audit-level`: pnpm, unlike npm, FILTERS the JSON body by it, but does
 * not re-filter `metadata.vulnerabilities`. kragg applies its own floor to the
 * parsed advisories regardless, so the two cannot disagree.
 */

import {
  asArray,
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

/** pnpm's hard failure when the project has no lockfile to audit. */
export const PNPM_NO_LOCKFILE = "ERR_PNPM_AUDIT_NO_LOCKFILE";

/** Parse `pnpm audit --json` output. Never throws. */
export function parsePnpmAudit(stdout: string, stderr: string): AuditParse {
  const parsed = extractJson(stdout);
  if (!isJsonObject(parsed)) {
    return failure(`${stdout}\n${stderr}`, "pnpm audit produced no JSON document");
  }
  const advisoryMap = asObject(parsed, "advisories");
  if (advisoryMap === undefined) {
    // A document without `advisories` is not a pnpm audit report. That includes
    // the `--ignore-registry-errors` output, which is a bare error STRING on
    // stdout with exit 0 — a silent pass that must not be read as clean.
    return failure(
      `${stdout}\n${stderr}`,
      "pnpm audit returned a document with no `advisories` (not an audit report)",
    );
  }

  const advisories: Advisory[] = [];
  for (const [key, entry] of objectEntries(advisoryMap)) {
    advisories.push(...expand(key, entry));
  }
  return { ok: true, advisories };
}

/**
 * One advisory, once per INSTALLED VERSION it affects.
 *
 * `findings` is a list because a monorepo can resolve two versions of the same
 * package, only one of which is vulnerable. Collapsing them to one violation
 * would report a version number that is right for one workspace and wrong for
 * another. An advisory with no findings still yields one violation — the
 * vulnerability is real, kragg just cannot say which version is installed.
 */
function expand(key: string, entry: JsonObject): readonly Advisory[] {
  const base = {
    packageName: asString(entry, "module_name") ?? key,
    severity: toSeverity(asString(entry, "severity")),
    id: identifier(key, entry),
    title: asString(entry, "title"),
    url: asString(entry, "url"),
    vulnerableRange: asString(entry, "vulnerable_versions"),
    fixedIn: asString(entry, "patched_versions"),
  } as const;

  const versions = installedVersions(entry);
  if (versions.length === 0) {
    return [{ ...base, installedVersion: undefined }];
  }
  return versions.map((installedVersion) => ({ ...base, installedVersion }));
}

/** Distinct installed versions from `findings[].version`, in report order. */
function installedVersions(entry: JsonObject): readonly string[] {
  const seen = new Set<string>();
  for (const finding of objectsIn(asArray(entry, "findings"))) {
    const version = asString(finding, "version");
    if (version !== undefined && version !== "") {
      seen.add(version);
    }
  }
  return [...seen];
}

/**
 * Prefer the GHSA id over pnpm's numeric one.
 *
 * `github_advisory_id` is stable across tools and searchable; the numeric id
 * is npm-registry-internal. pnpm 11 derives the former from the advisory URL,
 * so it is present on both majors — but it is optional in the type, hence the
 * fallbacks.
 */
function identifier(key: string, entry: JsonObject): string | undefined {
  const ghsa = asString(entry, "github_advisory_id");
  if (ghsa !== undefined && ghsa !== "") {
    return ghsa;
  }
  const numeric = asNumber(entry, "id");
  return numeric === undefined ? (key === "" ? undefined : `npm-${key}`) : `npm-${numeric}`;
}

function failure(combined: string, summary: string): AuditParse {
  if (looksOffline(combined)) {
    return {
      ok: false,
      reason: "offline",
      message: `pnpm audit could not reach the advisory database:\n${excerpt(combined)}`,
    };
  }
  if (combined.includes(PNPM_NO_LOCKFILE)) {
    return {
      ok: false,
      reason: "unreadable",
      message:
        "pnpm audit needs a lockfile: no pnpm-lock.yaml was found. " +
        "Run `pnpm install` to create one — an audit without a lockfile " +
        "cannot know which versions are actually installed.",
    };
  }
  return { ok: false, reason: "unreadable", message: `${summary}\n${excerpt(combined)}` };
}
