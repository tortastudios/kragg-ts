/**
 * `extends`-chain provenance for the tsconfig audit — decorative, best effort,
 * and never load-bearing.
 *
 * The audit's VERDICTS come from `parseJsonConfigFileContent`, which resolves
 * `extends` exactly as `tsc` does. This module exists only so a message can
 * add `(set in ./tsconfig.base.json)` and point at the file that actually
 * wrote the offending value — because "strictNullChecks is off" is a puzzle
 * when the root config plainly does not say so, and a base config three
 * packages away is the most likely place a downgrade hides.
 *
 * THE SAFETY RULE. Nothing here can create, suppress or change a finding. The
 * walk annotates a finding only when its own reading AGREES with the
 * compiler's resolved value; on any disagreement, unresolved link, unreadable
 * file or cycle, the annotation is silently dropped. A wrong pointer is worse
 * than no pointer.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { TypeScriptApi } from "../../analysis/sourceFile.ts";

/** The config file name, both as the audit's target and as a directory index. */
export const TSCONFIG_NAME = "tsconfig.json";

/**
 * A parsed JSON object. Values stay `unknown` until they are narrowed.
 *
 * Exported so `included.ts` narrows the same tsconfig document through the
 * same name, rather than minting a second alias for an identical shape.
 */
export type Table = Readonly<Record<string, unknown>>;

/** One config file in an `extends` chain. */
export interface ConfigFile {
  readonly path: string;
  /** The file's own `compilerOptions`, unmerged and unnarrowed. */
  readonly options: Table;
}

/** How many `extends` links to follow before giving up. */
const MAX_CHAIN = 16;

/**
 * The `extends` chain, NEAREST FIRST, starting with the config itself.
 *
 * Nearest-first is the order `tsc` merges in: a file's own `compilerOptions`
 * beat anything it extends, and within an `extends` array a later entry beats
 * an earlier one — so the array is walked in reverse.
 */
export function configChain(path: string, api: TypeScriptApi): readonly ConfigFile[] {
  const chain: ConfigFile[] = [];
  const seen = new Set<string>();
  const walk = (current: string, depth: number): void => {
    const key = resolve(current);
    if (depth > MAX_CHAIN || seen.has(key)) {
      return;
    }
    seen.add(key);
    const parsed = readConfig(key, api);
    if (parsed === null) {
      return;
    }
    chain.push({ path: key, options: parsed.options });
    for (const specifier of [...parsed.extends].reverse()) {
      const target = resolveExtends(specifier, dirname(key));
      if (target !== null) {
        walk(target, depth + 1);
      }
    }
  };
  walk(path, 0);
  return chain;
}

/**
 * ` (set in ./base.json)` when a file OTHER than the root config is where the
 * value was written; `""` in every other case, including every case this
 * module is unsure about.
 */
export function provenance(
  chain: readonly ConfigFile[],
  flag: string,
  effective: boolean,
): string {
  const root = chain[0];
  const owner = chain.find((file) => Object.hasOwn(file.options, flag));
  if (
    root === undefined ||
    owner === undefined ||
    owner === root ||
    owner.options[flag] !== effective
  ) {
    return "";
  }
  return ` (set in ${displayPath(root.path, owner.path)})`;
}

interface RawConfig {
  readonly options: Table;
  readonly extends: readonly string[];
}

/** Read one config's raw `compilerOptions` and `extends`, or `null`. */
function readConfig(path: string, api: TypeScriptApi): RawConfig | null {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  // `parseConfigFileTextToJson`, not `JSON.parse`: tsconfig files are JSONC,
  // and comments in them are the norm rather than the exception.
  const parsed = api.parseConfigFileTextToJson(path, text);
  if (parsed.error !== undefined || !isTable(parsed.config)) {
    return null;
  }
  const options: unknown = parsed.config["compilerOptions"];
  const inherits: unknown = parsed.config["extends"];
  return {
    options: isTable(options) ? options : {},
    extends: extendsList(inherits),
  };
}

/** `extends` is a string, or (TypeScript 5+) an array of them. */
function extendsList(value: unknown): readonly string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Resolve one `extends` specifier well enough to NAME a file.
 *
 * A relative or absolute specifier is a path, with `.json` and
 * `/tsconfig.json` tried in turn; anything else is a package, resolved through
 * Node from the directory doing the extending. Failure returns `null`, which
 * costs an annotation and nothing else.
 */
function resolveExtends(specifier: string, fromDir: string): string | null {
  if (specifier.startsWith(".") || isAbsolute(specifier)) {
    const base = resolve(fromDir, specifier);
    return firstReadable([base, `${base}.json`, join(base, TSCONFIG_NAME)]);
  }
  const resolver = createRequire(join(fromDir, "package.json"));
  for (const candidate of [specifier, `${specifier}/${TSCONFIG_NAME}`]) {
    try {
      return resolver.resolve(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

function firstReadable(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

/** A base config's path, relative to the root config, for a message. */
function displayPath(from: string, target: string): string {
  const rel = relative(dirname(from), target).split(sep).join("/");
  return rel.startsWith(".") ? rel : `./${rel}`;
}

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
