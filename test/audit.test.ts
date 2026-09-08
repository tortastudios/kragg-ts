/**
 * Tests for the dependency-audit adapter.
 *
 * Fixtures are hand-built from each tool's own source and checked-in snapshots
 * (provenance is documented in each parser). Nothing here runs an auditor —
 * these tools hit the network, and a test suite that needs the registry is a
 * test suite that fails on a plane.
 *
 * THE MOST IMPORTANT TESTS IN THIS FILE are the ones asserting that a failed
 * read is never reported as "no vulnerabilities". Every other assertion here
 * is about accuracy; those are about the difference between a security gate
 * and security theatre.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { auditCommand, runAudit, yarnFlavor } from "../src/adapters/audit.ts";
import { parseBunAudit } from "../src/adapters/support/auditBun.ts";
import { parseNpmAudit } from "../src/adapters/support/auditNpm.ts";
import { parsePnpmAudit } from "../src/adapters/support/auditPnpm.ts";
import { parseYarnBerryAudit, parseYarnClassicAudit } from "../src/adapters/support/auditYarn.ts";
import {
  excerpt,
  looksOffline,
  meetsFloor,
  toSeverity,
} from "../src/adapters/support/auditTypes.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-audit-"));
  roots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    writeFileSync(join(root, name), contents, "utf8");
  }
  return root;
}

// ── npm ────────────────────────────────────────────────────────────────────

/** Shape taken from npm's own tap snapshot of `AuditReport#toJSON`. */
const NPM_REPORT = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    mkdirp: {
      name: "mkdirp",
      severity: "high",
      isDirect: true,
      via: [
        {
          source: 42069,
          name: "mkdirp",
          dependency: "mkdirp",
          title: "File System Pollution",
          url: "https://npmjs.com/advisories/42069",
          severity: "high",
          range: "<0.5.5",
        },
        "minimist",
      ],
      effects: [],
      range: "<=0.5.4",
      nodes: ["node_modules/mkdirp"],
      fixAvailable: { name: "nyc", version: "15.1.0", isSemVerMajor: true },
    },
    tiny: {
      name: "tiny",
      severity: "low",
      isDirect: false,
      via: [
        { source: 7, name: "tiny", title: "Minor issue", severity: "low", range: "<1" },
      ],
      effects: [],
      range: "<1",
      nodes: ["node_modules/tiny"],
      fixAvailable: false,
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 1, moderate: 0, high: 1, critical: 0, total: 2 },
    dependencies: { prod: 10, dev: 5, optional: 0, peer: 0, peerOptional: 0, total: 15 },
  },
});

test("npm: parses the auditReportVersion 2 report", () => {
  const parsed = parseNpmAudit(NPM_REPORT, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.advisories.length, 2);

  const high = parsed.advisories.find((advisory) => advisory.packageName === "mkdirp");
  assert.ok(high !== undefined);
  assert.equal(high.severity, "high");
  assert.equal(high.id, "npm-42069");
  assert.equal(high.fixedIn, "15.1.0");
  // npm genuinely does not report the installed version. It must stay absent
  // rather than being invented from the vulnerable range.
  assert.equal(high.installedVersion, undefined);
});

test("npm: a string `via` entry is a dependency name, not an advisory", () => {
  const parsed = parseNpmAudit(NPM_REPORT, "");
  assert.equal(parsed.ok, true);
  // "minimist" appears as a string in mkdirp's `via`; it must not become a
  // finding of its own, or every transitive vulnerability doubles.
  assert.ok(!parsed.advisories.some((advisory) => advisory.packageName === "minimist"));
});

test("npm: a network failure emits JSON too, and is NOT a clean audit", () => {
  const networkError = JSON.stringify({
    message:
      "request to https://registry.npmjs.org/-/npm/v1/security/advisories/bulk failed, " +
      "reason: getaddrinfo ENOTFOUND registry.npmjs.org",
    method: "POST",
    uri: "https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
  });
  const parsed = parseNpmAudit(networkError, "");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "offline");
});

test("npm: an empty vulnerabilities map is a real, clean report", () => {
  const clean = JSON.stringify({
    auditReportVersion: 2,
    vulnerabilities: {},
    metadata: { vulnerabilities: { total: 0 }, dependencies: { total: 12 } },
  });
  const parsed = parseNpmAudit(clean, "");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.advisories, []);
});

// ── pnpm ───────────────────────────────────────────────────────────────────

test("pnpm: parses the pnpm 9/10 legacy advisories report", () => {
  const legacy = JSON.stringify({
    actions: [],
    muted: [],
    advisories: {
      "1094419": {
        id: 1094419,
        module_name: "ms",
        title: "Inefficient Regular Expression Complexity",
        url: "https://github.com/advisories/GHSA-w9mr-4mfr-499f",
        github_advisory_id: "GHSA-w9mr-4mfr-499f",
        severity: "moderate",
        vulnerable_versions: "<2.0.0",
        patched_versions: ">=2.0.0",
        cwe: ["CWE-1333"],
        findings: [{ version: "0.7.1", paths: ["a > b > ms"] }],
      },
    },
    metadata: { vulnerabilities: { moderate: 1 }, totalDependencies: 40 },
  });
  const parsed = parsePnpmAudit(legacy, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.advisories.length, 1);
  const advisory = parsed.advisories[0];
  assert.equal(advisory?.packageName, "ms");
  // pnpm reports the INSTALLED version; npm does not. Use it.
  assert.equal(advisory?.installedVersion, "0.7.1");
  assert.equal(advisory?.id, "GHSA-w9mr-4mfr-499f");
  assert.equal(advisory?.fixedIn, ">=2.0.0");
});

test("pnpm: parses the pnpm 11 shape, where cwe is a string and the fix may be absent", () => {
  const modern = JSON.stringify({
    advisories: {
      "1094419": {
        id: 1094419,
        module_name: "ms",
        title: "Inefficient Regular Expression Complexity",
        url: "https://github.com/advisories/GHSA-w9mr-4mfr-499f",
        github_advisory_id: "GHSA-w9mr-4mfr-499f",
        severity: "moderate",
        vulnerable_versions: "<2.0.0",
        cwe: "CWE-1333",
        findings: [{ version: "0.7.1" }, { version: "1.0.0" }],
      },
    },
    metadata: { vulnerabilities: { moderate: 1 }, totalDependencies: 40 },
  });
  const parsed = parsePnpmAudit(modern, "");
  assert.equal(parsed.ok, true);
  // One advisory, two installed versions -> one finding per version, because
  // a monorepo can resolve both and only one may need the upgrade.
  assert.equal(parsed.advisories.length, 2);
  assert.deepEqual(
    parsed.advisories.map((advisory) => advisory.installedVersion),
    ["0.7.1", "1.0.0"],
  );
  // `patched_versions` is optional on pnpm 11; absent must not read as
  // "no fix exists".
  assert.equal(parsed.advisories[0]?.fixedIn, undefined);
});

test("pnpm: a missing lockfile is an explained failure, not a pass", () => {
  const parsed = parsePnpmAudit("", "ERR_PNPM_AUDIT_NO_LOCKFILE  No pnpm-lock.yaml found");
  assert.equal(parsed.ok, false);
  assert.match(parsed.message, /needs a lockfile/u);
});

test("pnpm: the --ignore-registry-errors plain-text output is not a clean audit", () => {
  // That flag turns a registry failure into exit 0 with the error as "output".
  const parsed = parsePnpmAudit("request to https://registry.npmjs.org failed", "");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "offline");
});

// ── yarn ───────────────────────────────────────────────────────────────────

test("yarn classic: parses NDJSON advisory envelopes", () => {
  const ndjson = [
    JSON.stringify({
      type: "auditAdvisory",
      data: {
        resolution: { id: 1065657, path: "app>lodash", dev: false },
        advisory: {
          id: 1065657,
          module_name: "lodash",
          title: "Prototype Pollution",
          url: "https://github.com/advisories/GHSA-p6mc-m468-83gg",
          severity: "high",
          vulnerable_versions: "<4.17.21",
          patched_versions: ">=4.17.21",
          findings: [{ version: "4.17.15", paths: ["app>lodash"] }],
        },
      },
    }),
    JSON.stringify({
      type: "auditSummary",
      data: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 1, critical: 0 } },
    }),
  ].join("\n");

  const parsed = parseYarnClassicAudit(ndjson, "");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.advisories.length, 1);
  assert.equal(parsed.advisories[0]?.installedVersion, "4.17.15");
  assert.equal(parsed.advisories[0]?.fixedIn, ">=4.17.21");
});

test("yarn classic: a clean audit is a lone summary line, not an empty stream", () => {
  const summaryOnly = JSON.stringify({
    type: "auditSummary",
    data: { vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 } },
  });
  const parsed = parseYarnClassicAudit(summaryOnly, "");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.advisories, []);

  // No summary at all means the run did not complete.
  const truncated = parseYarnClassicAudit('{"type":"progressStart","data":{}}', "");
  assert.equal(truncated.ok, false);
});

test("yarn berry: parses the rendered tree and reads Tree Versions", () => {
  const ndjson = JSON.stringify({
    value: "lodash",
    children: {
      ID: 1065657,
      Issue: "Prototype Pollution in lodash",
      URL: "https://github.com/advisories/GHSA-p6mc-m468-83gg",
      Severity: "high",
      "Vulnerable Versions": "<4.17.21",
      "Tree Versions": ["4.17.15"],
      Dependents: ["my-app@workspace:."],
    },
  });
  const parsed = parseYarnBerryAudit(ndjson, "");
  assert.equal(parsed.ok, true);
  const advisory = parsed.advisories[0];
  assert.equal(advisory?.packageName, "lodash");
  assert.equal(advisory?.installedVersion, "4.17.15");
  assert.equal(advisory?.severity, "high");
  // Berry's report carries no fixed version; it must not be invented.
  assert.equal(advisory?.fixedIn, undefined);
});

test("yarn berry: injected deprecation notices are not vulnerabilities", () => {
  const ndjson = JSON.stringify({
    value: "request",
    children: {
      ID: "request (deprecation)",
      Issue: "request@2.88.2 is deprecated",
      Severity: "moderate",
      "Tree Versions": ["2.88.2"],
    },
  });
  const parsed = parseYarnBerryAudit(ndjson, "");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.advisories, []);
});

test("yarn berry: 'No audit suggestions' is clean, an error line is not", () => {
  const clean = JSON.stringify({
    type: "info",
    name: 0,
    displayName: "YN0000",
    indent: "",
    data: "No audit suggestions",
  });
  const parsed = parseYarnBerryAudit(clean, "");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.advisories, []);

  const failed = JSON.stringify({
    type: "error",
    name: 1,
    displayName: "YN0001",
    indent: "",
    data: "getaddrinfo ENOTFOUND registry.yarnpkg.com",
  });
  const errored = parseYarnBerryAudit(failed, "");
  assert.equal(errored.ok, false);
  assert.equal(errored.reason, "offline");
});

test("yarn flavor is decided from files, not from a version probe", () => {
  assert.equal(
    yarnFlavor(project({ "package.json": '{"packageManager":"yarn@4.18.0"}' })),
    "berry",
  );
  assert.equal(
    yarnFlavor(project({ "package.json": '{"packageManager":"yarn@1.22.22"}' })),
    "classic",
  );
  assert.equal(
    yarnFlavor(project({ "package.json": "{}", ".yarnrc.yml": "nodeLinker: node-modules\n" })),
    "berry",
  );
  assert.equal(
    yarnFlavor(project({ "package.json": "{}", "yarn.lock": "__metadata:\n  version: 8\n" })),
    "berry",
  );
  assert.equal(
    yarnFlavor(project({ "package.json": "{}", "yarn.lock": "# yarn lockfile v1\n" })),
    "classic",
  );
});

// ── bun ────────────────────────────────────────────────────────────────────

test("bun: parses the raw registry bulk response it echoes", () => {
  const bulk = JSON.stringify({
    ms: [
      {
        id: 1094419,
        url: "https://github.com/advisories/GHSA-w9mr-4mfr-499f",
        title: "Vercel ms Inefficient Regular Expression Complexity vulnerability",
        severity: "moderate",
        vulnerable_versions: "<2.0.0",
        cwe: ["CWE-1333"],
        cvss: { score: 5.3, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" },
      },
    ],
  });
  const parsed = parseBunAudit(bulk, "");
  assert.equal(parsed.ok, true);
  const advisory = parsed.advisories[0];
  assert.equal(advisory?.packageName, "ms");
  assert.equal(advisory?.severity, "moderate");
  // The GHSA is recovered from the URL so bun's ids line up with the others'.
  assert.equal(advisory?.id, "GHSA-w9mr-4mfr-499f");
  // The bulk response has neither of these, and neither is invented.
  assert.equal(advisory?.installedVersion, undefined);
  assert.equal(advisory?.fixedIn, undefined);
});

test("bun: an empty stdout is a failure, because bun prints nothing on error", () => {
  const parsed = parseBunAudit("", "error: audit request failed");
  assert.equal(parsed.ok, false);
  assert.equal(parsed.reason, "offline");
});

test("bun: `{}` is a genuine clean audit", () => {
  const parsed = parseBunAudit("{}", "");
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.advisories, []);
});

// ── shared behaviour ───────────────────────────────────────────────────────

test("no parser reads malformed or truncated JSON as clean", () => {
  for (const bad of ["", "   ", "not json", '{"vulnerabilities": {', "[1,2,3]"]) {
    assert.equal(parseNpmAudit(bad, "").ok, false, `npm: ${bad}`);
    assert.equal(parsePnpmAudit(bad, "").ok, false, `pnpm: ${bad}`);
    assert.equal(parseYarnClassicAudit(bad, "").ok, false, `yarn classic: ${bad}`);
    assert.equal(parseYarnBerryAudit(bad, "").ok, false, `yarn berry: ${bad}`);
    assert.equal(parseBunAudit(bad, "").ok, false, `bun: ${bad}`);
  }
});

test("every common network errno is recognised as offline", () => {
  for (const evidence of [
    "getaddrinfo ENOTFOUND registry.npmjs.org",
    "getaddrinfo EAI_AGAIN registry.npmjs.org",
    "connect ECONNREFUSED 127.0.0.1:443",
    "read ECONNRESET",
    "network timeout at: https://registry.npmjs.org",
    "socket hang up",
    "ERR_PNPM_AUDIT_BAD_RESPONSE",
    "error: audit request failed (status 503)",
  ]) {
    assert.equal(looksOffline(evidence), true, evidence);
  }
  assert.equal(looksOffline("found 3 vulnerabilities"), false);
});

test("the severity floor keeps unknown severities rather than dropping them", () => {
  assert.equal(meetsFloor("critical", "high"), true);
  assert.equal(meetsFloor("high", "high"), true);
  assert.equal(meetsFloor("moderate", "high"), false);
  assert.equal(meetsFloor("info", "low"), false);
  // Fail closed: a severity outside the vocabulary is reported, not filtered.
  assert.equal(meetsFloor(undefined, "critical"), true);
});

test("each manager gets its own argv, and none of them is a shell string", () => {
  const npm = auditCommand(
    resolveProjectEnvironment(project({ "package-lock.json": "{}" })),
    "high",
  );
  assert.deepEqual(npm, ["npm", "audit", "--json", "--no-offline"]);

  const pnpm = auditCommand(
    resolveProjectEnvironment(project({ "pnpm-lock.yaml": "lockfileVersion: '9.0'\n" })),
    "moderate",
  );
  assert.deepEqual(pnpm, ["pnpm", "audit", "--json", "--audit-level", "moderate"]);

  const berry = auditCommand(
    resolveProjectEnvironment(
      project({ "package.json": '{"packageManager":"yarn@4.0.0"}', "yarn.lock": "__metadata:\n" }),
    ),
    "high",
  );
  assert.deepEqual(berry, [
    "yarn",
    "npm",
    "audit",
    "--json",
    "--all",
    "--recursive",
    "--no-deprecations",
  ]);

  const classic = auditCommand(
    resolveProjectEnvironment(project({ "yarn.lock": "# yarn lockfile v1\n" })),
    "high",
  );
  assert.deepEqual(classic, ["yarn", "audit", "--json"]);
});

test("an unidentifiable project skips visibly instead of auditing nothing", async () => {
  const outcome = await runAudit({
    env: resolveProjectEnvironment(project({ "package.json": '{"name":"x"}' })),
    maxViolations: 25,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "not-configured");
  assert.match(outcome.message, /will not guess which auditor to run/u);
});

// ── The shared vocabulary: the severity floor, and the failure excerpt ─────

test("toSeverity accepts the vocabulary in any case and rejects everything else", () => {
  assert.equal(toSeverity("high"), "high");
  assert.equal(toSeverity("HIGH"), "high");
  assert.equal(toSeverity("Moderate"), "moderate");
  assert.equal(toSeverity("info"), "info");
  // A value outside the vocabulary must stay UNKNOWN, not be coerced to a
  // rank: `meetsFloor` reports an unknown severity regardless of the floor,
  // and coercing it to `low` here would silently drop the finding instead.
  assert.equal(toSeverity("severe"), undefined);
  assert.equal(toSeverity(""), undefined);
  assert.equal(toSeverity(undefined), undefined);
});

test("toSeverity feeds meetsFloor: an unrecognised severity is still reported", () => {
  assert.equal(meetsFloor(toSeverity("critical"), "high"), true);
  assert.equal(meetsFloor(toSeverity("low"), "high"), false);
  assert.equal(meetsFloor(toSeverity("catastrophic"), "critical"), true);
});

test("excerpt keeps the first non-empty lines, which carry the cause", () => {
  const output = [
    "",
    "  npm error code ENOTFOUND  ",
    "",
    "npm error syscall getaddrinfo",
    "npm error errno ENOTFOUND",
  ].join("\n");
  assert.equal(
    excerpt(output),
    "npm error code ENOTFOUND\nnpm error syscall getaddrinfo\nnpm error errno ENOTFOUND",
  );
});

test("excerpt caps the output, so a multi-kilobyte HTTP body is not the report", () => {
  const long = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  assert.equal(excerpt(long).split("\n").length, 8);
  assert.equal(excerpt(long, 2), "line 0\nline 1");
  assert.equal(excerpt(""), "");
  assert.equal(excerpt("\n  \n\t\n"), "");
});
