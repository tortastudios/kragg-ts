/**
 * Tests for the subprocess wrapper, and specifically for its Windows branch.
 *
 * Uses Node's built-in `node:test` + `node:assert/strict` — no test framework
 * dependency (see docs/dependency-policy.md).
 *
 * WHY THIS FILE EXISTS. `launchPlan` is the only place in the codebase whose
 * behaviour differs by platform, and the platform it differs on is the one
 * nobody here can run. That combination is how a fix ships looking correct
 * and having never executed. So the platform is an injected argument, and
 * every branch below is exercised on whatever host runs the suite.
 *
 * WHAT THESE TESTS CANNOT DO, stated plainly: they prove the argv kragg
 * builds for Windows is the right argv. They do not prove Windows spawns it,
 * because `CreateProcess` is not involved on this host. The end-to-end case
 * (`runCommand` actually launching a shim's script) does run for real, but
 * through this platform's spawn, not Windows'.
 *
 * The load-bearing property, above all the others: no branch may introduce a
 * shell. `assertNoShell` is applied to every plan this file produces.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, describe, it } from "node:test";

import { launchPlan, runCommand } from "../src/engine/runner.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-runner-"));
  temporaryRoots.push(root);
  return root;
}

function write(path: string, contents: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents);
  return path;
}

/**
 * A `node_modules/.bin` layout with a real target script and the shims that
 * point at it, written exactly as `cmd-shim` writes them.
 *
 * The shim bodies are verbatim npm/pnpm output, `node.exe` probe included.
 * Trimming them to just the target line would test a file no installer
 * produces — and the probe line is the interesting one, because a naive
 * parser resolves it and runs the wrong thing.
 */
function shimmedProject(bin = "tsc", pkg = "typescript"): {
  readonly root: string;
  readonly cmd: string;
  readonly shell: string;
  readonly target: string;
} {
  const root = temporaryRoot();
  const binDir = join(root, "node_modules", ".bin");
  const target = write(
    join(root, "node_modules", pkg, "bin", bin),
    "#!/usr/bin/env node\nprocess.stdout.write('ok');\n",
  );

  const cmd = write(
    join(binDir, `${bin}.cmd`),
    "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\n" +
      "SETLOCAL\r\nCALL :find_dp0\r\n\r\n" +
      'IF EXIST "%dp0%\\node.exe" (\r\n' +
      '  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n' +
      "  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\n" +
      "endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & " +
      `"%_prog%"  "%dp0%\\..\\${pkg}\\bin\\${bin}" %*\r\n`,
  );

  const shell = write(
    join(binDir, bin),
    '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\n\n' +
      'if [ -x "$basedir/node" ]; then\n' +
      `  exec "$basedir/node"  "$basedir/../${pkg}/bin/${bin}" "$@"\nelse\n` +
      `  exec node  "$basedir/../${pkg}/bin/${bin}" "$@"\nfi\n`,
  );

  return { root, cmd, shell, target };
}

/**
 * The invariant, asserted mechanically rather than by reading the diff.
 *
 * A shell would have to appear as argv[0] to interpret anything, so nothing
 * named like one may ever be there — and no argument may be a shell's
 * command-string flag, which is the other half of the same mistake.
 */
function assertNoShell(command: readonly string[]): void {
  const [file, ...args] = command;
  assert.ok(file !== undefined);
  const name = basename(file).toLowerCase();
  for (const shell of ["cmd.exe", "cmd", "powershell.exe", "pwsh.exe", "sh", "bash", "zsh"]) {
    assert.notEqual(name, shell, `argv[0] must never be a shell, got ${file}`);
  }
  for (const flag of ["/c", "/C", "-c", "-Command", "/d"]) {
    assert.ok(!args.includes(flag), `argv must never carry a shell flag, got ${flag}`);
  }
}

function planned(command: readonly string[], options: Parameters<typeof launchPlan>[1]): readonly string[] {
  const plan = launchPlan(command, options);
  assert.equal(plan.kind, "spawn", `expected a spawnable plan for ${command.join(" ")}`);
  assert.ok(plan.kind === "spawn");
  assertNoShell(plan.command);
  return plan.command;
}

const NODE = "/fake/node";

describe("launchPlan on non-Windows hosts", () => {
  it("passes every argv through untouched", () => {
    const { cmd, shell } = shimmedProject();
    for (const platform of ["darwin", "linux", "freebsd"] as const) {
      assert.deepEqual(planned([shell, "--noEmit"], { platform }), [shell, "--noEmit"]);
      // Even a `.cmd`, which only exists on Windows: no rewriting anywhere else.
      assert.deepEqual(planned([cmd, "--noEmit"], { platform }), [cmd, "--noEmit"]);
    }
  });
});

describe("launchPlan on Windows", () => {
  it("runs the script a .cmd shim points at, on Node, with no shell", () => {
    const { cmd, target } = shimmedProject();
    assert.deepEqual(planned([cmd, "--noEmit", "-p", "tsconfig.json"], {
      platform: "win32",
      nodePath: NODE,
    }), [NODE, target, "--noEmit", "-p", "tsconfig.json"]);
  });

  it("ignores the shim's own node.exe probe even when that file exists", () => {
    // The `IF EXIST "%dp0%\node.exe"` line names the INTERPRETER. A parser
    // that takes the first path it finds runs node against kragg's arguments
    // and reports nonsense, so the probe must lose to the real target even
    // when the file is present.
    const { root, cmd, target } = shimmedProject();
    write(join(root, "node_modules", ".bin", "node.exe"), "MZ");
    assert.deepEqual(planned([cmd], { platform: "win32", nodePath: NODE }), [NODE, target]);
  });

  it("reads the extension-less shell shim too, which CreateProcess cannot run", () => {
    const { shell, target } = shimmedProject();
    assert.deepEqual(planned([shell, "--version"], { platform: "win32", nodePath: NODE }), [
      NODE,
      target,
      "--version",
    ]);
  });

  it("passes arguments through byte-for-byte, metacharacters included", () => {
    // The reason `cmd.exe /c` was rejected. Gates hand changed FILENAMES to
    // tools; if any layer between kragg and the tool parsed them, a file
    // named `a & calc.txt` would be a command. Nothing here parses them.
    const { cmd, target } = shimmedProject();
    const hostile = [
      "a & calc.txt",
      "b | whoami.txt",
      "c; rm -rf ~.txt",
      "%USERPROFILE%",
      'd"quote.txt',
      "e^caret.txt",
      "f>redirect.txt",
      "$(id).txt",
      "`id`.txt",
    ];
    assert.deepEqual(planned([cmd, ...hostile], { platform: "win32", nodePath: NODE }), [
      NODE,
      target,
      ...hostile,
    ]);
  });

  it("leaves real executables and bare names alone", () => {
    const root = temporaryRoot();
    const exe = write(join(root, "node_modules", ".bin", "esbuild.exe"), "MZ");
    assert.deepEqual(planned([exe, "--version"], { platform: "win32", nodePath: NODE }), [
      exe,
      "--version",
    ]);
    // No path separator: resolving PATH ourselves is the one thing this
    // project refuses to do, so a bare name stays the OS's problem.
    assert.deepEqual(planned(["git", "status"], { platform: "win32", nodePath: NODE }), [
      "git",
      "status",
    ]);
    // An empty argv is `runCommand`'s error to raise, not this function's to
    // paper over; it must arrive there unchanged.
    assert.deepEqual(launchPlan([], { platform: "win32", nodePath: NODE }), {
      kind: "spawn",
      command: [],
    });
  });

  it("still tries an extension-less file that is not a shim", () => {
    // It might be a real executable. Refusing to spawn it would turn a
    // working setup into a reported failure, which is the wrong direction.
    const root = temporaryRoot();
    const plain = write(join(root, "node_modules", ".bin", "tool"), "MZ binary");
    assert.deepEqual(planned([plain], { platform: "win32", nodePath: NODE }), [plain]);
  });

  it("refuses a .cmd whose target it cannot find, and says why", () => {
    // A batch file cannot be spawned at all without a shell, so unlike the
    // extension-less case there is nothing to fall back to. Fail loudly.
    const { root, cmd } = shimmedProject();
    rmSync(join(root, "node_modules", "typescript"), { recursive: true, force: true });
    const plan = launchPlan([cmd], { platform: "win32", nodePath: NODE });
    assert.equal(plan.kind, "unlaunchable");
    assert.ok(plan.kind === "unlaunchable");
    assert.match(plan.reason, /cannot launch/);
    assert.ok(plan.reason.includes(cmd), "the reason must name the shim");
  });

  it("refuses a .cmd that points only at another shim", () => {
    // Otherwise a malformed or hostile shim could send this round in a
    // circle, or resolve to a batch file we still could not spawn.
    const root = temporaryRoot();
    const binDir = join(root, "node_modules", ".bin");
    write(join(binDir, "loop.cmd"), '@ECHO off\r\n"%dp0%\\loop.cmd" %*\r\n');
    const plan = launchPlan([join(binDir, "loop.cmd")], { platform: "win32", nodePath: NODE });
    assert.equal(plan.kind, "unlaunchable");
  });

  it("refuses a shim whose target climbs out of the install tree", () => {
    // Shims address their target with `..` segments, so an unbounded parser
    // will follow one anywhere on the disk. The target below EXISTS, which is
    // the point: only the containment bound rejects it.
    const root = temporaryRoot();
    const binDir = join(root, "node_modules", ".bin");
    write(join(root, "elsewhere", "payload"), "#!/usr/bin/env node\n");
    write(
      join(binDir, "escape.cmd"),
      '@ECHO off\r\n"%dp0%\\..\\..\\elsewhere\\payload" %*\r\n',
    );
    const plan = launchPlan([join(binDir, "escape.cmd")], { platform: "win32", nodePath: NODE });
    assert.equal(plan.kind, "unlaunchable");
  });

  it("refuses a shim too large to be one", () => {
    const root = temporaryRoot();
    const binDir = join(root, "node_modules", ".bin");
    write(join(root, "node_modules", "big", "bin", "big"), "#!/usr/bin/env node\n");
    write(
      join(binDir, "big.cmd"),
      `${"@REM padding\r\n".repeat(9000)}"%dp0%\\..\\big\\bin\\big" %*\r\n`,
    );
    const plan = launchPlan([join(binDir, "big.cmd")], { platform: "win32", nodePath: NODE });
    assert.equal(plan.kind, "unlaunchable");
  });
});

describe("runCommand", () => {
  it("launches a Windows shim's script for real", async () => {
    // The Windows BRANCH end to end: `runCommand` is given a `.cmd` and the
    // win32 platform, rewrites it, and the rewritten argv actually runs and
    // returns output. What this cannot prove is that Windows spawns it — the
    // spawn below is this host's.
    const root = temporaryRoot();
    const binDir = join(root, "node_modules", ".bin");
    write(
      join(root, "node_modules", "argv-echo", "bin", "argv-echo"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    write(
      join(binDir, "argv-echo.cmd"),
      '@ECHO off\r\nSET dp0=%~dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n' +
        '  SET "_prog=%dp0%\\node.exe"\r\n)\r\n' +
        '"%_prog%"  "%dp0%\\..\\argv-echo\\bin\\argv-echo" %*\r\n',
    );

    const hostile = ["a & calc", "%PATH%", "b | c"];
    const result = await runCommand("echo", [join(binDir, "argv-echo.cmd"), ...hostile], root, {
      platform: "win32",
    });

    assert.equal(result.returncode, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), hostile);
    // The report quotes what the caller asked for, not the rewritten argv.
    assert.equal(result.command[0], join(binDir, "argv-echo.cmd"));
  });

  it("reports an unlaunchable shim as 127 without spawning anything", async () => {
    const { root, cmd } = shimmedProject();
    rmSync(join(root, "node_modules", "typescript"), { recursive: true, force: true });
    const result = await runCommand("tsc", [cmd, "--noEmit"], root, { platform: "win32" });

    assert.equal(result.returncode, 127);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /cannot launch/);
    assert.deepEqual(result.command, [cmd, "--noEmit"]);
  });

  it("rejects an empty command rather than spawning something arbitrary", () => {
    assert.throws(() => runCommand("empty", [], tmpdir()), TypeError);
  });
});
