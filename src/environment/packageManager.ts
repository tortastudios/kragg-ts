/**
 * Which package manager owns the project, and the command that installs into
 * it.
 *
 * Split out of `project.ts`, which re-exports the public surface. The
 * precedence rules are the whole content of this module: get them wrong and
 * kragg runs the wrong install command against someone else's repo.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isKnownManager, KNOWN_MANAGERS, type PackageManager } from "./model.ts";
import { readJsonObject } from "./manifest.ts";

/**
 * Operator override, highest precedence of all. Mirrors Python's
 * `KRAGG_PROJECT_PYTHON`: the escape hatch for a repo whose layout we read
 * wrong. Must name a supported manager; anything else throws.
 */
export const PACKAGE_MANAGER_ENV_VAR = "KRAGG_PACKAGE_MANAGER";

/** One lockfile name and the manager whose presence it proves. */
export type LockfileSignal = readonly [string, PackageManager];

/**
 * Lockfile -> package manager, in detection precedence order.
 *
 * Order matters: a repo migrating between managers carries two lockfiles, and
 * the first match wins. The order is by *strength of evidence*, not alphabet:
 *
 *  - `pnpm-lock.yaml` is written only by pnpm and by nothing else.
 *  - `bun.lock` (text, Bun 1.2+) before `bun.lockb` (binary, older) because a
 *    repo mid-migration keeps both, and the newer format is the live one.
 *  - `yarn.lock` is yarn-specific, but bun can also consume one, so it sorts
 *    below bun's own.
 *  - `package-lock.json` sorts LAST: it is the weakest signal. It is the file
 *    most often left behind by an abandoned manager, and the one a stray
 *    `npm install` by a contributor (or a CI script, or an editor) creates in
 *    a repo that does not use npm at all.
 */
export const LOCKFILES: readonly LockfileSignal[] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
];

/** A detected manager, and the evidence that decided it. */
export interface ManagerDetection {
  readonly packageManager: PackageManager;
  /** The env var, `package.json#packageManager`, a lockfile name, or `unknown`. */
  readonly source: string;
}

/**
 * Detect which package manager owns this project.
 *
 * Precedence, highest first:
 *
 *  1. `KRAGG_PACKAGE_MANAGER` — an operator override. Throws if it names a
 *     manager we do not support, rather than falling through to inference:
 *     an override that is silently ignored is worse than no override.
 *  2. `package.json#packageManager` — an explicit, machine-readable
 *     declaration that corepack already enforces. It beats lockfile
 *     inference because it says what the project IS, while a lockfile only
 *     shows what some tool once DID. A repo that migrated from npm to pnpm
 *     has the new manager in the field and, very often, both lockfiles on
 *     disk. An unrecognised value here yields `"unknown"` and stops: the
 *     project told us something specific and guessing past it would be worse.
 *  3. `LOCKFILES`, in the documented order above.
 *  4. `"unknown"`. Never npm-by-default — guessing wrong means running the
 *     wrong install and lockfile-update commands against a user's repo.
 */
export function detectPackageManager(root: string): ManagerDetection {
  const override = process.env[PACKAGE_MANAGER_ENV_VAR];
  if (override !== undefined && override.trim() !== "") {
    return {
      packageManager: parseOverride(override.trim()),
      source: PACKAGE_MANAGER_ENV_VAR,
    };
  }

  const declared = declaredPackageManager(root);
  if (declared !== null) {
    return { packageManager: declared, source: "package.json#packageManager" };
  }

  for (const [file, manager] of LOCKFILES) {
    if (existsSync(join(root, file))) {
      return { packageManager: manager, source: file };
    }
  }
  return { packageManager: "unknown", source: "unknown" };
}

/** Reject an override we cannot act on, rather than ignoring it. */
function parseOverride(value: string): PackageManager {
  if (isKnownManager(value)) {
    return value;
  }
  throw new Error(
    `${PACKAGE_MANAGER_ENV_VAR}=${value} names an unsupported package manager. ` +
      `Expected one of: ${KNOWN_MANAGERS.join(", ")}.`,
  );
}

/**
 * Read `package.json#packageManager`, e.g. `"pnpm@11.9.0+sha512.abc..."`.
 *
 * Returns `"unknown"` (not `null`) when the field is present but names
 * something we do not support, so the caller can stop rather than fall
 * through to lockfile inference. `null` means the field is absent.
 */
function declaredPackageManager(root: string): PackageManager | null {
  const manifest = readJsonObject(join(root, "package.json"));
  if (manifest === null) {
    return null;
  }
  const declared = manifest["packageManager"];
  if (typeof declared !== "string" || declared.trim() === "") {
    return null;
  }
  // Strip the version and the corepack integrity suffix: `pnpm@11.9.0+sha512.…`
  const name = declared.trim().split("@")[0] ?? "";
  return isKnownManager(name) ? name : "unknown";
}

/**
 * The exact command that installs a missing project tool.
 *
 * Mirrors `environment.py`'s `remediation()`, including its tail: the tool
 * may already be declared in package.json and merely not installed, and
 * telling someone to re-add a dependency they already have wastes a cycle.
 */
export function remediation(pm: PackageManager, packageName: string): string {
  const install: Record<PackageManager, string> = {
    pnpm: `pnpm add -D ${packageName}`,
    npm: `npm install --save-dev ${packageName}`,
    yarn: `yarn add --dev ${packageName}`,
    bun: `bun add --dev ${packageName}`,
    unknown: `install ${packageName} as a dev dependency`,
  };
  const sync: Record<PackageManager, string> = {
    pnpm: "pnpm install",
    npm: "npm install",
    yarn: "yarn install",
    bun: "bun install",
    unknown: "install dependencies",
  };
  return `Fix: ${install[pm]} (or run \`${sync[pm]}\` if already declared)`;
}
