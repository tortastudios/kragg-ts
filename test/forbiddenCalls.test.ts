/**
 * Tests for the forbidden-calls gate.
 *
 * These are written to BREAK the gate, not to demonstrate it. The Python
 * sibling shipped eight bugs that adversarial review found afterwards — all of
 * them either a false positive from a name that merely looked right, or a
 * recall gap where a real call went unseen — so the cases below are weighted
 * toward the two failure modes that matter:
 *
 *  - MUST NOT MATCH: a shadowing local, a same-named method on an unrelated
 *    type, a same-named property on a first-party object, a banned prefix that
 *    is not a whole path segment, an import that does not resolve at all.
 *  - MUST MATCH: every spelling of the same API — `node:` and bare, aliased,
 *    re-exported, inherited, reached through a namespace, a default import, a
 *    tagged template, `new`, an optional call, `this.`.
 *
 * Everything runs against ONE fixture project and ONE `ts.Program`, with each
 * test narrowed to its own source file via `paths`. That keeps the suite fast
 * (a program build is seconds, not milliseconds) and it exercises the
 * `--changed` narrowing on every single test rather than in one lonely case.
 *
 * The fixture is hermetic: its own ambient `declare module` blocks stand in for
 * `@types/node`, and its own `node_modules` packages stand in for real
 * dependencies. No test depends on what any installed package happens to
 * declare today.
 *
 * These tests import `typescript` directly, which production gate code must NOT
 * do (see `resolveTypeScript`): here it is the compiler under test, passed in
 * explicitly so the shared handle cache stays clean.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import ts from "typescript";

import { analysisProgram, type AnalysisProgram } from "../src/analysis/program.ts";
import type { Violation } from "../src/engine/models.ts";
import {
  checkForbiddenCalls,
  DEFAULT_FIX_HINT,
  FORBIDDEN_CALL_CODE,
  type ForbiddenCallsOutcome,
} from "../src/gates/forbiddenCalls.ts";
import type { ForbiddenCall } from "../src/policy/policy.ts";

const temporaryRoots: string[] = [];

after(() => {
  for (const root of temporaryRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

function project(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "kragg-forbidden-"));
  temporaryRoots.push(root);
  for (const [name, contents] of Object.entries(files)) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, contents);
  }
  return root;
}

const TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "es2023",
    lib: ["es2023"],
    module: "preserve",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
    strict: true,
    // The fixture declares its own ambient modules; pulling in whatever
    // `@types/*` happens to be installed would make these tests depend on it.
    types: [],
    skipLibCheck: true,
  },
  include: ["src/**/*.ts", "types/**/*.d.ts"],
});

function packageFiles(
  name: string,
  declarations: string,
): Readonly<Record<string, string>> {
  return {
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      version: "1.0.0",
      types: "index.d.ts",
    }),
    [`node_modules/${name}/index.d.ts`]: declarations,
  };
}

/**
 * The fixture. Line numbers are asserted on, so adding a line to any source
 * below means updating the test that reads it.
 */
const FIXTURE: Readonly<Record<string, string>> = {
  "tsconfig.json": TSCONFIG,

  // Stands in for @types/node: the two-spelling shape (`fs` plus a
  // `node:fs` that re-exports it) is exactly how @types/node declares builtins.
  "types/ambient.d.ts": [
    'declare module "child_process" {',
    "  export function exec(command: string): void;",
    "  export function spawn(command: string): void;",
    "}",
    'declare module "node:child_process" {',
    '  export * from "child_process";',
    "}",
    'declare module "fs" {',
    "  export function readFileSync(path: string): string;",
    "}",
    'declare module "node:fs" {',
    '  export * from "fs";',
    "}",
    "",
  ].join("\n"),

  ...packageFiles(
    "starlette",
    [
      "export declare class Request {",
      "  body(): Promise<string>;",
      "  url(): string;",
      "}",
      "",
    ].join("\n"),
  ),
  // A barrel re-export, the shape Python cannot see through.
  ...packageFiles("fastapi", 'export { Request } from "starlette";\n'),
  ...packageFiles(
    "legacy",
    ["declare function shell(command: string): void;", "export default shell;", ""].join("\n"),
  ),
  ...packageFiles(
    "sqltag",
    ["export declare function sql(parts: TemplateStringsArray): string;", ""].join("\n"),
  ),
  ...packageFiles("@scope/pkg", "export declare function danger(): void;\n"),

  "src/builtins.ts": [
    'import { exec } from "node:child_process";', // 1
    'import { spawn } from "child_process";', // 2
    'import * as cp from "node:child_process";', // 3
    'import { readFileSync } from "node:fs";', // 4
    "", // 5
    "export function run(): void {", // 6
    '  exec("ls");', // 7
    '  spawn("ls");', // 8
    '  cp.exec("ls");', // 9
    '  cp.exec?.("ls");', // 10
    '  readFileSync("/tmp/x");', // 11
    "}", // 12
    "",
  ].join("\n"),

  "src/shadow.ts": [
    'import { exec } from "node:child_process";', // 1
    "", // 2
    "export function shadowed(): string {", // 3
    "  const exec = (command: string): string => command;", // 4
    '  return exec("ls");', // 5
    "}", // 6
    "", // 7
    "export function real(): void {", // 8
    '  exec("ls");', // 9
    "}", // 10
    "",
  ].join("\n"),

  "src/lookalike.ts": [
    "export class Logger {", // 1
    "  exec(command: string): string {", // 2
    "    return command;", // 3
    "  }", // 4
    "}", // 5
    "", // 6
    "export const tools = {", // 7
    "  exec(command: string): string {", // 8
    "    return command;", // 9
    "  },", // 10
    "};", // 11
    "", // 12
    "export function use(logger: Logger): void {", // 13
    '  logger.exec("ls");', // 14
    '  tools.exec("ls");', // 15
    "}", // 16
    "",
  ].join("\n"),

  "src/receivers.ts": [
    'import { Request } from "starlette";', // 1
    "", // 2
    "export async function annotated(request: Request): Promise<string> {", // 3
    "  return await request.body();", // 4
    "}", // 5
    "", // 6
    "export function make(): Request {", // 7
    "  return new Request();", // 8
    "}", // 9
    "", // 10
    "export async function chained(): Promise<string> {", // 11
    "  return await make().body();", // 12
    "}", // 13
    "", // 14
    "export async function optional(request?: Request): Promise<string | undefined> {", // 15
    "  return await request?.body();", // 16
    "}", // 17
    "", // 18
    "export function untouched(request: Request): string {", // 19
    "  return request.url();", // 20
    "}", // 21
    "",
  ].join("\n"),

  "src/reexport.ts": [
    'import { Request } from "fastapi";', // 1
    "", // 2
    "export async function handle(request: Request): Promise<string> {", // 3
    "  return await request.body();", // 4
    "}", // 5
    "", // 6
    "export function build(): Request {", // 7
    "  return new Request();", // 8
    "}", // 9
    "",
  ].join("\n"),

  "src/inherit.ts": [
    'import { Request } from "starlette";', // 1
    "", // 2
    "export class MyRequest extends Request {", // 3
    "  override async body(): Promise<string> {", // 4
    '    return "";', // 5
    "  }", // 6
    "", // 7
    "  async viaThis(): Promise<string> {", // 8
    "    return this.body();", // 9
    "  }", // 10
    "}", // 11
    "", // 12
    "export async function use(): Promise<string> {", // 13
    "  return await new MyRequest().body();", // 14
    "}", // 15
    "",
  ].join("\n"),

  "src/interface.ts": [
    "export interface Runner {", // 1
    "  execute(command: string): string;", // 2
    "}", // 3
    "", // 4
    "export class LocalRunner implements Runner {", // 5
    "  execute(command: string): string {", // 6
    "    return command;", // 7
    "  }", // 8
    "}", // 9
    "", // 10
    "export function use(runner: LocalRunner): string {", // 11
    '  return runner.execute("ls");', // 12
    "}", // 13
    "",
  ].join("\n"),

  "src/globals.ts": [
    "export function run(): unknown {", // 1
    '  return eval("1 + 1");', // 2
    "}", // 3
    "",
  ].join("\n"),

  "src/scoped.ts": [
    'import { danger } from "@scope/pkg";', // 1
    "", // 2
    "export function run(): void {", // 3
    "  danger();", // 4
    "}", // 5
    "",
  ].join("\n"),

  "src/tagged.ts": [
    'import { sql } from "sqltag";', // 1
    "", // 2
    "export const query = sql`select 1`;", // 3
    "",
  ].join("\n"),

  "src/defaults.ts": [
    'import shell from "legacy";', // 1
    "", // 2
    "export function run(): void {", // 3
    '  shell("ls");', // 4
    "}", // 5
    "",
  ].join("\n"),

  "src/aliased.ts": [
    'import { exec as runIt } from "node:child_process";', // 1
    "", // 2
    "export function run(): void {", // 3
    '  runIt("ls");', // 4
    "}", // 5
    "",
  ].join("\n"),

  "src/dynamic.ts": [
    "export async function run(): Promise<void> {", // 1
    '  const cp = await import("node:child_process");', // 2
    '  cp.exec("ls");', // 3
    "}", // 4
    "",
  ].join("\n"),

  "src/unresolvable.ts": [
    "declare const untyped: any;", // 1
    "", // 2
    "export function run(): void {", // 3
    '  untyped.exec("ls");', // 4
    "  untyped.anything.at.all();", // 5
    "}", // 6
    "", // 7
    "export function structural(): void {", // 8
    "  const make = (): { exec: (command: string) => void } => untyped;", // 9
    '  make().exec("ls");', // 10
    "}", // 11
    "",
  ].join("\n"),

  "src/missing.ts": [
    'import { exec } from "not-a-real-package";', // 1
    "", // 2
    "export function run(): void {", // 3
    '  exec("ls");', // 4
    "}", // 5
    "",
  ].join("\n"),

  "src/suppressed.ts": [
    'import { exec } from "node:child_process";', // 1
    "", // 2
    "export function wrapper(command: string): void {", // 3
    "  exec(command); // kragg: ignore", // 4
    "}", // 5
    "", // 6
    "export function unguarded(command: string): void {", // 7
    "  exec(command);", // 8
    "}", // 9
    "", // 10
    "export function spanning(command: string): void {", // 11
    "  exec( // kragg: ignore", // 12
    "    command,", // 13
    "  );", // 14
    "}", // 15
    "",
  ].join("\n"),

  "src/services/runner.ts": [
    "export function runCommand(command: string): string {", // 1
    "  return command;", // 2
    "}", // 3
    "",
  ].join("\n"),

  "src/firstparty.ts": [
    'import { runCommand } from "./services/runner.ts";', // 1
    "", // 2
    "export function run(): string {", // 3
    '  return runCommand("ls");', // 4
    "}", // 5
    "",
  ].join("\n"),
};

let shared: AnalysisProgram | null = null;

function handle(): AnalysisProgram {
  shared ??= analysisProgram({ root: project(FIXTURE), api: ts });
  return shared;
}

function expectOk(outcome: ForbiddenCallsOutcome): readonly Violation[] {
  if (!outcome.ok) {
    assert.fail(`the gate should have run: ${outcome.message}`);
  }
  return outcome.violations;
}

/** Run the gate over one fixture file with one rule set. */
function scan(file: string, ...forbidden: readonly ForbiddenCall[]): readonly Violation[] {
  return expectOk(
    checkForbiddenCalls({ program: handle(), forbidden, paths: [`src/${file}`] }),
  );
}

/** `line: message` for compact, order-sensitive assertions. */
function summary(violations: readonly Violation[]): readonly string[] {
  return violations.map((violation) => `${String(violation.line)}: ${violation.message}`);
}

const BAN_EXEC: ForbiddenCall = ["node:child_process.exec", "use src/services/runner.ts"];
const BAN_BODY: ForbiddenCall = ["starlette.Request.body", "use readLimitedBody"];

describe("forbidden calls: builtin modules", () => {
  it("matches `node:` and bare spellings interchangeably", () => {
    // `node:child_process.exec` and `child_process.exec` are the same API and
    // must be the same ban, whichever way either side spells it.
    const viaPrefixed = scan("builtins.ts", BAN_EXEC);
    const viaBare = scan("builtins.ts", ["child_process.exec", "hint"]);
    assert.deepEqual(
      viaPrefixed.map((violation) => violation.line),
      [7, 9, 10],
    );
    assert.deepEqual(
      viaBare.map((violation) => violation.line),
      [7, 9, 10],
    );
  });

  it("bans everything beneath a module entry", () => {
    const violations = scan("builtins.ts", ["child_process", ""]);
    assert.deepEqual(
      violations.map((violation) => violation.line),
      [7, 8, 9, 10],
      "exec and spawn, through the import, the alias and the namespace",
    );
    assert.equal(violations[0]?.fixHint, DEFAULT_FIX_HINT);
    assert.equal(violations[0]?.code, FORBIDDEN_CALL_CODE);
  });

  it("resolves a namespace import and an optional call", () => {
    const lines = scan("builtins.ts", BAN_EXEC).map((violation) => violation.line);
    assert.ok(lines.includes(9), "cp.exec() through `import * as cp`");
    assert.ok(lines.includes(10), "cp.exec?.() optional call");
  });

  it("does not match a prefix that is not a whole path segment", () => {
    // The classic off-by-one in prefix matching: `child_proces` must not ban
    // `child_process.exec`, and `child_process.exe` must not ban `.exec`.
    assert.deepEqual(scan("builtins.ts", ["child_proces", ""]), []);
    assert.deepEqual(scan("builtins.ts", ["child_process.exe", ""]), []);
    assert.deepEqual(scan("builtins.ts", ["exec", ""]), [], "a suffix is not a path");
  });

  it("matches paths case-sensitively", () => {
    assert.deepEqual(scan("builtins.ts", ["Child_Process.exec", ""]), []);
    assert.deepEqual(scan("builtins.ts", ["child_process.Exec", ""]), []);
  });

  it("reports a file-relative path, a line and a column", () => {
    const first = scan("builtins.ts", BAN_EXEC)[0];
    assert.equal(first?.file, "src/builtins.ts");
    assert.equal(first?.line, 7);
    assert.equal(first?.column, 3);
  });

  it("carries the configured hint, and names the entry when it differs", () => {
    const violations = scan("builtins.ts", BAN_EXEC);
    assert.equal(violations[0]?.fixHint, "use src/services/runner.ts");
    assert.equal(
      violations[0]?.message,
      "forbidden call `child_process.exec`",
      "the entry canonicalizes to the resolved path, so there is no `(banned:)` suffix",
    );
    const beneath = scan("builtins.ts", ["child_process", ""]);
    assert.equal(
      beneath[0]?.message,
      "forbidden call `child_process.exec` (banned: `child_process`)",
    );
  });
});

describe("forbidden calls: names that must NOT match", () => {
  it("ignores a local that shadows a banned import", () => {
    // The whole point of resolving on the checker: a local `const exec` is a
    // different symbol, and a name-based gate cannot tell.
    assert.deepEqual(summary(scan("shadow.ts", BAN_EXEC)), [
      "9: forbidden call `child_process.exec`",
    ]);
  });

  it("ignores a same-named method on an unrelated class and object", () => {
    assert.deepEqual(scan("lookalike.ts", BAN_EXEC), []);
  });

  it("still bans that same method when the project names it directly", () => {
    // The flip side: first-party paths are `<module>.<container>.<member>`
    // with `/` inside the module part, and they really are bannable.
    assert.deepEqual(summary(scan("lookalike.ts", ["src/lookalike.Logger.exec", ""])), [
      "14: forbidden call `src/lookalike.Logger.exec`",
    ]);
    assert.deepEqual(summary(scan("lookalike.ts", ["src/lookalike.tools.exec", ""])), [
      "15: forbidden call `src/lookalike.tools.exec`",
    ]);
  });

  it("skips a receiver the checker cannot resolve, silently", () => {
    // `any` defeats the gate, exactly as it defeats Python's. Skipping is the
    // contract; the extra rules are every path the gate could have INVENTED
    // for these three call sites — a member of an `any`, and a member of an
    // anonymous return type. None of them may fire.
    assert.deepEqual(
      scan(
        "unresolvable.ts",
        BAN_EXEC,
        ["src/unresolvable.exec", ""],
        ["src/unresolvable.untyped", ""],
        ["src/unresolvable.make.exec", ""],
      ),
      [],
    );
  });

  it("skips an import that does not resolve at all", () => {
    // An unresolved import must not be reported under the IMPORTING module's
    // path, which would collide with a first-party ban.
    assert.deepEqual(scan("missing.ts", BAN_EXEC, ["src/missing.exec", ""]), []);
  });

  it("leaves an unbanned sibling method alone", () => {
    assert.deepEqual(
      scan("receivers.ts", BAN_BODY).map((violation) => violation.line),
      [4, 12, 16],
      "request.url() on line 20 is not banned",
    );
  });
});

describe("forbidden calls: receivers", () => {
  it("resolves an annotated parameter, an inferred receiver and an optional chain", () => {
    // The motivating case from the Python docstring — `await request.body()`
    // on a typed parameter — plus two shapes Python skips outright.
    assert.deepEqual(summary(scan("receivers.ts", BAN_BODY)), [
      "4: forbidden call `starlette.Request.body`",
      "12: forbidden call `starlette.Request.body`",
      "16: forbidden call `starlette.Request.body`",
    ]);
  });

  it("bans construction and every method through one class entry", () => {
    assert.deepEqual(
      scan("receivers.ts", ["starlette.Request", ""]).map((violation) => violation.line),
      [4, 8, 12, 16, 20],
    );
  });

  it("resolves `this.method()`, which Python refuses to guess at", () => {
    const lines = scan("inherit.ts", BAN_BODY).map((violation) => violation.line);
    assert.ok(lines.includes(9), "this.body() inside the subclass");
  });
});

describe("forbidden calls: divergences from Python", () => {
  it("sees through a re-export to the original declaration", () => {
    // Python: "banning the starlette path does not ban `fastapi.Request.body`
    // — list every path the project imports." Here it does.
    assert.deepEqual(summary(scan("reexport.ts", BAN_BODY)), [
      "4: forbidden call `starlette.Request.body`",
    ]);
  });

  it("also matches the re-exported spelling when the callee IS the alias", () => {
    // `new Request()` names the alias directly, so the intermediate
    // `fastapi.Request` spelling is on the alias chain and is bannable.
    assert.deepEqual(summary(scan("reexport.ts", ["fastapi.Request", "hint"])), [
      "8: forbidden call `starlette.Request` (banned: `fastapi.Request`)",
    ]);
  });

  it("does NOT match the re-exported spelling of a member reached by type", () => {
    // The honest limit of the divergence above. `request.body()` resolves
    // through the RECEIVER'S TYPE, whose symbol is starlette's class — the
    // `fastapi` spelling never appears on that symbol's alias chain, so only
    // the original path bans it. Still strictly better than Python, which
    // matches neither spelling here.
    assert.deepEqual(scan("reexport.ts", ["fastapi.Request.body", "hint"]), []);
  });

  it("reports one violation per call site even when several spellings match", () => {
    const violations = scan(
      "reexport.ts",
      ["fastapi.Request", "a"],
      ["starlette.Request.body", "b"],
      ["starlette", "c"],
    );
    assert.deepEqual(
      violations.map((violation) => violation.line),
      [4, 8],
    );
  });

  it("matches an overriding method through its heritage clause", () => {
    // Python: "banning starlette.requests.Request.body does not ban a
    // MyRequest subclass". Here the override and the call on the subclass are
    // both caught, reported under the subclass's own path.
    assert.deepEqual(summary(scan("inherit.ts", BAN_BODY)), [
      "9: forbidden call `src/inherit.MyRequest.body` (banned: `starlette.Request.body`)",
      "14: forbidden call `src/inherit.MyRequest.body` (banned: `starlette.Request.body`)",
    ]);
  });

  it("matches an implementation through an `implements` clause", () => {
    assert.deepEqual(summary(scan("interface.ts", ["src/interface.Runner.execute", ""])), [
      "12: forbidden call `src/interface.LocalRunner.execute` (banned: `src/interface.Runner.execute`)",
    ]);
  });
});

describe("forbidden calls: call shapes", () => {
  it("resolves an aliased import", () => {
    assert.deepEqual(summary(scan("aliased.ts", BAN_EXEC)), [
      "4: forbidden call `child_process.exec`",
    ]);
  });

  it("resolves a default import", () => {
    assert.deepEqual(summary(scan("defaults.ts", ["legacy.shell", ""])), [
      "4: forbidden call `legacy.shell`",
    ]);
  });

  it("resolves a tagged template", () => {
    assert.deepEqual(summary(scan("tagged.ts", ["sqltag.sql", ""])), [
      "3: forbidden call `sqltag.sql`",
    ]);
  });

  it("resolves a scoped package, keeping both name segments", () => {
    assert.deepEqual(summary(scan("scoped.ts", ["@scope/pkg.danger", ""])), [
      "4: forbidden call `@scope/pkg.danger`",
    ]);
    assert.deepEqual(summary(scan("scoped.ts", ["@scope/pkg", ""])), [
      "4: forbidden call `@scope/pkg.danger` (banned: `@scope/pkg`)",
    ]);
  });

  it("resolves a call on an awaited dynamic import", () => {
    assert.deepEqual(summary(scan("dynamic.ts", BAN_EXEC)), [
      "3: forbidden call `child_process.exec`",
    ]);
  });

  it("resolves a first-party module, with `/` inside the module part", () => {
    assert.deepEqual(summary(scan("firstparty.ts", ["src/services/runner.runCommand", ""])), [
      "4: forbidden call `src/services/runner.runCommand`",
    ]);
  });

  it("bans a global under either spelling", () => {
    assert.deepEqual(summary(scan("globals.ts", ["globalThis.eval", ""])), [
      "2: forbidden call `globalThis.eval`",
    ]);
    assert.deepEqual(summary(scan("globals.ts", ["eval", ""])), [
      "2: forbidden call `globalThis.eval` (banned: `eval`)",
    ]);
  });
});

describe("forbidden calls: suppression", () => {
  it("honours a trailing marker, and only on the site that carries it", () => {
    // The approved wrapper's own call site is the one legitimate use. The
    // exemption is per-site and visible in the diff — there is no file switch.
    assert.deepEqual(summary(scan("suppressed.ts", BAN_EXEC)), [
      "8: forbidden call `child_process.exec`",
    ]);
  });
});

describe("forbidden calls: rules and ordering", () => {
  it("applies the most specific entry when several match", () => {
    const violations = scan(
      "receivers.ts",
      ["starlette", "broad"],
      ["starlette.Request.body", "narrow"],
    );
    const body = violations.find((violation) => violation.line === 4);
    const construction = violations.find((violation) => violation.line === 8);
    assert.equal(body?.fixHint, "narrow");
    assert.equal(construction?.fixHint, "broad");
  });

  it("keeps the ban when the hint is empty, falling back to the default", () => {
    assert.equal(scan("builtins.ts", ["child_process.exec", ""])[0]?.fixHint, DEFAULT_FIX_HINT);
  });

  it("keeps a real hint when the same path is banned twice, once without one", () => {
    // Fail closed: two spellings of one API collapse to one ban, and the ban
    // must not lose its advice to whichever entry sorted first.
    const violations = scan(
      "builtins.ts",
      ["child_process.exec", ""],
      ["node:child_process.exec", "use the wrapper"],
    );
    assert.equal(violations[0]?.fixHint, "use the wrapper");
  });

  it("ignores an empty entry instead of banning everything", () => {
    // `policy.ts` fails closed by keeping every configured key, blank ones
    // included. A blank key names nothing, and must not become a ban on the
    // whole program.
    assert.deepEqual(scan("builtins.ts", ["", "hint"], ["   ", "hint"]), []);
  });

  it("trims whitespace around an entry rather than silently not banning", () => {
    assert.equal(scan("builtins.ts", ["  child_process.exec  ", ""]).length, 3);
  });

  it("sorts violations by line within a file", () => {
    const lines = scan("builtins.ts", ["child_process", ""]).map((violation) => violation.line);
    assert.deepEqual([...lines].sort((a, b) => (a ?? 0) - (b ?? 0)), lines);
  });
});

describe("forbidden calls: gate mechanics", () => {
  it("never builds a program when nothing is banned", () => {
    // The laziness contract in `analysis/program.ts`: an unconfigured gate
    // must not cost a single millisecond of program construction.
    const program = analysisProgram({ root: project(FIXTURE), api: ts });
    const outcome = checkForbiddenCalls({ program, forbidden: [] });
    assert.deepEqual(expectOk(outcome), []);
    assert.equal(program.loaded(), false);
  });

  it("scans the whole project when no paths are given", () => {
    const violations = expectOk(
      checkForbiddenCalls({ program: handle(), forbidden: [BAN_EXEC] }),
    );
    const files = new Set(violations.map((violation) => violation.file));
    assert.ok(files.has("src/builtins.ts"));
    assert.ok(files.has("src/aliased.ts"));
    assert.ok(files.has("src/dynamic.ts"));
    assert.ok(!files.has("src/lookalike.ts"));
  });

  it("ignores paths outside the program's own sources", () => {
    const violations = expectOk(
      checkForbiddenCalls({
        program: handle(),
        forbidden: [BAN_EXEC],
        paths: ["README.md", "src/deleted.ts", "types/ambient.d.ts"],
      }),
    );
    assert.deepEqual(violations, []);
  });

  it("reports an unusable program instead of passing green", () => {
    // Never report a passing gate that did not run.
    const root = project({ "src/a.ts": "export const a = 1;\n" });
    const outcome = checkForbiddenCalls({
      program: analysisProgram({ root, api: ts }),
      forbidden: [BAN_EXEC],
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.match(outcome.message, /no tsconfig\.json at/);
    }
  });
});
