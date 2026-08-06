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
 *  1. ONE program per run. A handle is memoized per tsconfig, so a gate that
 *     asks for the program twice — or two gates that each ask once — get the
 *     same instance and the same checker.
 *  2. LAZY. Construction happens on the first `load()`, never at handle
 *     creation. A `kragg check --changed` run over three files where no
 *     type-aware gate fires must not pay a millisecond of program cost.
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
 * Handles keyed by tsconfig path — the guarantee behind "one program per run".
 *
 * Sharing through this cache rather than through a context object means an
 * accidentally re-created gate context cannot quietly double the cost of a
 * run. The handle is what is cached, not the program, so the laziness
 * survives sharing: a memoized handle nobody loads still costs nothing.
 */
const handleCache = new Map<string, AnalysisProgram>();

/**
 * Get the shared analysis handle for a project.
 *
 * Memoized on the resolved tsconfig path. An explicit `api` bypasses the
 * cache in both directions — it neither reads nor populates it — because two
 * callers asking for the same project with different compilers must not be
 * handed each other's program, and a test compiler must not leak into a
 * later production lookup.
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
  const cached = handleCache.get(tsconfigPath);
  if (cached !== undefined) {
    return cached;
  }
  const handle = createHandle(root, tsconfigPath, resolveTypeScript(root));
  handleCache.set(tsconfigPath, handle);
  return handle;
}

/**
 * Drop every cached handle, and with it every cached program.
 *
 * For tests and for a long-lived process (a watcher, an MCP server) that must
 * not serve results from a program built before the files changed. A single
 * CLI run never needs it.
 */
export function clearAnalysisProgramCache(): void {
  handleCache.clear();
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
