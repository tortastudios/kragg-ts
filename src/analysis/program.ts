/**
 * Program tier: ONE `ts.Program`, one type checker, shared by every
 * type-aware gate.
 *
 * THIS IS THE PERFORMANCE CONTRACT OF THE WHOLE TOOL. In the Python sibling,
 * `ast.parse` is free, so twelve gates each doing their own walk costs
 * nothing and `gates/sources.py` shares the walk purely for consistency. In
 * TypeScript the equivalent is not free: `ts.createProgram` reads the whole
 * transitive file graph, every `lib.*.d.ts`, and every `.d.ts` in
 * `node_modules` that the project touches, and it builds a type checker. On a
 * real repo that is SECONDS. Twelve gates each creating their own program is
 * not a slow tool, it is an unusable one.
 *
 * Two rules follow, and they are structural, not an optimization to add
 * later:
 *
 *  1. ONE program per run. The run's context (`catalog/context.ts`) creates
 *     ONE handle and hands it to every gate, so a gate that asks for the
 *     program twice — or two gates that each ask once — get the same instance
 *     and the same checker.
 *  2. LAZY. Construction happens on the first `load()`, never at handle
 *     creation. A `kragg check --changed` run over three files where no
 *     type-aware gate fires must not pay a millisecond of program cost.
 *
 * THE SHARING IS PER RUN, NOT PER PROCESS. This module used to memoize handles
 * in a module-level map keyed by tsconfig path, and that was a correctness bug
 * as soon as anything outran a single CLI invocation: a long-lived process
 * using the library API (`runCommand`, a watcher, an MCP server) that ran,
 * edited files and ran again was handed the FIRST run's `ts.Program`, whose
 * source files were parsed before the edit. It reported on code that no longer
 * existed and said nothing — the same failure shape as a stale criticality
 * cache, one tier down. There is no process-global handle any more; the owner
 * of a handle is whoever created it, and that is the run.
 *
 * Gates that need no type information must NOT come here at all — they use
 * the syntax tier in `sourceFile.ts`.
 *
 * COMPILER IDENTITY. The program is built with the compiler
 * `resolveTypeScript` picked for the project, which may not be the one kragg
 * bundles. Every node and every type this module hands out belongs to THAT
 * compiler. Inspect them with `handle.compiler.api.*`, never with a
 * `typescript` import of your own — `SyntaxKind` numbering and flag bitmasks
 * are not stable across compiler versions, so a bundled-compiler predicate
 * applied to a project-compiler node is silently, confidently wrong. The full
 * argument is in `resolveTypeScript`'s doc comment; read it once.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import type bundledTs from "typescript";

import {
  absolutePath,
  resolveTypeScript,
  type CompilerResolution,
  type TypeScriptApi,
} from "./sourceFile.ts";

/**
 * The outcome of building the program.
 *
 * A discriminated union rather than a throw, on purpose. Every caller is a
 * gate that has to turn "I could not run" into a `GateResult` with
 * `error: true` (exit code 3) and a copy-pasteable fix — the same shape
 * `environment/project.ts` produces for a missing binary. An exception would
 * make the normal path the one that needs a try/catch, and the tempting
 * wrong fix would be to swallow it and report a pass.
 *
 * The checker travels inside the `ok` variant so it is impossible to hold a
 * checker without the program that owns it.
 */
export type ProgramLoad =
  | {
      readonly ok: true;
      readonly program: bundledTs.Program;
      readonly checker: bundledTs.TypeChecker;
    }
  | {
      readonly ok: false;
      /** Ready to show a human: what failed, where, and how to fix it. */
      readonly message: string;
    };

/**
 * A lazy, shared handle on the project's type-aware analysis.
 *
 * Cheap to create — creating one touches the filesystem only to resolve the
 * compiler. `load()` is where the cost lives, and its result is cached
 * including the failure case: a broken tsconfig is re-reported, not
 * re-attempted twelve times.
 */
export interface AnalysisProgram {
  readonly root: string;
  readonly tsconfigPath: string;
  /** Which compiler built (or will build) this program, and how we got it. */
  readonly compiler: CompilerResolution;
  /** Build on first call, then return the cached outcome. */
  readonly load: () => ProgramLoad;
  /** Whether `load()` has run. For reporting and for tests that assert laziness. */
  readonly loaded: () => boolean;
}

export interface AnalysisProgramOptions {
  /** Absolute or cwd-relative project root. */
  readonly root: string;
  /** Defaults to `<root>/tsconfig.json`. */
  readonly tsconfigPath?: string | undefined;
  /**
   * Override the compiler. Only for tests and for a caller that has already
   * resolved one; leaving it unset is the correct production behaviour.
   */
  readonly api?: TypeScriptApi | undefined;
}

/**
 * Create an analysis handle for a project.
 *
 * A FRESH HANDLE EVERY TIME, and that is the point. Creating one is cheap —
 * it resolves the compiler and nothing else — so the only thing a cache here
 * would buy is the risk of handing a second run the first run's program. The
 * sharing that matters (one program for all the gates in ONE run) is the
 * run context's job: `catalog/context.ts` creates the handle once and passes
 * it down. See the header for the bug the old module-level cache caused.
 *
 * An explicit `api` is for tests and for a caller that has already resolved a
 * compiler; leaving it unset resolves the project's own.
 */
export function analysisProgram(options: AnalysisProgramOptions): AnalysisProgram {
  const root = resolve(options.root);
  const tsconfigPath = resolve(options.tsconfigPath ?? join(root, "tsconfig.json"));
  if (options.api !== undefined) {
    return createHandle(root, tsconfigPath, {
      api: options.api,
      version: options.api.version,
      source: "bundled",
      path: null,
      note: "compiler supplied by the caller",
    });
  }
  return createHandle(root, tsconfigPath, resolveTypeScript(root));
}

function createHandle(
  root: string,
  tsconfigPath: string,
  compiler: CompilerResolution,
): AnalysisProgram {
  let cached: ProgramLoad | null = null;
  return {
    root,
    tsconfigPath,
    compiler,
    load: (): ProgramLoad => {
      cached ??= buildProgram(root, tsconfigPath, compiler.api);
      return cached;
    },
    loaded: (): boolean => cached !== null,
  };
}

/**
 * Read the tsconfig and construct the program.
 *
 * Failure is reported, never guessed around. We do NOT fall back to a
 * synthesized default config for a project without a tsconfig: the compiler
 * options are what decide whether the project's own code type-checks, so
 * inventing them produces a type-aware verdict about a configuration nobody
 * ships. A missing or unreadable tsconfig is an environment error with a fix.
 */
function buildProgram(
  root: string,
  tsconfigPath: string,
  api: TypeScriptApi,
): ProgramLoad {
  if (!existsSync(tsconfigPath)) {
    return {
      ok: false,
      message:
        `no tsconfig.json at ${tsconfigPath}, so type-aware gates cannot run.\n` +
        `Fix: add a tsconfig.json at the project root, or point kragg at the ` +
        `right one (project root resolved to ${root}).`,
    };
  }

  const read = api.readConfigFile(tsconfigPath, api.sys.readFile);
  if (read.error !== undefined) {
    return {
      ok: false,
      message: `${tsconfigPath} could not be read: ${diagnosticText(api, [read.error])}`,
    };
  }

  const parsed = api.parseJsonConfigFileContent(
    read.config,
    api.sys,
    dirname(tsconfigPath),
    /* existingOptions */ undefined,
    tsconfigPath,
  );
  // `errors` here are config errors (an unknown option, an `extends` that does
  // not exist), not type errors. They make the resulting options untrustworthy,
  // so they are fatal for us even though tsc would soldier on.
  if (parsed.errors.length > 0) {
    return {
      ok: false,
      message: `${tsconfigPath} is not usable: ${diagnosticText(api, parsed.errors)}`,
    };
  }
  if (parsed.fileNames.length === 0) {
    return {
      ok: false,
      message:
        `${tsconfigPath} matches no files, so there is nothing to type-check.\n` +
        `Fix: check its \`include\`/\`files\` patterns.`,
    };
  }

  const program = api.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    configFileParsingDiagnostics: parsed.errors,
    ...(parsed.projectReferences === undefined
      ? {}
      : { projectReferences: parsed.projectReferences }),
  });
  return { ok: true, program, checker: program.getTypeChecker() };
}

function diagnosticText(
  api: TypeScriptApi,
  diagnostics: readonly bundledTs.Diagnostic[],
): string {
  return diagnostics
    .map((diagnostic) => api.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
    .join("\n");
}

/**
 * The project's own source files in the program — the set a gate should
 * report on.
 *
 * A program contains far more than the project: every `lib.*.d.ts` the target
 * pulls in and every `.d.ts` of every dependency it touches. Reporting a
 * violation inside `node_modules` is noise the user cannot act on, and
 * reporting one inside `lib.es2023.d.ts` is a bug report against the
 * compiler. Declaration files are excluded for the same reason — they carry
 * no runtime code. A gate that genuinely wants them (public API surface) can
 * filter `program.getSourceFiles()` itself.
 */
export function programSourceFiles(
  program: bundledTs.Program,
): readonly bundledTs.SourceFile[] {
  return program
    .getSourceFiles()
    .filter((file) => !file.isDeclarationFile && !isVendored(file.fileName));
}

/** The same set as `programSourceFiles`, as paths. */
export function programFileNames(program: bundledTs.Program): readonly string[] {
  return programSourceFiles(program).map((file) => file.fileName);
}

/**
 * Narrow the program to a caller's file list — the `--changed` path.
 *
 * `paths` may be absolute or relative to `root` (git reports relative paths),
 * and may name files the program does not contain: a changed `README.md`, a
 * deleted file, a file excluded by the tsconfig. Those are dropped silently,
 * because "your changed file is not in your tsconfig" is a fact about the
 * project's configuration and not something a gate should fail on.
 *
 * Matching is on normalized absolute paths rather than `program.getSourceFile`
 * alone, since the program stores whatever spelling the config produced and a
 * caller's `./src/a.ts` will not always be that spelling.
 *
 * TODO(case): the comparison is case-sensitive. On a case-insensitive volume
 * (default macOS, Windows) a caller passing `src/A.ts` for a program file
 * `src/a.ts` gets no match and the file is silently skipped. The correct fix
 * is `program.getCompilerOptions()`-aware canonicalization via the host's
 * `useCaseSensitiveFileNames`; doing it by lowercasing everything would break
 * genuinely case-sensitive volumes, which is the worse failure.
 */
export function sourceFilesFor(
  program: bundledTs.Program,
  root: string,
  paths: readonly string[],
): readonly bundledTs.SourceFile[] {
  const byPath = new Map<string, bundledTs.SourceFile>();
  for (const file of program.getSourceFiles()) {
    byPath.set(normalize(file.fileName), file);
  }
  const found: bundledTs.SourceFile[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const key = normalize(absolutePath(root, path));
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const file = byPath.get(key);
    if (file !== undefined) {
      found.push(file);
    }
  }
  return found;
}

/** Compare paths in one spelling: absolute, `/`-separated, no trailing slash. */
function normalize(path: string): string {
  const absolute = resolve(path);
  return sep === "/" ? absolute : absolute.split(sep).join("/");
}

function isVendored(fileName: string): boolean {
  return fileName.includes("/node_modules/") || fileName.includes(`${sep}node_modules${sep}`);
}
