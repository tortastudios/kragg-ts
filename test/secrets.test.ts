/**
 * Tests for the secret-scanning gate.
 *
 * NOTHING HERE INSTALLS OR RUNS A SCANNER. gitleaks and secretlint are driven
 * through injected fakes, against JSON fixtures matching the schemas verified
 * upstream (see the module docs in `src/gates/secrets/*.ts`). That is a
 * constraint, not a shortcut: this package must not acquire a security scanner
 * as a dependency, and a test that shelled out to one would only prove
 * something about the machine it ran on.
 *
 * The weight is on the four ways this gate can be dangerously wrong: a secret
 * reaching a `Violation` (they land in `.kragg/history.jsonl`, in terminals
 * and in agent transcripts, so `SECRET_SENTINELS` are planted in every field a
 * scanner puts matched material in); a crashed scanner looking clean (gitleaks
 * exits non-zero when it FINDS things, so the split is tested from both
 * sides); an explicit scanner choice being silently swapped for the other; and
 * an unavailable gate reporting green instead of a visible skip.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { CompletedCommand } from "../src/engine/models.ts";
import type { ProjectEnvironment } from "../src/environment/project.ts";
import {
  findGitleaksOnPath,
  runSecretScan,
  SECRET_CODE,
  type RunCommand,
  type SecretScannerChoice,
  type SecretScannerLookup,
  type SecretsOutcome,
} from "../src/gates/secrets.ts";
import * as gitleaks from "../src/gates/secrets/gitleaks.ts";
import { isRecord, MAX_TEXT_LENGTH, plainText } from "../src/gates/secrets/types.ts";
import * as secretlint from "../src/gates/secrets/secretlint.ts";

/**
 * Fake credentials planted in the fixtures — the values AWS itself publishes
 * as examples. If one survives into a violation, the gate is disclosing the
 * thing it exists to find.
 */
const SECRET_SENTINELS = [
  "AKIAIOSFODNN7EXAMPLE",
  "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  "hunter2-commit-message",
] as const;

/** A gitleaks v8 finding, with every secret-bearing field populated. */
const GITLEAKS_REPORT = JSON.stringify([
  {
    RuleID: "aws-access-token", File: "config/settings.ts", SymlinkFile: "",
    Description: "Identified a pattern that may indicate AWS credentials",
    StartLine: 42, EndLine: 42, StartColumn: 15, EndColumn: 34, Entropy: 3.4,
    Match: `aws_key = ${SECRET_SENTINELS[0]}`, Secret: SECRET_SENTINELS[0],
    Line: `  aws_key = ${SECRET_SENTINELS[0]}`, Message: SECRET_SENTINELS[2],
    Commit: "8f2c1ab", Author: "Someone", Email: "someone@example.com",
    Date: "2026-01-02T03:04:05Z", Tags: [], Fingerprint: "config/settings.ts:aws:42",
  },
]);

/** A secretlint report: one result per file scanned, plus an `ignore` entry. */
const SECRETLINT_REPORT = JSON.stringify([
  {
    filePath: ".env.local",
    sourceContent: `AWS_SECRET_ACCESS_KEY=${SECRET_SENTINELS[1]}\n`,
    sourceContentType: "text",
    messages: [
      {
        type: "message", messageId: "AWSSecretAccessKey", severity: "error",
        ruleId: "@secretlint/secretlint-rule-aws",
        ruleParentId: "@secretlint/secretlint-rule-preset-recommend",
        message: `found AWS Secret Access Key: ${SECRET_SENTINELS[1]}`,
        range: [22, 62], docsUrl: "https://github.com/secretlint/secretlint",
        loc: { start: { line: 3, column: 22 }, end: { line: 3, column: 62 } },
        data: { secret: SECRET_SENTINELS[1] },
      },
      {
        type: "ignore", ruleId: "@secretlint/secretlint-rule-aws",
        targetRuleId: "*", range: [0, 1],
        message: `allowed: ${SECRET_SENTINELS[0]}`,
      },
    ],
  },
  { filePath: "src/index.ts", sourceContent: "", sourceContentType: "text", messages: [] },
]);

const ENV: ProjectEnvironment = {
  root: "/repo", packageManager: "pnpm", source: "pnpm-lock.yaml",
  binDir: "/repo/node_modules/.bin",
  workspaces: { kind: "none", configPath: null, patterns: [], note: null },
};

const GITLEAKS_BIN = "/opt/bin/gitleaks";
const SECRETLINT_BIN = "/repo/node_modules/.bin/secretlint";
interface Reply { readonly returncode: number; readonly stdout?: string; readonly stderr?: string }

/** The `gitleaks version` reply, for tests where the version is not the point. */
const GOOD_VERSION: Reply = { returncode: 0, stdout: "8.28.0\n" };

/** Which scanners the fake lookup should claim are installed. */
interface Bins { readonly gitleaks?: string | null; readonly secretlint?: string | null }

/** A `RunCommand` that replays scripted replies and records the argv it saw. */
function runner(...replies: readonly Reply[]): {
  readonly run: RunCommand;
  readonly commands: (readonly string[])[];
} {
  const commands: (readonly string[])[] = [];
  let index = 0;
  const run: RunCommand = (name, command, cwd) => {
    commands.push(command);
    const reply: Reply = replies[index] ?? { returncode: 0, stdout: "[]" };
    index += 1;
    const { returncode } = reply;
    const [stdout, stderr] = [reply.stdout ?? "", reply.stderr ?? ""];
    return Promise.resolve<CompletedCommand>({
      name, command: [...command], cwd, returncode, stdout, stderr,
    });
  };
  return { run, commands };
}

/** A lookup that records which scanners were even asked about. */
function lookup(bins: Bins): SecretScannerLookup & { readonly asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    findGitleaks: () => {
      asked.push("gitleaks");
      return bins.gitleaks ?? null;
    },
    findSecretlint: () => {
      asked.push("secretlint");
      return bins.secretlint ?? null;
    },
  };
}

/** Run the gate against an explicit lookup, so `asked` can be inspected. */
function scanWith(
  scanner: SecretScannerChoice,
  lk: SecretScannerLookup,
  run: RunCommand = runner().run,
  targets?: readonly string[],
): Promise<SecretsOutcome> {
  const extra = targets === undefined ? {} : { targets };
  return runSecretScan({ env: ENV, scanner, lookup: lk, run, ...extra });
}

/** Run the gate: what is installed, then what each invocation replies. */
function scan(
  scanner: SecretScannerChoice,
  bins: Bins,
  ...replies: readonly Reply[]
): Promise<SecretsOutcome> {
  return scanWith(scanner, lookup(bins), runner(...replies).run);
}

function skipReason(outcome: SecretsOutcome): string {
  const seen = JSON.stringify(outcome);
  assert.equal(outcome.ok, false, `expected a skip, got a scan: ${seen}`);
  assert.equal(outcome.skipped, true, `expected a skip, got an error: ${seen}`);
  return !outcome.ok && outcome.skipped ? outcome.reason : "";
}

function errorMessage(outcome: SecretsOutcome): string {
  const seen = JSON.stringify(outcome);
  assert.equal(outcome.ok, false, `expected an error, got a scan: ${seen}`);
  assert.equal(outcome.skipped, false, `expected an error, got a skip: ${seen}`);
  return !outcome.ok && !outcome.skipped ? outcome.message : "";
}

/** Assert that no planted credential appears anywhere in a value. */
function assertRedacted(value: unknown, extra: readonly string[] = []): void {
  const serialized = JSON.stringify(value);
  for (const needle of [...SECRET_SENTINELS, ...extra]) {
    assert.equal(serialized.includes(needle), false, `\`${needle}\` survived: ${serialized}`);
  }
}

describe("redaction", () => {
  it("keeps every secret out of gitleaks violations", () => {
    const violations = gitleaks.parseReport(GITLEAKS_REPORT);
    assert.equal(violations?.length, 1);
    // Not even a fragment: a truncated key is still a disclosure, and the
    // surrounding source line is what `Line`/`Match` would have leaked.
    assertRedacted(violations, ["AKIA", "aws_key"]);
  });
  it("keeps every secret out of secretlint violations", () => {
    const violations = secretlint.parseReport(SECRETLINT_REPORT);
    assert.notEqual(violations, null);
    // `message` interpolates the match and `sourceContent` is the whole file;
    // neither may be echoed even in part.
    assertRedacted(violations, ["found AWS Secret Access Key", "AWS_SECRET_ACCESS_KEY="]);
  });
  it("survives a whole scan without leaking, end to end", async () => {
    const outcome = await scan("auto", { gitleaks: GITLEAKS_BIN }, GOOD_VERSION, {
      returncode: 66,
      stdout: GITLEAKS_REPORT,
    });
    assert.equal(outcome.ok, true);
    assertRedacted(outcome);
  });
  it("strips control characters and caps runaway text", () => {
    // ESC and BEL, built without literal control bytes in this source: a rule
    // description out of an untrusted repo must not repaint the terminal
    // printing the report.
    const escape = String.fromCharCode(27);
    const bell = String.fromCharCode(7);
    const hostile = JSON.stringify([
      { RuleID: `${escape}[2Kfake-clean${bell}`, Description: "x".repeat(400), File: "a.ts" },
    ]);
    const message = gitleaks.parseReport(hostile)?.[0]?.message ?? "";
    assert.equal(message.includes(escape), false, JSON.stringify(message));
    assert.equal(message.includes(bell), false, JSON.stringify(message));
    assert.ok(message.length < 300, `not capped: ${String(message.length)}`);
  });
});

describe("gitleaks adapter", () => {
  it("distinguishes leaks found from scanner broken", () => {
    assert.equal(gitleaks.classifyExit(0), "clean");
    assert.equal(gitleaks.classifyExit(gitleaks.LEAK_EXIT_CODE), "leaks");
    // gitleaks' own hardcoded error status, which is ALSO its default leak
    // status — the whole reason we override `--exit-code`.
    assert.equal(gitleaks.classifyExit(1), "error");
    assert.equal(gitleaks.classifyExit(126), "error");
    // `runCommand`'s status for a missing binary, a timeout or a signal.
    assert.equal(gitleaks.classifyExit(127), "error");
  });
  it("maps a finding to file, line, column and rule", () => {
    const violation = gitleaks.parseReport(GITLEAKS_REPORT)?.[0];
    assert.equal(violation?.file, "config/settings.ts");
    assert.equal(violation?.line, 42);
    assert.equal(violation?.column, 15);
    assert.equal(violation?.code, SECRET_CODE);
    assert.ok(violation?.message.includes("aws-access-token"));
    assert.ok((violation?.fixHint ?? "").includes("rotate"));
  });
  it("reads an empty report as clean and a broken one as unreadable", () => {
    assert.deepEqual(gitleaks.parseReport("[]"), []);
    assert.deepEqual(gitleaks.parseReport("null"), []);
    assert.deepEqual(gitleaks.parseReport("   "), []);
    assert.equal(gitleaks.parseReport("not json"), null);
    assert.equal(gitleaks.parseReport('{"findings": []}'), null);
    // One unreadable entry must not discard the readable one beside it.
    assert.equal(gitleaks.parseReport('[3, {"RuleID": "x", "File": "a.ts"}]')?.length, 1);
  });
  it("enforces the version floor rather than assuming it", () => {
    assert.deepEqual(gitleaks.parseVersion("8.28.0\n"), [8, 28, 0]);
    assert.deepEqual(gitleaks.parseVersion("v8.22.0"), [8, 22, 0]);
    // A `go build` without ldflags prints this; it is not a version.
    assert.equal(gitleaks.parseVersion("unknown"), null);
    assert.equal(gitleaks.parseVersion(""), null);
    assert.equal(gitleaks.versionSupported([8, 22, 0]), true);
    assert.equal(gitleaks.versionSupported([8, 30, 1]), true);
    assert.equal(gitleaks.versionSupported([9, 0, 0]), true);
    assert.equal(gitleaks.versionSupported([8, 21, 9]), false);
    assert.equal(gitleaks.versionSupported([7, 99, 99]), false);
  });
  it("builds a v8 argv that keeps the report off disk", () => {
    const context = {
      root: "/repo",
      bin: GITLEAKS_BIN,
      targets: ["."],
      baselinePath: ".gitleaks-baseline.json",
    };
    const command = gitleaks.scanCommand(context, "src");
    assert.equal(command[1], "dir", "must use `dir`, not the deprecated `detect`");
    assert.equal(command[command.indexOf("--report-format") + 1], "json");
    // `-` is stdout: the unredacted report never becomes a file.
    assert.equal(command[command.indexOf("--report-path") + 1], "-");
    assert.equal(
      command[command.indexOf("--exit-code") + 1],
      String(gitleaks.LEAK_EXIT_CODE),
      "leaks must get a status distinct from gitleaks' error status",
    );
    assert.equal(
      command[command.indexOf("--baseline-path") + 1],
      join("/repo", ".gitleaks-baseline.json"),
    );
    assert.equal(command.at(-1), join("/repo", "src"));
  });
});

describe("secretlint adapter", () => {
  it("classifies its documented exit statuses", () => {
    assert.equal(secretlint.classifyExit(0), "clean");
    assert.equal(secretlint.classifyExit(1), "leaks");
    // 2 is secretlint's documented fatal error: a broken scan, not a clean
    // repo and not a finding.
    assert.equal(secretlint.classifyExit(2), "error");
    assert.equal(secretlint.classifyExit(127), "error");
  });
  it("never passes --output, which would force exit 0 despite findings", () => {
    const command = secretlint.scanCommand({
      root: "/repo",
      bin: SECRETLINT_BIN,
      targets: ["src", "."],
      baselinePath: ".secretlintignore",
    });
    assert.equal(command.includes("--output"), false);
    assert.equal(command[command.indexOf("--format") + 1], "json");
    assert.equal(
      command[command.indexOf("--secretlintignore") + 1],
      join("/repo", ".secretlintignore"),
    );
    assert.ok(command.includes("src/**/*"));
    assert.ok(command.includes("**/*"));
  });
  it("turns directory targets into globs secretlint will actually match", () => {
    // A bare `src` matches the directory entry, not the files under it.
    assert.equal(secretlint.globFor("src"), "src/**/*");
    assert.equal(secretlint.globFor("src/"), "src/**/*");
    assert.equal(secretlint.globFor("."), "**/*");
    assert.equal(secretlint.globFor("src/**/*.ts"), "src/**/*.ts");
  });
  it("reports messages, skips ignores, and fixes the column base", () => {
    const violations = secretlint.parseReport(SECRETLINT_REPORT) ?? [];
    assert.equal(violations.length, 1, "the `ignore` entry must not become a violation");
    const violation = violations[0];
    assert.equal(violation?.file, ".env.local");
    assert.equal(violation?.line, 3);
    // secretlint columns are 0-based; `violationLocation` renders 1-based.
    assert.equal(violation?.column, 23);
    assert.ok(violation?.message.includes("AWSSecretAccessKey"));
  });
  it("reads a file-with-no-findings report as clean, not as an empty report", () => {
    assert.deepEqual(secretlint.parseReport("[]"), []);
    assert.equal(secretlint.parseReport("{}"), null);
    assert.equal(secretlint.parseReport("<html>"), null);
  });
});

describe("scanner resolution", () => {
  it("auto prefers gitleaks", async () => {
    const { run, commands } = runner(GOOD_VERSION, { returncode: 0, stdout: "[]" });
    const bins = { gitleaks: GITLEAKS_BIN, secretlint: SECRETLINT_BIN };
    const outcome = await scanWith("auto", lookup(bins), run);
    assert.equal(outcome.ok && outcome.scanner, "gitleaks");
    assert.equal(commands[0]?.[0], GITLEAKS_BIN);
  });
  it("auto falls back to secretlint when gitleaks is absent", async () => {
    const outcome = await scan("auto", { gitleaks: null, secretlint: SECRETLINT_BIN }, {
      returncode: 1,
      stdout: SECRETLINT_REPORT,
    });
    assert.equal(outcome.ok && outcome.scanner, "secretlint");
    assert.equal(outcome.ok && outcome.violations.length, 1);
  });
  it("auto falls back when gitleaks is present but too old to use safely", async () => {
    const bins = { gitleaks: GITLEAKS_BIN, secretlint: SECRETLINT_BIN };
    const outcome = await scan(
      "auto",
      bins,
      { returncode: 0, stdout: "8.18.4" },
      { returncode: 0, stdout: "[]" },
    );
    assert.equal(outcome.ok && outcome.scanner, "secretlint");
  });
  it("auto skips visibly, naming both tools, when neither is available", async () => {
    const reason = skipReason(await scan("auto", {}));
    assert.ok(reason.includes("gitleaks"), reason);
    assert.ok(reason.includes("secretlint"), reason);
    assert.ok(reason.includes("brew install gitleaks") || reason.includes("releases"), reason);
    assert.ok(reason.includes("pnpm add -D"), reason);
    assert.ok(
      reason.includes("@secretlint/secretlint-rule-preset-recommend"),
      "the install command must be copy-pasteable, preset included",
    );
  });
  it("does not silently substitute the other scanner for an explicit choice", async () => {
    const wantGitleaks = lookup({ gitleaks: null, secretlint: SECRETLINT_BIN });
    const reason = skipReason(await scanWith("gitleaks", wantGitleaks));
    assert.ok(reason.includes("gitleaks"), reason);
    assert.equal(reason.includes("secretlint"), false, `fell back silently: ${reason}`);
    assert.deepEqual(
      wantGitleaks.asked,
      ["gitleaks"],
      "secretlint must not even be looked up for an explicit gitleaks choice",
    );

    const wantSecretlint = lookup({ gitleaks: GITLEAKS_BIN, secretlint: null });
    const other = skipReason(await scanWith("secretlint", wantSecretlint));
    assert.ok(other.includes("secretlint"), other);
    assert.deepEqual(wantSecretlint.asked, ["secretlint"]);
  });
  it("distinguishes disabled-by-policy from no-scanner-found", async () => {
    const disabled = lookup({ gitleaks: GITLEAKS_BIN });
    const reason = skipReason(await scanWith("off", disabled));
    assert.ok(reason.includes("disabled by policy"), reason);
    assert.equal(reason.includes("install"), false, reason);
    assert.deepEqual(disabled.asked, [], "`off` must not probe for scanners at all");
  });
  it("skips rather than passes when there is nothing to scan", async () => {
    const empty = lookup({ gitleaks: GITLEAKS_BIN });
    const reason = skipReason(await scanWith("auto", empty, runner().run, []));
    assert.ok(reason.includes("no scan targets"), reason);
  });
});

describe("found leaks versus broken scanner", () => {
  it("reports gitleaks findings as violations, not as a crash", async () => {
    const outcome = await scan("gitleaks", { gitleaks: GITLEAKS_BIN }, GOOD_VERSION, {
      returncode: 66,
      stdout: GITLEAKS_REPORT,
    });
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.equal(outcome.ok && outcome.violations.length, 1);
  });
  it("reports a crashed gitleaks as an error, not as a clean repo", async () => {
    const message = errorMessage(
      await scan("gitleaks", { gitleaks: GITLEAKS_BIN }, GOOD_VERSION, {
        returncode: 1,
        stderr: "FTL failed to load config: unknown rule",
      }),
    );
    assert.ok(message.includes("NOT scanned"), message);
    assert.ok(message.includes("unknown rule"), message);
  });
  it("refuses to call a leak-status-with-no-findings a clean scan", async () => {
    const outcome = await scan("gitleaks", { gitleaks: GITLEAKS_BIN }, GOOD_VERSION, {
      returncode: 66,
      stdout: "[]",
    });
    assert.ok(errorMessage(outcome).includes("reported none"));
  });
  it("errors on an unparseable report without quoting it back", async () => {
    const outcome = await scan("gitleaks", { gitleaks: GITLEAKS_BIN }, GOOD_VERSION, {
      returncode: 66,
      stdout: `panic: boom\n[{"Secret":"${SECRET_SENTINELS[0]}"`,
    });
    const message = errorMessage(outcome);
    assert.ok(message.includes("could not be parsed"), message);
    // An unparseable report is still full of credentials.
    assertRedacted(message);
  });
  it("treats a secretlint fatal error as an error and findings as findings", async () => {
    const fatal = await scan("secretlint", { secretlint: SECRETLINT_BIN }, {
      returncode: 2,
      stderr: "Not found .secretlintrc",
    });
    assert.ok(errorMessage(fatal).includes("Not found .secretlintrc"));

    const found = await scan("secretlint", { secretlint: SECRETLINT_BIN }, {
      returncode: 1,
      stdout: SECRETLINT_REPORT,
    });
    assert.equal(found.ok && found.violations.length, 1);
  });
  it("skips, rather than errors, when a resolved binary will not spawn", async () => {
    const outcome = await scan("auto", { secretlint: SECRETLINT_BIN }, {
      returncode: 127,
      stderr: "spawn secretlint ENOENT",
    });
    assert.ok(skipReason(outcome).includes("pnpm add -D"));
  });
});

describe("finding gitleaks on PATH", () => {
  const roots: string[] = [];
  after(() => {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  function sandbox(): string {
    const root = mkdtempSync(join(tmpdir(), "kragg-secrets-"));
    roots.push(root);
    return root;
  }
  it("finds an executable file on an absolute PATH entry", () => {
    const root = sandbox();
    writeFileSync(join(root, "gitleaks"), "#!/bin/sh\n", { mode: 0o755 });
    assert.equal(findGitleaksOnPath(root), join(root, "gitleaks"));
  });
  it("ignores relative and empty PATH entries", () => {
    const root = sandbox();
    writeFileSync(join(root, "gitleaks"), "#!/bin/sh\n", { mode: 0o755 });
    // A repository shipping its own `./gitleaks` must never be able to supply
    // the scanner that scans it.
    assert.equal(findGitleaksOnPath("::.:relative/bin"), null);
    assert.equal(findGitleaksOnPath(""), null);
    // ...but a real absolute entry later in the same PATH still resolves.
    assert.equal(findGitleaksOnPath(`.:${root}`), join(root, "gitleaks"));
  });
  it("rejects a non-executable file and a directory of the right name", () => {
    const plain = sandbox();
    writeFileSync(join(plain, "gitleaks"), "not executable", { mode: 0o644 });
    assert.equal(findGitleaksOnPath(plain), null);

    const asDirectory = sandbox();
    mkdirSync(join(asDirectory, "gitleaks"));
    assert.equal(findGitleaksOnPath(asDirectory), null);
  });
});

/**
 * The two narrowing helpers every scanner report is read through.
 *
 * `plainText` is the only thing standing between a hostile repository and the
 * reviewer's terminal: a rule description travels from untrusted content,
 * through a scanner, into a line printed next to a count of findings. The
 * adapters above exercise the happy path; the adversarial inputs are pinned
 * here, on the function itself. The control characters are BUILT rather than
 * written, so this file stays printable.
 */
describe("plainText / isRecord", () => {
  /** ESC — the first byte of every ANSI sequence. */
  const ESC = String.fromCodePoint(0x1b);
  /** A C1 control, which a terminal honours just as readily as a C0 one. */
  const C1 = String.fromCodePoint(0x9b);

  it("strips C0 and C1 controls rather than escaping them", () => {
    assert.equal(
      plainText(`aws${ESC}[2A key found`, "fallback"),
      "aws [2A key found",
      "an ANSI cursor-move must not survive into a terminal",
    );
    assert.equal(plainText(`a${C1}b`, "fallback"), "a b");
    assert.equal(plainText("  ragged   spacing  ", "fallback"), "ragged spacing");
  });

  it("falls back for anything that is not a usable string", () => {
    assert.equal(plainText(undefined, "no description"), "no description");
    assert.equal(plainText(42, "no description"), "no description");
    assert.equal(plainText(null, "no description"), "no description");
    assert.equal(plainText(["a"], "no description"), "no description");
    // A string made ENTIRELY of controls and whitespace strips to nothing, and
    // the fallback is the honest answer where an empty message would not be.
    assert.equal(plainText(`${ESC}${C1} `, "no description"), "no description");
    assert.equal(plainText("   ", "no description"), "no description");
  });

  it("caps a long string with an ellipsis instead of letting it scroll", () => {
    const capped = plainText("x".repeat(MAX_TEXT_LENGTH + 50), "fallback");
    assert.equal(capped.length, MAX_TEXT_LENGTH + 1);
    assert.ok(capped.endsWith("\u2026"));

    const exact = "y".repeat(MAX_TEXT_LENGTH);
    assert.equal(plainText(exact, "fallback"), exact, "at the limit nothing is elided");
  });

  it("narrows only to a plain object", () => {
    assert.equal(isRecord({ a: 1 }), true);
    assert.equal(isRecord([1, 2]), false, "an array is not the shape either report uses");
    assert.equal(isRecord(null), false);
    assert.equal(isRecord("{}"), false);
    assert.equal(isRecord(undefined), false);
  });
});
