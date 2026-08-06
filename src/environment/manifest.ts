/**
 * Reading the target project's `package.json`, defensively.
 *
 * Split out of `project.ts`. Every read here answers with `null` rather than
 * throwing: a missing, unreadable or malformed manifest is a fact about the
 * repo that the caller turns into a reportable finding, not a stack trace.
 */

import { readFileSync } from "node:fs";

/** A parsed JSON object. Values stay `unknown` until something narrows them. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** Arrays are objects to `typeof`, and are not what any caller here wants. */
export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a JSON object, or `null` for missing/unreadable/malformed. */
export function readJsonObject(path: string): JsonObject | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Every string in an array value, ignoring entries of any other type. */
export function stringItems(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.filter((item): item is string => typeof item === "string");
}
