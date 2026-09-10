/**
 * Finding the project's code formatter — the `ruff format` half of `kragg fix`.
 *
 * ── WHY THIS IS NOT PART OF `lint.ts` ──────────────────────────────────────
 * In Python there is one tool: `ruff format` and `ruff check --fix` are two
 * subcommands of the binary kragg bundles. JavaScript split the two jobs
 * across two tool families years ago, and the split is not aligned with the
 * lint-tool choice: oxlint-for-lint plus Prettier-for-format is an ordinary
 * pairing, and oxlint is the linter this repository itself uses. Deriving the
 * formatter from `lintTool` would therefore mean that every project on the
 * fastest linter gets no formatting at all — which is exactly what `kragg fix`
 * did before this module existed, while its own `--help` line promised
 * "format and safely fix lint findings".
 *
 * So formatting is detected INDEPENDENTLY. Biome remains the one tool that
 * covers both roles, and when it is the project's linter `commands/fix.ts`
 * keeps using its combined `check --write` pass rather than asking here.
 *
 * ── SAME POLICY AS EVERY OTHER TOOL kragg DRIVES ───────────────────────────
 * Resolved from the PROJECT's `node_modules/.bin` through
 * `environment/project.ts` — never `PATH`, never a global install, never
 * kragg's own tree (docs/dependency-policy.md: kragg bundles nothing). A
 * formatter of a different major rewrites source to a style the project never
 * chose, and unlike a misreported gate that damage is on disk.
 *
 * Absent is a VISIBLE SKIP carrying the exact install command, never a silent
 * no-op — `_unconfigured` in `catalog.py`: "Unconfigured policy-driven gates
 * SKIP visibly, never PASS silently."
 *
 * ── CONFIGURED *AND* INSTALLED, WHICH IS STRICTER THAN `detectLintTool` ────
 * `detectLintTool` has a second stage that accepts a merely-installed linter,
 * because a linter with no config runs its built-in rule set and reports; the
 * worst case is noise in a report. A formatter with no config REWRITES EVERY
 * FILE IT IS POINTED AT to its own defaults. Prettier in particular arrives
 * as a transitive dependency of plenty of toolchains, so "installed" is not
 * evidence that the project wants its style — and picking it up on that basis
 * would impose a formatting choice on a project that made none, permanently,
 * on disk, in one command.
 *
 * A formatter is therefore chosen only when the project both installed it and
 * configured it. Installed-without-config is reported as a skip that names
 * the config file to add, so the state is visible and one file away from
 * being fixed. There is no `format_tool` policy key: `lint_tool` exists
 * because a repo can carry two linter configs at once and needs a tie-break,
 * while a formatter config file already IS the project's declaration, and a
 * new policy key is a `policy show` field whose order is a contract with the
 * Python implementation.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { readJsonObject } from "../environment/manifest.ts";
import { remediation, resolveBin, type ProjectEnvironment } from "../environment/project.ts";

/** A formatter this adapter can drive. */
export type FormatTool = "prettier" | "biome";

/**
 * Detection order, and the tie-break when a repo carries both configs.
 *
 * Prettier first because it is the dedicated formatter: a project that
 * configured Prettier configured it *to format*, while `biome.json` may exist
 * for Biome's linter alone. The case where Biome is the project's linter never
 * reaches this module — `commands/fix.ts` runs its combined `check --write`
 * pass instead — so a Biome chosen here is Biome-as-formatter, which is what
 * `format --write` runs.
 */
export const FORMAT_TOOLS: readonly FormatTool[] = ["prettier", "biome"];

/** How a formatter is invoked and what marks it as this project's choice. */
interface FormatToolSpec {
  /** `node_modules/.bin` entry to resolve. */
  readonly bin: string;
  /** npm package that provides it — differs from the bin for biome. */
  readonly packageName: string;
  /** Config files, relative to the project root, that mark it as configured. */
  readonly configFiles: readonly string[];
  /** A `package.json` key that also counts as configuration, if any. */
  readonly manifestKey?: string;
  /** Arguments after the binary, before the target paths. */
  readonly args: readonly string[];
  /** The config file to suggest when the tool is installed but unconfigured. */
  readonly suggestConfig: string;
}

/** The whole table, named so the annotation below stays inside the type budget. */
type FormatToolSpecs = Readonly<Record<FormatTool, FormatToolSpec>>;

/**
 * Per-tool invocation.
 *
 * Prettier's config names are its own resolution list (`config-searcher` in
 * `src/config/resolve-config.js`): a `prettier` key in `package.json`, a
 * `.prettierrc` in JSON or YAML, the extension-qualified `.prettierrc.*`
 * forms, `prettier.config.*`, and the TOML variant. `.editorconfig` is
 * deliberately NOT in the list: Prettier reads it, but a repo can carry one
 * without having chosen Prettier at all, so it is not a declaration.
 *
 * Biome's are `biome.json` / `biome.jsonc`, the same two `lint.ts` uses.
 */
const SPECS: FormatToolSpecs = {
  prettier: {
    bin: "prettier",
    packageName: "prettier",
    configFiles: [
      ".prettierrc",
      ".prettierrc.json",
      ".prettierrc.json5",
      ".prettierrc.yml",
      ".prettierrc.yaml",
      ".prettierrc.toml",
      ".prettierrc.js",
      ".prettierrc.mjs",
      ".prettierrc.cjs",
      ".prettierrc.ts",
      ".prettierrc.mts",
      ".prettierrc.cts",
      "prettier.config.js",
      "prettier.config.mjs",
      "prettier.config.cjs",
      "prettier.config.ts",
      "prettier.config.mts",
      "prettier.config.cts",
    ],
    manifestKey: "prettier",
    args: ["--write"],
    suggestConfig: ".prettierrc.json",
  },
  biome: {
    bin: "biome",
    packageName: "@biomejs/biome",
    configFiles: ["biome.json", "biome.jsonc"],
    // `format --write`, not `check --write`: reaching this module at all means
    // biome is NOT the project's linter, so running its linter here would
    // apply a rule set the project did not choose for linting.
    args: ["format", "--write"],
    suggestConfig: "biome.json",
  },
};

/** Which formatter to run, or why none will be. */
export type FormatDetection =
  | {
      readonly ok: true;
      readonly tool: FormatTool;
      readonly bin: string;
      readonly args: readonly string[];
    }
  | { readonly ok: false; readonly message: string };

/**
 * Choose the formatter for this project.
 *
 * The first tool in `FORMAT_TOOLS` that is BOTH configured and installed, or a
 * skip that says which half is missing. There is no error outcome: nothing in
 * the policy can name a formatter, so nothing here can be an override kragg
 * failed to honour. (`commands/fix.ts` still reports a named-but-missing
 * LINTER as exit 3, unchanged.)
 */
export function detectFormatter(env: ProjectEnvironment): FormatDetection {
  for (const tool of FORMAT_TOOLS) {
    if (!isConfigured(env.root, tool)) {
      continue;
    }
    const bin = resolveBin(env, SPECS[tool].bin);
    if (bin !== null) {
      return { ok: true, tool, bin, args: SPECS[tool].args };
    }
  }
  return { ok: false, message: noFormatterMessage(env) };
}

/** A config file in the root, or the `package.json` key that stands in for one. */
function isConfigured(root: string, tool: FormatTool): boolean {
  const spec = SPECS[tool];
  if (spec.configFiles.some((name) => existsSync(join(root, name)))) {
    return true;
  }
  const key = spec.manifestKey;
  if (key === undefined) {
    return false;
  }
  const manifest = readJsonObject(join(root, "package.json"));
  return manifest !== null && manifest[key] !== undefined;
}

/**
 * The skip message, which has to be actionable enough to fix the skip.
 *
 * Both halves are named separately because they are different problems with
 * different fixes: "you configured Prettier and did not install it" is a
 * broken install, while "Prettier is in `node_modules` and this repo declares
 * no style" is the case where kragg deliberately does nothing rather than
 * choose for the project.
 */
function noFormatterMessage(env: ProjectEnvironment): string {
  const lines: string[] = ["no formatter ran; nothing was reformatted."];
  const halfPresent = FORMAT_TOOLS.map((tool) => halfPresentMessage(env, tool)).filter(
    (line): line is string => line !== null,
  );
  if (halfPresent.length > 0) {
    // A tool that is half-there has ONE missing piece and one exact fix, which
    // beats a generic menu that repeats what the project already did.
    lines.push(...halfPresent);
    return lines.join("\n");
  }
  lines.push("Install and configure one of:");
  for (const tool of FORMAT_TOOLS) {
    const spec = SPECS[tool];
    const install = remediation(env.packageManager, spec.packageName);
    lines.push(`  ${tool}: ${install}; then add ${spec.suggestConfig}`);
  }
  return lines.join("\n");
}

/**
 * The line for a tool that is installed OR configured but not both, else null.
 *
 * `detectFormatter` returns `ok` for a tool that is both, so reaching here
 * with both true is impossible; the two branches are the only two ways a
 * formatter can be half-present.
 */
function halfPresentMessage(env: ProjectEnvironment, tool: FormatTool): string | null {
  const spec = SPECS[tool];
  const installed = resolveBin(env, spec.bin) !== null;
  const configured = isConfigured(env.root, tool);
  if (configured && !installed) {
    return (
      `${configFound(env.root, tool)} found, but ${spec.bin} is not installed. ` +
      remediation(env.packageManager, spec.packageName)
    );
  }
  if (installed && !configured) {
    return (
      `${spec.bin} is installed, but this project declares no ${tool} configuration, so ` +
      `kragg did not impose one. Fix: add ${spec.suggestConfig} to the project root.`
    );
  }
  return null;
}

/** What was found on disk, for the "configured but not installed" line. */
function configFound(root: string, tool: FormatTool): string {
  const spec = SPECS[tool];
  const files = spec.configFiles.filter((name) => existsSync(join(root, name)));
  return files.length > 0 ? files.join(", ") : `package.json#${spec.manifestKey ?? tool}`;
}
