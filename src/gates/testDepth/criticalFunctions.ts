/**
 * Locate critical functions on disk — the port of `kragg/src/kragg/critical.py`.
 *
 * Reads `.kragg/criticality.json` (written by `kragg criticality --write`) and
 * resolves each critical entry to the source file that defines it. Three gates
 * need this: `test-quality` (is it referenced by a test?), `critical-tests`
 * (did its file change without a test change?) and `critical-coverage` (does it
 * have uncovered lines?).
 *
 * ── NAME PARSING ───────────────────────────────────────────────────────────
 * `criticality.ts` writes nodes as `"<module>#<qualified.name>"` —
 * `src/gates/criticality#buildCallGraph`, `src/engine/gate#Pipeline.run`. The
 * module part is a repo-relative, extension-stripped path, so resolving it to a
 * file is a lookup in the map `moduleName()` builds over the source paths, not
 * Python's longest-dotted-prefix search. A name with no `#` — which is what the
 * PYTHON tool writes, in a polyglot repo where both siblings share the file —
 * resolves to no module and is dropped rather than mis-attributed.
 *
 * ── WHAT COUNTS AS PUBLIC ──────────────────────────────────────────────────
 * Python's rule is "no dotted part starts with `_`", because in Python the
 * underscore IS the visibility marker. TypeScript's marker is the `export`
 * keyword, so a name-shape rule alone gets this badly wrong — and measurably
 * so: run against this repo, treating every non-underscored name as public
 * flagged 41 `critical-untested` violations, of which nearly all were
 * module-private helpers (`toPosix`, `isObject`, `asString`) that no test can
 * reference because no test can import them. A gate that noisy gets switched
 * off, so the rule reads the source instead of guessing from the name:
 *
 *  - the FIRST qualified segment must be EXPORTED from its module. That is the
 *    binding a test can reach: `Client` for `Client.send`, `gate` for
 *    `gate.run`, the function itself for a free function;
 *  - no qualified segment may start with `_` (the ported convention, still
 *    used in TypeScript for "internal but exported") or with `#` (a real
 *    ECMAScript private field, which `criticality.ts` records with its `#`);
 *  - no MODULE segment may start with `_`, matching Python's treatment of
 *    `pkg._internal.fn`.
 *
 * ── DECLARED CRITICAL FUNCTIONS ────────────────────────────────────────────
 * A `critical_functions` entry in the policy makes a function critical that
 * the call graph did not select, and it arrives here as an ordinary
 * `is_critical` record — `readJson` applies the declarations, so nothing in
 * this module has a special case for them beyond carrying the REASON, which
 * lives in the policy and not in the file. They are then subject to the same
 * public-surface rule as every other critical function: a declared function
 * that its module does not export is still skipped, because the gates that
 * consume this list reason about what a test can address, and a reviewer who
 * needs a private function gated should export it or declare the exported
 * function that reaches it.
 *
 * REMAINING GAP, stated plainly: a `private method()` on an exported class is
 * indistinguishable from a public one here, because `criticality.json` records
 * only names and the TypeScript `private` keyword leaves no trace in one.
 * Such a method is treated as public and gated. The `#field` form is caught;
 * the keyword form is not.
 */

import type bundledTs from "typescript";

import {
  parsedSources,
  resolveTypeScript,
  type TypeScriptApi,
} from "../../analysis/sourceFile.ts";
import { declaredCritical, readJson, staleDeclarationMessage } from "../criticality.ts";

/** Separator between the module and the qualified name in a node name. */
export const QUALIFIER = "#";

/** A critical function resolved to the file that defines it. */
export interface CriticalFunction {
  /** The full node name as written in `criticality.json`. */
  readonly qualname: string;
  /** The module part: repo-relative and extension-stripped. */
  readonly module: string;
  /** Repo-relative POSIX path of the defining file. */
  readonly file: string;
  /** The last qualified segment — what a coverage report and a test call it. */
  readonly name: string;
  readonly fanIn: number;
  /**
   * Why a reviewer declared this function critical, when one did.
   *
   * Present only for a `critical_functions` entry, and read from the POLICY
   * rather than from `criticality.json` — that file's record shape is a
   * cross-language contract and carries no reason. The gates quote it when
   * they name the function, so a violation about a one-caller function says
   * what made it worth gating instead of looking like a false positive.
   */
  readonly declaredReason?: string;
}

export interface CriticalFunctionOptions {
  /**
   * Include private critical functions. Off by default, matching Python: the
   * gates that consume this reason about the surface a test can address.
   */
  readonly includePrivate?: boolean | undefined;
  /** Compiler used to walk the source paths. Defaults to the project's. */
  readonly api?: TypeScriptApi | undefined;
}

/** What one module contributes: where it lives, and what it exports. */
export interface ModuleEntry {
  /** Repo-relative POSIX path. */
  readonly file: string;
  /** Top-level names this module exports, as a caller would import them. */
  readonly exports: ReadonlySet<string>;
}

/** One `is_critical` entry, before its file is known. */
interface CriticalEntry {
  readonly qualname: string;
  readonly fanIn: number;
  readonly declaredReason?: string;
}

/**
 * Resolve every critical function to a file, dropping the ones that do not
 * resolve.
 *
 * A dropped entry is one whose module is not under `sourcePaths` — a stale
 * record for a deleted file, a name from the Python sibling, or a function in a
 * directory the policy does not call source. Reporting on it would point a
 * reviewer at a file that is not there.
 */
export function criticalFunctions(
  root: string,
  sourcePaths: readonly string[],
  options: CriticalFunctionOptions = {},
): readonly CriticalFunction[] {
  const entries = criticalEntries(root);
  if (entries.length === 0) {
    return [];
  }
  const includePrivate = options.includePrivate ?? false;
  const modules = moduleIndex(root, sourcePaths, options.api);
  const resolved: CriticalFunction[] = [];
  for (const entry of entries) {
    const module = modulePart(entry.qualname);
    const found = module === null ? undefined : modules.get(module);
    if (module === null || found === undefined) {
      continue;
    }
    if (!includePrivate && !isPublicQualname(entry.qualname, found.exports)) {
      continue;
    }
    resolved.push({
      qualname: entry.qualname,
      module,
      file: found.file,
      name: simpleName(entry.qualname),
      fanIn: entry.fanIn,
      ...(entry.declaredReason === undefined ? {} : { declaredReason: entry.declaredReason }),
    });
  }
  return resolved;
}

/**
 * The reviewed declarations that name nothing in the criticality data, as a
 * message — or `null` when every one of them resolves.
 *
 * THE RENAME CASE, AND WHY IT IS AN ERROR. A `critical_functions` entry is a
 * decision that a specific function needs stronger checks. Rename the function
 * and leave the entry behind, and the entry matches no record: nothing is
 * enforced, and — without this — nothing says so, which is the silent loss of
 * protection the setting exists to prevent. Every gate that consumes the data
 * calls this first and reports `error: true` (exit 3) with the message, rather
 * than reporting a green gate over a shrunken population.
 *
 * The population compared against is the WHOLE sidecar, critical or not: a
 * declared function that the graph did not select is still a node in it, so a
 * name absent from the file really is a name absent from the program. Callers
 * check `hasCriticalityData` first — with no data at all there is nothing to
 * compare against, and the visible skip they already have is the right answer.
 */
export function declarationProblem(root: string): string | null {
  return staleDeclarationMessage(
    declaredCritical(root),
    readJson(root)
      .map((record) => record["name"])
      .filter((name): name is string => typeof name === "string"),
  );
}

/**
 * Whether there is criticality data at all — the visible-skip predicate.
 *
 * Slightly stricter than Python's `catalog._no_criticality_reason`, which
 * tests only that the FILE exists: a file holding `[]`, or one that is
 * unparsable, counts as no data here and makes the gate skip. Both mean the
 * gate has nothing to check, and a skip says so where a pass would not.
 */
export function hasCriticalityData(root: string): boolean {
  return readJson(root).length > 0;
}

/**
 * The last qualified segment of a node name, with an accessor prefix removed.
 *
 * `src/a#Client.send` -> `send`; `src/a#Client.get token` -> `token`, because
 * `criticality.ts` prefixes accessors to keep a getter and a setter distinct
 * and neither a test nor a coverage report ever spells the property that way.
 */
export function simpleName(qualname: string): string {
  const qualified = qualifiedPart(qualname);
  const parts = qualified.split(".");
  const last = parts[parts.length - 1] ?? qualified;
  for (const prefix of ["get ", "set "]) {
    if (last.startsWith(prefix)) {
      return last.slice(prefix.length);
    }
  }
  return last;
}

/** Whether a node name is private by the name-shape rules in the header. */
export function isPrivateQualname(qualname: string): boolean {
  const module = modulePart(qualname);
  const moduleSegments = module === null ? [] : module.split("/");
  const qualifiedSegments = qualifiedPart(qualname).split(".");
  return [...moduleSegments, ...qualifiedSegments].some(
    (segment) => segment.startsWith("_") || segment.startsWith(QUALIFIER),
  );
}

/**
 * Whether a node name is reachable from a test: exported, and not marked
 * internal by either underscore convention.
 */
export function isPublicQualname(
  qualname: string,
  exports: ReadonlySet<string>,
): boolean {
  if (isPrivateQualname(qualname)) {
    return false;
  }
  const first = qualifiedPart(qualname).split(".")[0];
  return first !== undefined && exports.has(first);
}

/** Module name -> its file and exports, over the policy's source paths. */
export function moduleIndex(
  root: string,
  sourcePaths: readonly string[],
  api?: TypeScriptApi | undefined,
): ReadonlyMap<string, ModuleEntry> {
  const modules = new Map<string, ModuleEntry>();
  // Resolved once and passed in, so the predicates in `exportedNames` come
  // from the very compiler that produced the nodes — see `resolveTypeScript`.
  const compiler = api ?? resolveTypeScript(root).api;
  for (const source of parsedSources(root, sourcePaths, { api: compiler })) {
    // First write wins, so a `.ts` and a same-named `.tsx` resolve the way the
    // sorted walk found them rather than by iteration luck.
    if (!modules.has(source.module)) {
      modules.set(source.module, {
        file: source.relative,
        exports: exportedNames(source.sourceFile, compiler),
      });
    }
  }
  return modules;
}

/**
 * The top-level names a module exports.
 *
 * Handles the four spellings that bind a callable at the top level: an
 * `export` modifier on a declaration, `export { a }` and `export { a as b }`
 * (which records the LOCAL name `a`, because that is what `criticality.ts`
 * named the declaration), and `export default`. `export * from` is skipped —
 * it names nothing here, and the names it forwards belong to another module,
 * where they are already indexed.
 */
export function exportedNames(
  sourceFile: bundledTs.SourceFile,
  api: TypeScriptApi,
): ReadonlySet<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (isExported(statement, api)) {
      collectDeclared(statement, api, names);
    } else if (api.isExportDeclaration(statement)) {
      collectExportClause(statement, api, names);
    } else if (api.isExportAssignment(statement)) {
      names.add("default");
    }
  }
  return names;
}

function isExported(node: bundledTs.Node, api: TypeScriptApi): boolean {
  return (api.getCombinedModifierFlags(node as bundledTs.Declaration) &
    api.ModifierFlags.Export) !== 0;
}

function collectDeclared(
  statement: bundledTs.Statement,
  api: TypeScriptApi,
  names: Set<string>,
): void {
  if (api.isFunctionDeclaration(statement) || api.isClassDeclaration(statement)) {
    names.add(statement.name?.text ?? "default");
    return;
  }
  if (api.isModuleDeclaration(statement) || api.isEnumDeclaration(statement)) {
    // `export namespace Ns { ... }` — a container, and the name a critical
    // `mod#Ns.fn` is reached through.
    if (api.isIdentifier(statement.name)) {
      names.add(statement.name.text);
    }
    return;
  }
  if (api.isVariableStatement(statement)) {
    collectVariableNames(statement, api, names);
  }
}

/** Every plainly-named binding in `export const a = …, b = …`. */
function collectVariableNames(
  statement: bundledTs.VariableStatement,
  api: TypeScriptApi,
  names: Set<string>,
): void {
  for (const declaration of statement.declarationList.declarations) {
    if (api.isIdentifier(declaration.name)) {
      names.add(declaration.name.text);
    }
  }
}

function collectExportClause(
  statement: bundledTs.ExportDeclaration,
  api: TypeScriptApi,
  names: Set<string>,
): void {
  const clause = statement.exportClause;
  if (clause === undefined || !api.isNamedExports(clause)) {
    return;
  }
  for (const element of clause.elements) {
    names.add(element.propertyName?.text ?? element.name.text);
  }
}

/**
 * Read and filter the critical entries.
 *
 * A malformed record contributes nothing, matching `readJson`'s own
 * degrade-to-empty contract: this file is written by a tool, at a version we
 * do not control, and a gate that throws on it stops reporting everything else.
 */
function criticalEntries(root: string): readonly CriticalEntry[] {
  // `readJson` has already applied the policy's declarations to `is_critical`,
  // so a declared function arrives here as an ordinary critical record. Only
  // the REASON has to be looked up, because the record shape has nowhere to
  // carry one.
  const reasons = new Map(declaredCritical(root));
  const entries: CriticalEntry[] = [];
  for (const record of readJson(root)) {
    if (record["is_critical"] !== true) {
      continue;
    }
    const name = record["name"];
    if (typeof name !== "string" || name === "") {
      continue;
    }
    const fanIn = record["fan_in"];
    const declaredReason = reasons.get(name);
    entries.push({
      qualname: name,
      fanIn: typeof fanIn === "number" && Number.isFinite(fanIn) ? fanIn : 0,
      ...(declaredReason === undefined ? {} : { declaredReason }),
    });
  }
  return entries;
}

/** The part before the first `#`, or `null` when the name carries no module. */
function modulePart(qualname: string): string | null {
  const index = qualname.indexOf(QUALIFIER);
  return index <= 0 ? null : qualname.slice(0, index);
}

/** The part after the first `#`; the whole name when there is no separator. */
function qualifiedPart(qualname: string): string {
  const index = qualname.indexOf(QUALIFIER);
  return index < 0 ? qualname : qualname.slice(index + 1);
}
