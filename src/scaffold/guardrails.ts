/**
 * The guardrail files: everything a scaffolded project gets that is not
 * source code.
 *
 * Ported from `_guardrail_files` in `kragg/scaffold.py`, with the Python
 * toolchain files (`pyproject.toml`, `Makefile`, `.pre-commit-config.yaml`)
 * replaced by their real TypeScript equivalents rather than transliterated.
 *
 * `kragg init` writes this same set into an existing project, which is why the
 * set is a function of the project's identity and nothing else: no file here
 * may assume the skeleton exists.
 */

import { kraggVersion } from "../engine/report.ts";
import { AGENTS_MD, CLAUDE_MD, CRITICALITY_MD } from "./agents.ts";
import {
  BASE_DEV_DEPENDENCIES,
  kindBin,
  kindDependencies,
  kindRunInstructions,
  kindStartScript,
  type Kind,
  type McpSdk,
} from "./kinds.ts";
import { NPMRC, pnpmWorkspace } from "./supplyChain.ts";

/** Node version the scaffold targets. Type stripping needs 22.18 or newer. */
export const NODE_VERSION = "24";

/** The `engines.node` range the generated `package.json` declares. */
export const ENGINES_NODE = ">=22.18";

/** What identifies a project to the scaffold. */
export interface ProjectIdentity {
  /** Human-facing project name (usually the directory name). */
  readonly projectName: string;
  /** npm package name; may differ from `projectName` via `--package`. */
  readonly packageName: string;
  /** Which kind of project, or `null` for `kragg init` (no skeleton). */
  readonly kind: Kind | null;
  /** Which MCP SDK, when `kind` is `"mcp"`. */
  readonly mcpSdk: McpSdk;
}

/**
 * Every non-source file, keyed by project-relative path.
 *
 * `package.json` is included even for `kragg init`, where the caller merges it
 * into the existing one rather than writing it — see `commands/init.ts`.
 */
export function guardrailFiles(identity: ProjectIdentity): Record<string, string> {
  return {
    "README.md": readme(identity),
    ".gitignore": GITIGNORE,
    ".node-version": `${NODE_VERSION}\n`,
    ".npmrc": NPMRC,
    "pnpm-workspace.yaml": pnpmWorkspace(identity.kind, identity.mcpSdk),
    "package.json": `${JSON.stringify(packageJson(identity), null, 2)}\n`,
    "tsconfig.json": tsconfig(identity.kind),
    "tsconfig.build.json": TSCONFIG_BUILD,
    "kragg.json": `${JSON.stringify(kraggConfig(identity.kind), null, 2)}\n`,
    ".github/workflows/quality.yml": GITHUB_WORKFLOW,
    ".claude/settings.json": CLAUDE_SETTINGS,
    ".gemini/settings.json": GEMINI_SETTINGS,
    "AGENTS.md": AGENTS_MD,
    "CLAUDE.md": CLAUDE_MD,
    "CRITICALITY.md": CRITICALITY_MD,
  };
}

/**
 * The generated `package.json`, as an object so `kragg init` can merge it.
 *
 * Dependency versions are EXACT. See `kinds.ts` for why, and note that this
 * file and `.npmrc`'s `save-exact=true` have to agree or the policy is
 * decorative.
 */
export function packageJson(identity: ProjectIdentity): Record<string, unknown> {
  const kind = identity.kind;
  const scripts: Record<string, string> = {
    build: "tsc -p tsconfig.build.json",
    typecheck: "tsc --noEmit -p tsconfig.json",
    test: 'node --test "test/**/*.test.ts"',
    check: "pnpm exec kragg check",
  };
  const start = kind === null ? null : kindStartScript(kind);
  if (start !== null) {
    scripts["start"] = start;
  }
  const manifest: Record<string, unknown> = {
    name: identity.packageName,
    version: "0.1.0",
    private: true,
    type: "module",
    engines: { node: ENGINES_NODE },
    packageManager: "pnpm@11.9.0",
  };
  const bin = kind === null ? null : kindBin(kind);
  if (bin !== null) {
    manifest["bin"] = { [identity.projectName]: bin };
  }
  manifest["scripts"] = scripts;
  manifest["dependencies"] =
    kind === null ? {} : kindDependencies(kind, identity.mcpSdk);
  manifest["devDependencies"] = devDependencies();
  return manifest;
}

/**
 * Dev dependencies, with `kragg-ts` itself pinned only when this build IS a
 * released version.
 *
 * A generated `package.json` that depends on an unpublished version produces a
 * project whose very first `pnpm install` fails. A scaffold that cannot be
 * installed is worse than one that needs a documented extra step. So the pin
 * appears once there is something real to pin to, and not before.
 */
function devDependencies(): Record<string, string> {
  const dependencies: Record<string, string> = { ...BASE_DEV_DEPENDENCIES };
  const version = kraggVersion();
  if (/^\d+\.\d+\.\d+/.test(version) && !version.startsWith("0.0.0")) {
    dependencies["kragg-ts"] = version;
  }
  return dependencies;
}

/**
 * The generated `kragg.json`.
 *
 * Keys are snake_case because that is what `loadPolicy` reads — the two
 * implementations share a config vocabulary so a polyglot repo can run both
 * tools against one mental model. `layers` is set from the first commit; the
 * `boundaries` gate is a no-op without it, and a layout nobody enforces
 * decays.
 */
export function kraggConfig(kind: Kind | null): Record<string, unknown> {
  const config: Record<string, unknown> = {
    profile: "strict-ai-typescript",
    source_paths: ["src"],
    test_paths: ["test"],
    coverage_fail_under: 80,
    type_max_nesting_depth: 2,
    type_max_length: 40,
  };
  if (kind !== null) {
    config["layers"] = ["src/entrypoints", "src/services", "src/domain"];
  }
  return config;
}

function readme(identity: ProjectIdentity): string {
  const run =
    identity.kind === null
      ? ""
      : `## Run\n\n${kindRunInstructions(identity.kind, identity.projectName)}\n`;
  return `# ${identity.projectName}

Generated with \`kragg\`.

## Install

\`\`\`bash
pnpm install
\`\`\`

Lifecycle scripts are disabled and a 30-day release cooldown is enforced (see
\`pnpm-workspace.yaml\`). Both are deliberate; read the comments there before
changing either.
${youngDependencyNote(identity)}
${run}## Quality gates

\`\`\`bash
pnpm exec kragg check
\`\`\`

The agent contract is \`AGENTS.md\`. Read it before changing code here.
`;
}

/**
 * The README paragraph warning that this project's MCP dependency is young.
 *
 * Stated in the README rather than only in `pnpm-workspace.yaml` because the
 * person deciding whether this project is fit for production reads the README,
 * and "a dependency here is two weeks old and exempted from your own cooldown"
 * is exactly the fact that decision turns on. Empty for every other kind.
 */
function youngDependencyNote(identity: ProjectIdentity): string {
  if (identity.kind !== "mcp" || identity.mcpSdk !== "fastmcp") {
    return "";
  }
  return `
### A note on this project's MCP dependency

\`@prefecthq/fastmcp-ts\` is PrefectHQ's official FastMCP TypeScript library —
the same organisation as the Python FastMCP, which is why it is the default
here. It is also NEW: 1.0.0 shipped 2026-07-28, releases have been landing
weekly, and no published version is yet 30 days old.

That has one concrete consequence you are agreeing to. It and the MCP
TypeScript SDK v2 packages it depends on are listed in
\`minimumReleaseAgeExclude\` in \`pnpm-workspace.yaml\`, which exempts them from
the 30-day cooldown every other dependency in this project is held to. Without
that, \`pnpm install\` would fail on a project nobody had touched yet. The
exemption is scoped to those package names, nothing else, and it should be
deleted once the pinned versions have aged past 30 days.

Expect the API to move. The version in \`package.json\` is pinned exactly; read
the release notes before raising it.
`;
}

const GITIGNORE = `# build output
dist/
*.tsbuildinfo

# dependencies
node_modules/

# testing
coverage/
.nyc_output/

# kragg run journal
.kragg/

# env
.env
.env.*
!.env.example

# OS
.DS_Store
`;

/**
 * The libraries a kind's PINNED DEPENDENCIES need declared.
 *
 * `skipLibCheck` is `false` here on purpose, so every `.d.ts` in the tree is
 * checked — and a server dependency's declarations reference web platform
 * types that Node's own do not declare. hono's websocket helper needs
 * `MessageEvent` and `BinaryType`; `@modelcontextprotocol/sdk` needs
 * `HeadersInit`. Without `dom` the generated `api` and `mcp` projects failed
 * their own `pnpm exec kragg check` on the first run, in a project the user
 * had not touched, with three errors inside `node_modules`.
 *
 * `cli` (and `kragg init`, which has no skeleton) deliberately does NOT get
 * `dom`: nothing it depends on needs it, and adding it would let `document`
 * and `window` typecheck in a program that has neither.
 */
function libFor(kind: Kind | null): readonly string[] {
  return kind === "api" || kind === "mcp" ? ["es2023", "dom"] : ["es2023"];
}

/**
 * The type-checking config, and the strictness floor the `typing-strictness`
 * gate verifies.
 *
 * Nothing here is negotiable by an agent trying to make an error go away: the
 * gate reads this file with its `extends` chain resolved, so loosening a flag
 * to pass a typecheck fails a different gate instead.
 */
function tsconfig(kind: Kind | null): string {
  return `{
  "$schema": "https://json.schemastore.org/tsconfig",
  "compilerOptions": {
    "target": "es2023",
    "lib": [${libFor(kind).map((name) => JSON.stringify(name)).join(", ")}],

    /* Real Node ESM resolution. */
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "types": ["node"],

    /* --- The strictness floor. \`kragg check\` verifies every flag below.
       Do not relax one to make an error go away; fix the code. --- */
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitReturns": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noPropertyAccessFromIndexSignature": true,
    "useUnknownInCatchVariables": true,
    "allowUnusedLabels": false,
    "allowUnreachableCode": false,

    /* Emitted imports match the source imports, and every file transpiles on
       its own — required for Node's native type stripping to agree with tsc. */
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "erasableSyntaxOnly": true,
    "forceConsistentCasingInFileNames": true,

    /* Relative imports carry a literal \`.ts\` extension so Node runs the
       sources with no build step. \`rewriteRelativeImportExtensions\` rewrites
       each specifier to \`.js\` on build, so \`dist/\` is correct Node ESM.
       The two flags go together — do not enable one without the other. */
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,

    /* \`skipLibCheck\` hides breakage inside dependency type definitions. We
       check them: a failure there is a real signal about the dependency. */
    "skipLibCheck": false,

    "noEmit": true
  },
  "include": ["src/**/*.ts", "test/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
`;
}

const TSCONFIG_BUILD = `{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    /* Never emit JavaScript that failed to typecheck: a build that ships
       unchecked output has no teeth. */
    "noEmitOnError": true,
    "rootDir": "src",
    "outDir": "dist",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist", "test"]
}
`;

const GITHUB_WORKFLOW = `name: Quality Gates

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      # Every \`uses:\` is pinned to a full commit SHA, and must stay that way.
      #
      # A tag — \`@v4\`, \`@v4.4.0\`, any of them — is a mutable pointer owned by
      # the action's maintainer. Repointing it is a normal git operation, so a
      # tag is a standing authorization to run whatever that account publishes
      # next, with this repository checked out and this job's token in scope.
      # That is the same exposure \`pnpm-workspace.yaml\` spends \`ignoreScripts\`
      # and the 30-day \`minimumReleaseAge\` defending against for npm packages;
      # CI runs on every push, so a mutable tag here would undo the rest.
      #
      # To update one, resolve the tag to its commit and paste the SHA:
      #   gh api repos/<owner>/<repo>/git/ref/tags/<tag> --jq '.object.sha'
      # If that reports \`"type": "tag"\` the tag is annotated and the SHA is
      # the tag object, NOT the commit — dereference it before pinning:
      #   gh api repos/<owner>/<repo>/git/tags/<sha> --jq '.object.sha'
      # Never hand-write a SHA: a wrong-but-plausible one is worse than a tag.
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0
        with:
          node-version-file: .node-version
          cache: pnpm
      # \`ignoreScripts\` and the release cooldown apply here exactly as they do
      # locally: CI must install under the same rules, or CI is the hole.
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec kragg check
`;

/** Claude Code hook registration: the gates run without being asked. */
const CLAUDE_SETTINGS = `{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "pnpm exec kragg hook claude" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "pnpm exec kragg hook claude" }]
      }
    ],
    "SessionStart": [
      {
        "hooks": [{ "type": "command", "command": "pnpm exec kragg hook claude" }]
      }
    ]
  }
}
`;

/** Gemini reads the same contract file, so there is only ever one. */
const GEMINI_SETTINGS = `{
  "contextFileName": "AGENTS.md"
}
`;
