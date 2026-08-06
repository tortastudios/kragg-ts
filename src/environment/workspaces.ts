/**
 * Workspace detection, without inventing information we cannot read.
 *
 * Split out of `project.ts`, which re-exports `detectWorkspaces`. The two
 * TODOs below are the honest limits of a zero-runtime-dependency
 * implementation, and they are reported to the user rather than papered over.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { isJsonObject, readJsonObject, stringItems } from "./manifest.ts";
import type { WorkspaceInfo } from "./model.ts";

/**
 * Detect workspaces without inventing information we cannot read.
 *
 * `pnpm-workspace.yaml` wins when present, because for a pnpm repo it is the
 * authoritative list even if package.json also carries a `workspaces` field.
 *
 * TODO(yaml): `pnpm-workspace.yaml#packages` needs a YAML reader to turn into
 * patterns. The file also carries this project's own supply-chain settings,
 * so the subset is not trivially `packages:`-list-shaped and a hand-rolled
 * parser would be wrong in exactly the cases that matter. Decide between (a)
 * a vetted YAML dependency, or (b) shelling out to the project's own pnpm
 * (`pnpm -r list --depth -1 --json`), which is consistent with running the
 * project's toolchain rather than our own. Do not hand-roll it.
 *
 * TODO(globs): `package.json#workspaces` patterns are reported verbatim.
 * Expanding `packages/*` and honouring `!negations` needs a glob matcher.
 */
export function detectWorkspaces(root: string): WorkspaceInfo {
  const pnpmConfig = join(root, "pnpm-workspace.yaml");
  if (existsSync(pnpmConfig)) {
    return {
      kind: "pnpm",
      configPath: pnpmConfig,
      patterns: [],
      note: "pnpm-workspace.yaml found; its `packages` globs are not parsed (no YAML reader)",
    };
  }

  const manifest = readJsonObject(join(root, "package.json"));
  const patterns = manifest === null ? null : workspacePatterns(manifest["workspaces"]);
  if (patterns === null) {
    return { kind: "none", configPath: null, patterns: [], note: null };
  }
  return {
    kind: "package-json",
    configPath: join(root, "package.json"),
    patterns,
    note: "workspace globs are reported as declared, not expanded to package roots",
  };
}

/**
 * Accept both shapes npm/yarn/bun support: a bare array, or an object with a
 * `packages` array (yarn classic's form). Anything else is not a workspace
 * declaration we understand, and is reported as no workspace rather than as a
 * partially-read one.
 */
function workspacePatterns(value: unknown): readonly string[] | null {
  const direct = stringItems(value);
  if (direct !== null) {
    return direct;
  }
  return isJsonObject(value) ? stringItems(value["packages"]) : null;
}

/** One-line workspace summary for `describe`. */
export function describeWorkspaces(info: WorkspaceInfo): string {
  if (info.kind === "none") {
    return "none (single-package repo)";
  }
  if (info.patterns.length === 0) {
    return `${info.kind} (${info.configPath ?? "?"})`;
  }
  return `${info.kind} (${info.patterns.join(", ")})`;
}
