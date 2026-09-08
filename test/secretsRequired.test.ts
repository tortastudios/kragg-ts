/**
 * The secret gate's REQUIRED-vs-OPTIONAL split, and what it scans (TOR-1367).
 *
 * Three fail-open holes are closed here, and each one produced a green or
 * silent run over a repository nothing had looked at:
 *
 *  1. `secret_scanner` naming a tool that is not installed reported a SKIP and
 *     exit 0. A project that pinned a scanner and got exit 0 believes it was
 *     scanned. A named tool is REQUIRED: exit 3, with the install command.
 *  2. A gitleaks that is installed and CRASHES on `gitleaks version` reported
 *     a skip too — and under `"auto"` the run then fell through to secretlint,
 *     came back green, and the crash disappeared from the report entirely.
 *  3. secretlint received `src/a.ts/` + `**` + `/*` for a literal FILE target,
 *     which matches nothing: the tool exited 0 having read no file, and the
 *     gate reported a clean scan of the file the caller asked about. `--file`,
 *     `--changed` and the Claude hook all pass files.
 *
 * As in `secrets.test.ts`, NOTHING HERE INSTALLS OR RUNS A SCANNER: the
 * lookup and the command runner are the gate's own injected seams, and the
 * targets are real directories in a throwaway tree so the file-versus-
 * directory question is answered by the filesystem and not by a stub.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import type { CompletedCommand } from "../src/engine/models.ts";
import { resolveProjectEnvironment } from "../src/environment/project.ts";
import {
  runSecretScan,
  type RunCommand,
  type SecretScannerChoice,
  type SecretScannerLookup,
  type SecretsOutcome,
} from "../src/gates/secrets.ts";
import * as secretlint from "../src/gates/secrets/secretlint.ts";

const GITLEAKS_BIN = "/opt/bin/gitleaks";
const SECRETLINT_BIN = "node_modules/.bin/secretlint";

const roots: string[] = [];

after(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** A throwaway project with `src/a.ts` in it, so targets are real paths. */
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-secrets-required-"));
  roots.push(root);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  return root;
}

interface Reply {
  readonly returncode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

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
    return Promise.resolve<CompletedCommand>({
      name,
      command: [...command],
      cwd,
      returncode: reply.returncode,
      stdout: reply.stdout ?? "",
      stderr: reply.stderr ?? "",
    });
  };
  return { run, commands };
}

/** A lookup that records which scanners were even asked about. */
function lookup(bins: {
  readonly gitleaks?: string | null;
  readonly secretlint?: string | null;
}): SecretScannerLookup & { readonly asked: string[] } {
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

function errorMessage(outcome: SecretsOutcome): string {
  const seen = JSON.stringify(outcome);
  assert.equal(outcome.ok, false, `expected an error, got a scan: ${seen}`);
  assert.equal(outcome.skipped, false, `expected an error, got a skip: ${seen}`);
  return !outcome.ok && !outcome.skipped ? outcome.message : "";
}

function skipReason(outcome: SecretsOutcome): string {
  const seen = JSON.stringify(outcome);
  assert.equal(outcome.ok, false, `expected a skip, got a scan: ${seen}`);
  assert.equal(outcome.skipped, true, `expected a skip, got an error: ${seen}`);
  return !outcome.ok && outcome.skipped ? outcome.reason : "";
}

/** Run the gate against a real root, with both seams injected. */
function scan(
  root: string,
  scanner: SecretScannerChoice,
  lk: SecretScannerLookup,
  run: RunCommand,
  targets?: readonly string[],
): Promise<SecretsOutcome> {
  return runSecretScan({
    env: resolveProjectEnvironment(root),
    scanner,
    lookup: lk,
    run,
    ...(targets === undefined ? {} : { targets }),
  });
}

describe("a named scanner is required, autodetection is not", () => {
  it("errors with exit-3 semantics when the named scanner is not installed", async () => {
    const root = project();
    const message = errorMessage(await scan(root, "secretlint", lookup({}), runner().run));
    assert.ok(message.includes('secret_scanner = "secretlint"'), message);
    assert.ok(message.includes("NOT scanned"), message);
    // Actionable both ways: install it, or say you did not want it.
    assert.ok(message.includes("@secretlint/secretlint-rule-preset-recommend"), message);
    assert.ok(message.includes('"off"'), message);
  });

  it("still SKIPS under auto when nothing is installed — the default is unchanged", async () => {
    const root = project();
    const reason = skipReason(await scan(root, "auto", lookup({}), runner().run));
    assert.ok(reason.includes("no secret scanner available"), reason);
    assert.ok(reason.includes("gitleaks"), reason);
    assert.ok(reason.includes("secretlint"), reason);
  });

  it("still SKIPS under off, without probing for a scanner", async () => {
    const root = project();
    const disabled = lookup({ gitleaks: GITLEAKS_BIN });
    const reason = skipReason(await scan(root, "off", disabled, runner().run));
    assert.ok(reason.includes("disabled by policy"), reason);
    assert.deepEqual(disabled.asked, []);
  });

  it("errors when the named gitleaks is installed but too old to use safely", async () => {
    const root = project();
    const message = errorMessage(
      await scan(root, "gitleaks", lookup({ gitleaks: GITLEAKS_BIN }), runner({
        returncode: 0,
        stdout: "8.18.4",
      }).run),
    );
    assert.ok(message.includes("too old"), message);
    assert.ok(message.includes("8.22.0"), message);
    assert.ok(message.includes("NOT scanned"), message);
  });
});

describe("a version probe that fails never disappears", () => {
  it("errors, and quotes the probe's stderr, when gitleaks crashes", async () => {
    const root = project();
    const { run, commands } = runner({
      returncode: 1,
      stderr: "FTL failed to load config: unknown rule id 'aws'",
    });
    const message = errorMessage(
      await scan(root, "gitleaks", lookup({ gitleaks: GITLEAKS_BIN }), run),
    );
    // The tool IS there, so "install gitleaks" would be the wrong advice; the
    // tool's own diagnostic is the only thing that helps.
    assert.ok(message.includes("is installed"), message);
    assert.ok(message.includes("unknown rule id"), message);
    assert.ok(message.includes("NOT scanned"), message);
    // Probed once, and never scanned with a binary that cannot report itself.
    assert.deepEqual(commands, [[GITLEAKS_BIN, "version"]]);
  });

  it("does not let auto bury a crashed gitleaks under a green secretlint", async () => {
    // THE DISAPPEARING FAILURE: `auto` used to treat a crashed probe as
    // "unusable", run secretlint instead, and report a clean scan — so a
    // gitleaks that had stopped working was invisible for as long as the
    // other tool kept passing.
    const root = project();
    const bins = lookup({ gitleaks: GITLEAKS_BIN, secretlint: SECRETLINT_BIN });
    const { run, commands } = runner({ returncode: 1, stderr: "FTL boom" });
    const message = errorMessage(await scan(root, "auto", bins, run));
    assert.ok(message.includes("FTL boom"), message);
    assert.ok(message.includes("does not fall back"), message);
    assert.deepEqual(commands, [[GITLEAKS_BIN, "version"]], "secretlint must not have run");
    assert.deepEqual(bins.asked, ["gitleaks"], "secretlint must not even be looked up");
  });

  it("keeps auto's fallback for a gitleaks that is merely absent", async () => {
    // The other half of the same rule: NOT INSTALLED is autodetection working
    // as designed, and must still fall through to the next candidate.
    const root = project();
    const bins = lookup({ gitleaks: null, secretlint: SECRETLINT_BIN });
    const outcome = await scan(root, "auto", bins, runner({ returncode: 0, stdout: "[]" }).run);
    assert.equal(outcome.ok && outcome.scanner, "secretlint");
  });
});

describe("what secretlint is actually pointed at", () => {
  it("passes a literal file as a file, and a directory as a recursive glob", () => {
    const root = project();
    const command = secretlint.scanCommand({
      root,
      bin: SECRETLINT_BIN,
      targets: ["src/a.ts", "src", ".", "src/**/*.ts"],
      baselinePath: null,
    });
    // THE BUG: `src/a.ts` + the directory glob matches nothing at all, and
    // secretlint then exits 0 having read no file.
    assert.ok(command.includes("src/a.ts"), command.join(" "));
    assert.equal(command.includes("src/a.ts/**/*"), false, command.join(" "));
    // Directories still need the glob, or they match the directory entry.
    assert.ok(command.includes("src/**/*"), command.join(" "));
    assert.ok(command.includes("**/*"), command.join(" "));
    // An explicit glob is the caller being precise; it is passed through.
    assert.ok(command.includes("src/**/*.ts"), command.join(" "));
  });

  it("scans the file the caller named, end to end", async () => {
    const root = project();
    const { run, commands } = runner({ returncode: 0, stdout: "[]" });
    const outcome = await scan(
      root,
      "secretlint",
      lookup({ secretlint: SECRETLINT_BIN }),
      run,
      ["src/a.ts"],
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(commands[0]?.slice(-1), ["src/a.ts"]);
  });

  it("hands gitleaks the file itself — `dir` walks a path, glob or not", async () => {
    const root = project();
    const { run, commands } = runner({ returncode: 0, stdout: "8.28.0" }, {
      returncode: 0,
      stdout: "[]",
    });
    const outcome = await scan(root, "gitleaks", lookup({ gitleaks: GITLEAKS_BIN }), run, [
      "src/a.ts",
    ]);
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(commands[1]?.slice(-1), [join(root, "src", "a.ts")]);
  });

  it("refuses a scope that does not exist instead of matching nothing", async () => {
    const root = project();
    const bins = lookup({ secretlint: SECRETLINT_BIN });
    const { run, commands } = runner();
    const message = errorMessage(await scan(root, "auto", bins, run, ["src/gone.ts"]));
    assert.ok(message.includes("src/gone.ts"), message);
    assert.ok(message.includes("does not"), message);
    assert.deepEqual(commands, [], "nothing may be scanned for an unreadable scope");
  });

  it("leaves an existing scope and a glob alone", async () => {
    const root = project();
    const { run, commands } = runner({ returncode: 0, stdout: "[]" });
    const outcome = await scan(
      root,
      "secretlint",
      lookup({ secretlint: SECRETLINT_BIN }),
      run,
      ["src", "**/*.env"],
    );
    assert.equal(outcome.ok, true, JSON.stringify(outcome));
    assert.deepEqual(commands[0]?.slice(-2), ["src/**/*", "**/*.env"]);
  });
});
