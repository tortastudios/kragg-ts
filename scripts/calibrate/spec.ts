/**
 * The sample being calibrated, and how a command line names one.
 *
 * A sample is somebody else's repository. This module is the only place that
 * turns a string a human typed into the four facts a measurement needs — the
 * root to walk, the source paths inside it, the budgets to judge against, and
 * the tsconfig the type-aware gate must use — so `measure.ts` never parses
 * anything and `calibrate.ts` never guesses a default.
 *
 * THE GRAMMAR, in full:
 *
 *     [label=]root[:srcA,srcB][@tsconfig]
 *
 * `label` names the sample in the report and defaults to the root's basename.
 * `srcA,srcB` overrides `source_paths`; without it the sample's own
 * `kragg.json` (then `package.json#kragg`, then the built-in defaults) decides,
 * exactly as a real `kragg check` would. `@tsconfig` points the program tier
 * at a config that is not `<root>/tsconfig.json` — a pnpm workspace has no
 * root config at all, and saying so on the command line is more honest than
 * having the script hunt for one.
 *
 * The budgets are NEVER taken from the command line. They come from the
 * sample's effective policy, which is the number the sample would really be
 * judged by; a calibration run that let the operator pick the threshold would
 * measure the operator.
 */

import { basename, isAbsolute, resolve } from "node:path";

import { loadPolicy } from "../../src/policy/policy.ts";

/** One resolved sample: everything a measurement needs, nothing it does not. */
export interface SampleSpec {
  /** Short name for the report. */
  readonly label: string;
  /** Absolute path to the sample's root. */
  readonly root: string;
  /** Directories to walk, relative to `root`. */
  readonly sourcePaths: readonly string[];
  /** Absolute tsconfig for the program tier, or `null` for the default. */
  readonly tsconfigPath: string | null;
  /** `type_max_nesting_depth` in effect for this sample. */
  readonly maxDepth: number;
  /** `type_max_length` in effect for this sample. */
  readonly maxLength: number;
  /** Where `sourcePaths` came from, for the report's method section. */
  readonly sourcePathsFrom: "policy" | "argument";
}

/** Parse one `[label=]root[:src,src][@tsconfig]` argument. */
export function parseSampleSpec(argument: string): SampleSpec {
  const { label, rest } = splitLabel(argument);
  const { head, tsconfig } = splitTsconfig(rest);
  const { rootText, sources } = splitSources(head);

  const root = resolve(rootText);
  const policy = loadPolicy(root);
  return {
    label: label ?? basename(root),
    root,
    sourcePaths: sources ?? policy.sourcePaths,
    tsconfigPath: tsconfig === null ? null : resolveAgainst(root, tsconfig),
    maxDepth: policy.typeMaxNestingDepth,
    maxLength: policy.typeMaxLength,
    sourcePathsFrom: sources === null ? "policy" : "argument",
  };
}

/**
 * `label=` prefix, if any.
 *
 * The separator is the FIRST `=`, and a Windows-style `C:\...` root cannot
 * contain one, so there is no ambiguity to resolve.
 */
function splitLabel(argument: string): { label: string | null; rest: string } {
  const at = argument.indexOf("=");
  if (at === -1) {
    return { label: null, rest: argument };
  }
  return { label: argument.slice(0, at), rest: argument.slice(at + 1) };
}

/** `@tsconfig` suffix, taken from the LAST `@` so a scoped path survives. */
function splitTsconfig(text: string): { head: string; tsconfig: string | null } {
  const at = text.lastIndexOf("@");
  if (at <= 0) {
    return { head: text, tsconfig: null };
  }
  return { head: text.slice(0, at), tsconfig: text.slice(at + 1) };
}

/**
 * `:src,src` suffix.
 *
 * Taken from the LAST `:` because a root may legitimately contain one on
 * Windows, and an empty list (`root:`) is an error rather than "no paths":
 * silently walking nothing would report a green sample that was never read.
 */
function splitSources(text: string): { rootText: string; sources: readonly string[] | null } {
  const at = text.lastIndexOf(":");
  if (at <= 1) {
    return { rootText: text, sources: null };
  }
  const listed = text
    .slice(at + 1)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (listed.length === 0) {
    throw new Error(`sample "${text}": ":" was given but no source path followed it`);
  }
  return { rootText: text.slice(0, at), sources: listed };
}

function resolveAgainst(root: string, path: string): string {
  return isAbsolute(path) ? path : resolve(root, path);
}
