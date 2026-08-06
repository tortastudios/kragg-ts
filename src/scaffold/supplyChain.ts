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
 */

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
 * `pnpm-workspace.yaml`. This is where pnpm's hardening actually takes effect.
 *
 * Every setting carries the doc URL it was verified against, because several
 * of these keys were renamed or introduced recently and a plausible-looking
 * wrong key name provides exactly zero protection while looking like a wall.
 */
export const PNPM_WORKSPACE = `# pnpm settings for this project.
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

# No package is exempt from the cooldown. Keep this empty.
# Verified: https://pnpm.io/settings/dependency-resolution#minimumreleaseageexclude
minimumReleaseAgeExclude: []
`;
