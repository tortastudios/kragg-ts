/**
 * Supply-chain hardening written into every scaffolded project.
 *
 * These two files are the reason `kragg new` never runs a package manager. The
 * scaffold's whole claim is that a project is safe from the first install; an
 * install that ran BEFORE these files landed, or that ran them with defaults,
 * would have already executed whatever it was going to execute. So the files
 * are written, the exact command is printed, and the human runs it.
 *
 * The content mirrors kragg-ts's own `.npmrc` and `pnpm-workspace.yaml`
 * verbatim in intent, comments included. The comments are not decoration: the
 * single most expensive fact here — that pnpm v11 reads ONLY auth and registry
 * settings from `.npmrc`, and silently ignores everything else — is invisible
 * from the outside and produces confident, useless configuration when unknown.
 * A generated project inherits the explanation along with the setting.
 *
 * ONE setting varies by kind, and only one: `minimumReleaseAgeExclude`. See
 * `releaseAgeExclude` at the bottom of this file for what is excluded and why.
 * Everything else is byte-identical across every project kragg generates —
 * hardening that differs per kind is hardening nobody can reason about.
 */

import type { Kind, McpSdk } from "./kinds.ts";

/**
 * `.npmrc`. Governs `npm`/`npx`, NOT `pnpm` — see the comment in the file.
 *
 * It is written anyway, and deliberately: if a human or a CI step reaches for
 * `npm install` in this directory by mistake, lifecycle scripts still do not
 * run. Two tools, two files, the same posture in both.
 */
export const NPMRC = `# IMPORTANT — read before adding anything here.
#
# As of pnpm v11, pnpm reads ONLY auth and registry settings from .npmrc.
# Every other pnpm setting placed in this file is SILENTLY IGNORED, which is
# worse than useless: it creates false confidence. All pnpm supply-chain
# hardening for this project lives in \`pnpm-workspace.yaml\`. Put it there.
#
# The keys below are kept deliberately, and NOT for pnpm's benefit: \`npm\` and
# \`npx\` do still honour them. If anyone reaches for npm in this directory by
# mistake, dependency lifecycle scripts still will not run.

# Never run install lifecycle scripts (preinstall/install/postinstall/prepare)
# from dependencies. pnpm's equivalent is \`ignoreScripts: true\` in
# pnpm-workspace.yaml — that is the one that governs \`pnpm install\`.
ignore-scripts=true

# Exact versions only. No \`^\`, no \`~\`, no floating ranges: a range means the
# code you reviewed is not necessarily the code that installs tomorrow.
# \`pnpm add\` writes a caret range regardless of this key, so after adding a
# dependency with pnpm, pin the version by hand in package.json.
save-exact=true
`;

/**
 * The invariant half of `pnpm-workspace.yaml` — everything except the
 * cooldown's exclusion list, which `releaseAgeExclude` appends.
 *
 * Every setting carries the doc URL it was verified against, because several
 * of these keys were renamed or introduced recently and a plausible-looking
 * wrong key name provides exactly zero protection while looking like a wall.
 */
const PNPM_WORKSPACE_BASE = `# pnpm settings for this project.
#
# As of pnpm v11, ONLY auth and registry settings are read from \`.npmrc\`.
# Every behavioural setting — including all supply-chain hardening below —
# must live here or it is silently ignored.
#
# \`packages:\` is deliberately omitted: this is a single-package repo, so the
# workspace contains only the root package. This file exists for settings.

# --- Build / lifecycle scripts -------------------------------------------
#
# Never run install lifecycle scripts (preinstall/install/postinstall/
# prepare) from dependencies OR from this project. This is the single most
# important control against npm supply-chain attacks: a malicious version
# cannot execute code merely by being installed.
# Verified: https://pnpm.io/settings/build#ignorescripts (default: false)
ignoreScripts: true

# Allowlist of packages permitted to run build scripts, as a map of package
# matchers to true/false. Empty map = nothing is allowed to build.
# \`onlyBuiltDependencies\`, \`onlyBuiltDependenciesFile\`, \`neverBuiltDependencies\`,
# \`ignoredBuiltDependencies\` and \`ignoreDepScripts\` were REMOVED in pnpm v11
# and replaced by \`allowBuilds\`. Do not add entries here without a written
# review; adding one re-enables arbitrary code execution at install time.
# Verified: https://pnpm.io/settings/build#allowbuilds (added in v10.26.0)
allowBuilds: {}

# Explicitly reassert the default. \`true\` would run every dependency's build
# scripts with no approval step. It must stay false, forever.
# Verified: https://pnpm.io/settings/build#dangerouslyallowallbuilds (v10.9.0)
dangerouslyAllowAllBuilds: false

# --- Release-age cooldown ------------------------------------------------
#
# A published-then-yanked malicious version is usually caught within days.
# Refuse to install anything younger than 30 days (43200 minutes).
# pnpm v11's default is 1440 (1 day), which is not enough.
# Verified: https://pnpm.io/settings/dependency-resolution#minimumreleaseage
# (added in v10.16.0; unit is MINUTES)
#
# CONSEQUENCE, so it is not a surprise: a dependency version published in the
# last 30 days will be REFUSED. That is the control working. Pin an older
# version; do not lower the cooldown to make an install succeed.
minimumReleaseAge: 43200

# Fail the install when no version satisfies the cooldown, rather than
# quietly installing a too-new one. Defaults to true when minimumReleaseAge
# is explicitly configured; set here so the fail-closed behaviour is not
# dependent on a default we would rather not trust.
# Verified: https://pnpm.io/settings/dependency-resolution#minimumreleaseagestrict
# (added in v11.0.0)
minimumReleaseAgeStrict: true

# The default (true) SKIPS the cooldown check for any package whose registry
# metadata lacks a \`time\` field — an obvious bypass. Fail closed instead.
# Verified: https://pnpm.io/settings/dependency-resolution#minimumreleaseageignoremissingtime
# (added in v11.0.0)
minimumReleaseAgeIgnoreMissingTime: false
`;

/** The exclusion list for every kind that has nothing to exclude. */
const NO_EXCLUSIONS = `
# No package is exempt from the cooldown. Keep this empty.
# Verified: https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude
minimumReleaseAgeExclude: []
`;

/**
 * The exclusion list for `--kind mcp` on the fastmcp SDK.
 *
 * This is the ONE place the scaffold weakens its own floor, and it is written
 * out at length on purpose. An exemption that does not say what it exempts,
 * why, and when it stops being needed is indistinguishable from someone
 * silencing a check — the same reason `// kragg: ignore` in this codebase is
 * required to carry a reason.
 */
const FASTMCP_EXCLUSIONS = `
# --- EXEMPTION from the cooldown above: scoped, dated, and temporary -----
#
# WHAT IS EXCLUDED: the packages named below, and nothing else. A name here
# is exempt from \`minimumReleaseAge\` — it installs at whatever version the
# range resolves to, however recently that version was published. Everything
# not named here is still held to the full 30 days.
#
# WHY: \`@prefecthq/fastmcp-ts\` is the official FastMCP TypeScript library,
# and it is new. 1.0.0 was published 2026-07-28 and releases have been
# landing weekly since. NO published version of it is 30 days old, and its
# runtime dependency on MCP TypeScript SDK v2 (\`@modelcontextprotocol/*\`,
# whose only non-prerelease 2.x version is 2.0.0, published 2026-07-27) is
# in the same position — \`^2.0.0\` has exactly one satisfying version and it
# is younger than the floor. With \`minimumReleaseAgeStrict: true\` above,
# that is not a warning: \`pnpm install\` fails outright, in a project that
# has not been touched since it was generated.
#
# WHY IT IS WRITTEN THIS WAY: lowering \`minimumReleaseAge\`, or dropping
# \`minimumReleaseAgeStrict\`, would exempt EVERY dependency in the tree —
# hundreds of packages — to unblock six. This list exempts the six. Each
# entry is a full package name, never a \`@scope/*\` pattern, so a NEW package
# published under either scope is not silently exempted along with them.
#
# WHEN TO REMOVE: as soon as the versions this project pins are older than
# 30 days. Check with:
#
#   npm view @prefecthq/fastmcp-ts time
#   npm view @modelcontextprotocol/server time
#
# then delete the entries that have aged out. Deleting all of them and
# restoring \`minimumReleaseAgeExclude: []\` is the goal state.
#
# Verified: https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude
minimumReleaseAgeExclude:
  # The MCP framework itself. Pinned exactly in package.json.
  - "@prefecthq/fastmcp-ts"
  # Its runtime dependencies: MCP TypeScript SDK v2, published 2026-07-27.
  # Pulled in transitively by the entry above, so excluding only that one
  # would leave the install failing on these instead.
  - "@modelcontextprotocol/core"
  - "@modelcontextprotocol/client"
  - "@modelcontextprotocol/node"
  - "@modelcontextprotocol/server"
  - "@modelcontextprotocol/server-legacy"
`;

/**
 * `pnpm-workspace.yaml` for a project of this kind. This is where pnpm's
 * hardening actually takes effect.
 *
 * `kind` is `null` for `kragg init`, which adds guardrails to a project whose
 * dependencies are not ours — so it gets the unexempted floor.
 */
export function pnpmWorkspace(kind: Kind | null, mcpSdk: McpSdk): string {
  return PNPM_WORKSPACE_BASE + releaseAgeExclude(kind, mcpSdk);
}

/**
 * Which exclusion block a kind gets.
 *
 * Only `--kind mcp --mcp-sdk fastmcp` gets one. The `official` SDK variant
 * depends on `@modelcontextprotocol/sdk` v1, not on anything excluded here,
 * so exempting names it does not install would be dead configuration that
 * quietly widens over time.
 */
function releaseAgeExclude(kind: Kind | null, mcpSdk: McpSdk): string {
  if (kind === "mcp" && mcpSdk === "fastmcp") {
    return FASTMCP_EXCLUSIONS;
  }
  return NO_EXCLUSIONS;
}
