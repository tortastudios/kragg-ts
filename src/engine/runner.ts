/**
 * External command execution wrapper.
 *
 * Ported from `kragg/src/kragg/runner.py`. This module is the ONLY approved
 * place in the codebase to spawn a subprocess; a future `forbidden-calls`
 * gate will ban `child_process` imports everywhere else.
 *
 * SECURITY INVARIANT — do not weaken:
 *   Commands are ALWAYS passed as an argv array and NEVER as a shell string.
 *   `execFile` with `shell: false` does no word-splitting, no glob expansion
 *   and no metacharacter interpretation, so a filename like
 *   `foo; rm -rf ~` is one argument, not two commands. Never switch this to
 *   `exec`/`execSync`, never set `shell: true`, and never build the command
 *   by string concatenation.
 *
 * WINDOWS, and why the invariant survives it: see `launchPlan` below.
 */

import { execFile } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, sep } from "node:path";

import type { CompletedCommand } from "./models.ts";

/**
 * Gate output can be large (a failing type-check over a big project). 1 MiB —
 * Node's default — truncates and rejects; 32 MiB is past any realistic gate
 * while still bounding memory if a tool goes haywire.
 */
const MAX_BUFFER_BYTES = 32 * 1024 * 1024;

/** No single gate may hang the pipeline. 10 minutes is a generous ceiling. */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

export interface RunCommandOptions extends LaunchOptions {
  readonly timeoutMs?: number;
  /**
   * Extra environment variables merged over `process.env`. The parent
   * environment is inherited so tools find their own config; pass explicit
   * overrides here rather than mutating `process.env`.
   */
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/**
 * The two facts `launchPlan` needs about the host, injected rather than read.
 *
 * `process.platform` is deliberately NOT read inside `launchPlan`. The whole
 * Windows branch is unreachable on the machines this project is developed and
 * tested on, and an unreachable branch is an untested branch. Taking the
 * platform as an argument makes the Windows path an ordinary unit test that
 * runs on every host. Production callers omit both fields.
 */
export interface LaunchOptions {
  readonly platform?: NodeJS.Platform;
  /** The Node binary a shim's script is handed to. Defaults to this process. */
  readonly nodePath?: string;
}

/** What `runCommand` should actually hand to `execFile`, or why it cannot. */
export type LaunchPlan =
  | { readonly kind: "spawn"; readonly command: readonly string[] }
  | { readonly kind: "unlaunchable"; readonly reason: string };

/** Batch extensions Node refuses to spawn without a shell. Lowercase. */
const BATCH_EXTENSIONS: readonly string[] = [".cmd", ".bat"];

/** Never mistake a shim's own probe for `node.exe` for the tool's script. */
const NODE_BASENAMES: readonly string[] = ["node", "node.exe"];

/** Shim extensions a target must not have, or we would rewrite in a circle. */
const SHIM_EXTENSIONS: readonly string[] = [".cmd", ".bat", ".ps1"];

/** Shims are a few hundred bytes. Anything larger is not one; stop reading. */
const MAX_SHIM_BYTES = 64 * 1024;

/** Bound the scan of a hostile or malformed file. Real shims name one target. */
const MAX_SHIM_CANDIDATES = 20;

/**
 * The path a `node_modules/.bin` shim points at, relative to the shim.
 *
 * npm, pnpm and yarn all generate the same three files per binary. The `.cmd`
 * resolves its own directory into `%dp0%` (or uses `%~dp0` directly) and the
 * shell/`.ps1` variants use `$basedir`; every one of them then names the real
 * script as a path relative to that. Capturing the relative part — never an
 * absolute path out of the file — is what keeps this from being a way to
 * point kragg at something outside the project.
 */
const SHIM_TARGET = /(?:%~?dp0%?|\$basedir)([\\/][^"'\r\n]*)/g;

/**
 * Turn an argv into something `execFile` can actually spawn on this platform.
 *
 * WHY THIS EXISTS. On Windows a `node_modules/.bin` entry is a `.cmd` batch
 * shim. `execFile` cannot spawn a batch file without a shell — since the
 * CVE-2024-27980 fix Node rejects it outright with `EINVAL` — so without this
 * every external tool kragg drives (tsc, the linter, the test runner, knip,
 * secretlint, stryker) fails to launch on Windows.
 *
 * WHY NOT `cmd.exe /c`, the obvious fix. Handing the shim to `cmd.exe` puts a
 * command-line parser back between kragg and the tool. Inside `cmd`, `&`,
 * `|`, `<`, `>`, `^` and `%VAR%` are live; keeping them inert means
 * hand-writing an escaper for a shell this project does not use, cannot test
 * here, and would be trusting with repository-controlled input — gates pass
 * changed FILENAMES as arguments. That is precisely the injection the
 * SECURITY INVARIANT above forbids, reintroduced on one platform. Rejected.
 *
 * WHAT IT DOES INSTEAD. It reads the shim, recovers the script the shim would
 * have run, and spawns `<node> <script> <args...>` — a plain argv, no shell,
 * no `cmd.exe`, byte-identical argument handling to the POSIX path. Arguments
 * are never inspected, quoted or escaped; only `argv[0]` is replaced.
 *
 * THE TRADE-OFF, stated honestly. The script runs on kragg's own Node
 * (`process.execPath`) rather than one resolved from the project. That is a
 * real difference, and it is the smaller half of the trade for two reasons.
 * First, the invariant `resolveBin` actually defends is *whose tool runs*,
 * and that is untouched: the script still comes from the project's
 * `node_modules`, still containment-checked, still found by the same bounded
 * ancestor walk. Second, `node_modules` ships JavaScript, not a Node runtime
 * — there is no project-owned interpreter to prefer. On POSIX the `.bin`
 * entry's `#!/usr/bin/env node` already resolves Node from the PATH kragg
 * hands down, so "the project's Node" was never a thing kragg had. If
 * anything `process.execPath` is the more deterministic of the two.
 *
 * Everything except Windows batch/extension-less `.bin` entries passes
 * through untouched, so no POSIX behaviour changes.
 */
export function launchPlan(
  command: readonly string[],
  options: LaunchOptions = {},
): LaunchPlan {
  const platform = options.platform ?? process.platform;
  const [file, ...args] = command;
  if (file === undefined || platform !== "win32" || !/[\\/]/.test(file)) {
    // A bare name is left to the OS's own PATH search, as it is everywhere
    // else. Resolving PATH ourselves is the one thing this project refuses
    // to do (see `environment/bin.ts`), and it is not needed here.
    return { kind: "spawn", command };
  }

  const extension = extname(file).toLowerCase();
  const isBatch = BATCH_EXTENSIONS.includes(extension);
  if (!isBatch && extension !== "") {
    return { kind: "spawn", command };
  }

  const script = shimTarget(file);
  if (script !== null) {
    return { kind: "spawn", command: [options.nodePath ?? process.execPath, script, ...args] };
  }
  if (!isBatch) {
    // An extension-less entry that is not a recognisable shim might still be
    // a real executable. Let the OS decide rather than refusing to try.
    return { kind: "spawn", command };
  }
  return { kind: "unlaunchable", reason: unreadableShim(file) };
}

/** The script a `.bin` shim would run, or `null` if we cannot recover one. */
function shimTarget(shim: string): string | null {
  const contents = readShim(shim);
  if (contents === null) {
    return null;
  }
  const dir = dirname(shim);
  // A shim names its target with `..` segments, so the recovered path has to
  // be bounded or a malformed one could point anywhere on the disk. One level
  // above the shim's own directory covers every layout that exists — from
  // `node_modules/.bin` up to `node_modules`, or a global shim up to its
  // install root — and nothing beyond it.
  const boundary = dirname(dir);
  let seen = 0;
  for (const match of contents.matchAll(SHIM_TARGET)) {
    if (++seen > MAX_SHIM_CANDIDATES) {
      return null;
    }
    const relative = match[1];
    if (relative === undefined) {
      continue;
    }
    // Split on BOTH separators and rejoin with the host's own: a `.cmd`
    // written with backslashes has to resolve on a POSIX test host too, and
    // `join` normalises the `..` segments every shim uses.
    const segments = relative.split(/[\\/]+/).filter((segment) => segment !== "");
    const candidate = join(dir, ...segments);
    if (isInside(candidate, boundary) && isShimTarget(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Whether a candidate path is the script the shim exists to run.
 *
 * Rejects the shim's own `IF EXIST "%dp0%\node.exe"` probe — that names the
 * interpreter, not the tool — and rejects anything that is itself a shim, so
 * a malformed file cannot make this resolve in a circle.
 */
/** Containment on already-normalised paths, `sep`-anchored so `/a/bc` is not in `/a/b`. */
function isInside(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

function isShimTarget(candidate: string): boolean {
  if (NODE_BASENAMES.includes(basename(candidate).toLowerCase())) {
    return false;
  }
  if (SHIM_EXTENSIONS.includes(extname(candidate).toLowerCase())) {
    return false;
  }
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function readShim(shim: string): string | null {
  try {
    if (statSync(shim).size > MAX_SHIM_BYTES) {
      return null;
    }
    return readFileSync(shim, "utf8");
  } catch {
    return null;
  }
}

function unreadableShim(shim: string): string {
  return (
    `kragg cannot launch ${shim} on Windows.\n` +
    "It is a batch shim, and a batch file cannot be spawned without a shell " +
    "— which kragg will not use, because a shell would interpret the " +
    "filenames gates pass as arguments. kragg reads the shim and runs the " +
    "script it points at directly, but could not find that script in this " +
    "one.\n" +
    "Reinstalling dependencies usually rewrites the shim correctly."
  );
}

/**
 * Run an external tool and capture its result.
 *
 * Never rejects: a non-zero exit, a missing binary and a timeout are all
 * normal outcomes for a gate and are reported through `returncode`/`stderr`.
 * A gate that cannot distinguish "tool found problems" from "tool is missing"
 * would produce the wrong exit code, so callers must inspect `stderr` (see
 * `environment/project.ts`) rather than relying on a thrown error.
 */
export function runCommand(
  name: string,
  command: readonly string[],
  cwd: string,
  options: RunCommandOptions = {},
): Promise<CompletedCommand> {
  if (command[0] === undefined) {
    throw new TypeError(`runCommand(${name}): command must not be empty`);
  }

  const plan = launchPlan(command, options);
  if (plan.kind === "unlaunchable") {
    // Reported, never thrown, and never silently passed: 127 is the same
    // status this returns for a binary that would not start, so callers that
    // already tell "missing tool" from "tool found problems" keep working.
    return Promise.resolve({
      name,
      command: [...command],
      cwd,
      returncode: 127,
      stdout: "",
      stderr: plan.reason,
    });
  }

  // `command` below is the ORIGINAL argv — what callers asked for and what
  // reports quote. `plan.command` is what the OS is given, and differs only
  // on Windows, and only in argv[0]. See `launchPlan`.
  const [file, ...args] = plan.command;
  if (file === undefined) {
    throw new TypeError(`runCommand(${name}): command must not be empty`);
  }

  return new Promise<CompletedCommand>((resolve) => {
    // THE one sanctioned subprocess call in the codebase. `kragg.json` bans
    // `node:child_process` outright; this is the wrapper that ban points at,
    // so its own call site carries the exemption — visible in review rather
    // than hidden in a config allowlist. `execFile` with `shell: false` is
    // what makes it safe: no word-splitting, no globbing, no interpolation.
    execFile( // kragg: ignore
      file,
      args,
      {
        cwd,
        // Explicit, not defaulted: see the SECURITY INVARIANT above.
        shell: false,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
        ...(options.env === undefined
          ? {}
          : { env: { ...process.env, ...options.env } }),
      },
      (error, stdout, stderr) => {
        resolve({
          name,
          command: [...command],
          cwd,
          returncode: exitCodeOf(error),
          stdout,
          stderr: stderr === "" && error !== null ? String(error.message) : stderr,
        });
      },
    );
  });
}

/**
 * Recover a POSIX-ish exit code from execFile's error.
 *
 * `error.code` is the numeric exit status for a normal non-zero exit, but a
 * string errno (`"ENOENT"`) when the binary is missing and `null` when the
 * process was killed by a signal. Collapsing all of those to a single
 * non-zero sentinel would lose the distinction gates rely on, so failures we
 * cannot attribute to an exit status become 127 — the conventional
 * "command not executable" status.
 */
function exitCodeOf(error: unknown): number {
  if (error === null || error === undefined) {
    return 0;
  }
  if (typeof error === "object" && "code" in error) {
    const code: unknown = (error as { code: unknown }).code;
    if (typeof code === "number") {
      return code;
    }
  }
  return 127;
}
