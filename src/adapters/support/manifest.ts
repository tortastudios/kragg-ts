/**
 * Non-throwing reads of the project files adapters inspect before running
 * anything: `package.json`, lockfiles, config files.
 *
 * Detection has to work on repos that are broken in ordinary ways — a
 * half-written `package.json`, a `vitest.config.ts` that is a dangling
 * symlink, a directory where a file is expected. None of those is an
 * exceptional condition for a tool whose job is to inspect other people's
 * repositories, and none of them should surface as a stack trace. Every reader
 * here answers `undefined` and lets the caller report the fact.
 *
 * `environment/project.ts` has private equivalents of these. They are not
 * exported and that module is owned elsewhere; duplicating ten lines is the
 * smaller cost.
 */

import { existsSync, readFileSync } from "node:fs";

import { isJsonObject, parseJson } from "./json.ts";
import type { JsonObject } from "./json.ts";

/** File contents, or `undefined` for missing, unreadable, or not-a-file. */
export function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** A JSON object read from `path`, or `undefined` for anything else. */
export function readJsonFile(path: string): JsonObject | undefined {
  const text = readTextFile(path);
  if (text === undefined) {
    return undefined;
  }
  const parsed = parseJson(text);
  return isJsonObject(parsed) ? parsed : undefined;
}

/** True when `path` exists. Never throws on a permission error. */
export function fileExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}
