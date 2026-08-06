/**
 * The handle a file scan carries, and the two spelling rules every part of the
 * gate has to agree on.
 */

import { sep } from "node:path";

import type bundledTs from "typescript";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** Module part of a path for anything declared in global scope. */
export const GLOBAL_MODULE = "globalThis";

/** The same, as a path prefix. */
export const GLOBAL_PREFIX = `${GLOBAL_MODULE}.`;

/** Everything one file's scan needs; the compiler instance travels with it. */
export interface Resolver {
  readonly api: TypeScriptApi;
  readonly checker: bundledTs.TypeChecker;
  readonly root: string;
}

/**
 * One spelling for `node:fs` and `fs`.
 *
 * Applied to configured entries and to resolved paths alike, so the two always
 * meet. Unconditional because `node:` is a reserved scheme — no npm package
 * can claim the prefix.
 */
export function canonicalPath(path: string): string {
  return path.startsWith("node:") ? path.slice("node:".length) : path;
}

export function toPosix(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}
