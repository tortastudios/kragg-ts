# AGENTS.md

## Mission

This repository builds `kragg`, an opinionated guardrails framework and CLI
for AI-assisted TypeScript projects. It is the JS/TS sibling of the Python
`kragg` (`tortastudios/crag`) and must stay conformant with it — see
`docs/spec-conformance.md`.

Optimize changes for correctness, safety, and minimal disruption to the
public CLI/package behavior.

## Priority Order

When tradeoffs conflict, use this order:

1. Correctness.
2. Data safety.
3. Minimal diff.
4. Existing project conventions.
5. Performance.
6. Elegance.

Do not optimize for elegance by expanding scope. Do not optimize for
performance unless the task is performance-related or a measured bottleneck
exists.

## Operating Rules

- Do exactly what the user asked.
- Prefer small, local changes.
- Prefer modifying existing functions over adding helper layers when the
  change is local.
- Preserve existing architecture unless explicitly asked to change it.
- Read nearby code before editing.
- Match existing naming, structure, typing, and error-handling patterns.
- Do not refactor unrelated code.
- Do not rewrite unrelated files.
- Do not reformat untouched files.
- Preserve public APIs and CLI behavior unless the task explicitly requires
  changing them.
- Do not introduce new abstractions unless they remove duplicated behavior in
  the changed files.
- When blocked, report the blocker and propose the smallest next step.

## Hard Rules — no exceptions, no agent discretion

These override every other instruction in this file. Violating one is a
failed task, not a judgement call.

- **Do not add any dependency** — runtime or dev — without explicit written
  human approval. Read `docs/dependency-policy.md` first. There is exactly
  **one** runtime dependency (`typescript`) and **one** dev dependency
  (`@types/node`). That is a standing constraint, not a starting point.
- **Do not run dependency lifecycle scripts.** Never `pnpm approve-builds`,
  never add to `allowBuilds`, never set `dangerouslyAllowAllBuilds`. Install
  with `pnpm install --ignore-scripts`.
- **Do not use `npm install`, `yarn`, or `bun`** for installs here. pnpm only.
- **Do not unpin or loosen a version.** No `^`, no `~`, no `latest`.
- **Do not weaken `tsconfig.json`.** Every strictness flag there is load-
  bearing: this project dogfoods its own `typing-strictness` gate, which
  audits `<root>/tsconfig.json` on every run.
  Fix the code, do not relax the compiler. That includes not adding
  `skipLibCheck`, not adding `// @ts-ignore`, and not widening a type to
  `any` to clear an error.
- **Never spawn a subprocess with a shell.** `src/engine/runner.ts` is the
  only approved place to spawn anything, and it passes an argv array with
  `shell: false`. Do not import `node:child_process` elsewhere; do not use
  `exec`/`execSync`; do not build a command by string concatenation.
- **Never report a passing gate that did not run.** A gate that could not
  run is `error: true` and exit **3** — never a pass, and never omitted. A
  gate with nothing configured is `skipped: true` with a reason that names
  the command to un-skip it. Collapsing either into a pass is the one failure
  this whole codebase exists to prevent. (`PENDING` in `src/cli.ts` is empty:
  every advertised command is implemented. Anything added there exits 2 and
  says "not implemented" rather than pretending.)
- **Never `import ts from "typescript"` in a gate.** Call
  `resolution.api.*` from the compiler `resolveTypeScript` picked for the
  project. `SyntaxKind` values, flag bitmasks and node shapes are internal to
  a compiler build and are *not* stable across versions, so a
  bundled-compiler predicate applied to a project-compiler node is silently,
  confidently wrong. `src/analysis/compiler.ts` holds the only value import
  of `typescript` in the codebase; everywhere else it is `import type`.
- **Relative imports carry a literal `.ts` extension**, never `.js`.
  `rewriteRelativeImportExtensions` (with `allowImportingTsExtensions`) in
  `tsconfig.json` rewrites them to `.js` on emit, so the same specifier works
  under Node's type stripping in the test loop and in the built output.
  Writing `.js` in source breaks the former.
- **One `ts.Program` per run, built lazily.** `catalog/context.ts` creates
  the handle; `analysis/program.ts` builds the program on the first `load()`.
  A run that touches no type-aware gate must never build one. Do not create a
  program inside a gate.
- **The wire format does not move.** `Violation`/`GateResult` field names,
  `schema_version` 1, the snake_case JSON payload, `.kragg/history.jsonl` and
  exit codes 0/1/2/3 are a cross-language contract with kragg-Python. Changing
  any of them is a change to both repos plus a `schema_version` bump. See
  `docs/spec-conformance.md`.
- **500 lines per file, comments included.** The `structure` gate counts
  total lines. Split the module; do not thin the documentation, and do not
  add to `structure_exclude` to get under the budget.

## Project Map

166 modules under `src/`, listed top-down in the order `kragg.json`'s
`layers` declares — a module may import its own layer or a lower one, never a
higher one, and the `boundaries` gate enforces that on this repo.

- `src/index.ts` — the package's public API surface: models, the gate engine,
  the report/payload types, the journal, `runCommand`, the policy, the
  environment. Keep it small; the `structure` symbol budget is spent here,
  and `structure_exclude` exempts this one file.
- `src/cli.ts` — argument parsing and dispatch (`node:util` `parseArgs`), the
  per-command allowed-flag and positional tables, and the validation that makes
  an accepted argument one that acts. `PENDING` is empty. `src/cli/usage.ts`
  holds the `--help` text, which is a contract with those tables and is checked
  against them by `test/cli.test.ts`.
- `src/commands/` — one module per command: `check`, `security`, `fix`,
  `map`, `spec`, `brief`, `status`, `policyShow`, `doctor`, `coverage`,
  `criticality`, `mutation`, `flaky`, `audit`, `new`, `gen`, `init`, `hook`,
  plus `hookCheck.ts` (the `RunCheck` injected into the hook). The three
  commands too large for one file have their own directory: `map/`
  (`symbols`, `render`), `spec/` (`property`), `mutation/` (`targets`,
  `stryker`, `report`, `baseline`).
- `src/hooks/` — `claude.ts` (event dispatch; the deliberate fail-**open**
  exception to everything else here) and `protocol.ts` (narrowing untrusted
  stdin, building the stdout JSON the harness reads).
- `src/catalog.ts` + `src/catalog/` — the only place that knows which gates
  exist, in what order, in which tier. `check.ts` is the `check` pipeline,
  `security.ts` the gates shared by both pipelines, `context.ts` the per-run
  `CatalogContext` (root, policy, env, the one lazy program, the criticality
  cache, and `evidence` — what `test-coverage` produced this run, which
  `critical-coverage` reads instead of the disk), `results.ts` the translation
  from each gate's own outcome shape into `GateResult`, `criticalityCache.ts`
  the derive-with-cache.
- `src/gates/` — the built-in checks. A directory per gate large enough to
  split: `architecture/` (layers, structure, aliases, barrels, star exports),
  `complexity/` (cyclomatic, maintainability, lines, grades), `criticality/`
  (register, graph, profile, report, scope, freshness, declared),
  `forbiddenCalls/`
  (scan, resolver, symbols, rules, declarationPath), `halstead/` (walk,
  partition, metrics, blocks, report), `nullableDefault/`, `secretDefault/`,
  `secrets/` (gitleaks, secretlint, lookup), `testDepth/` (shared by the
  three test-depth gates), `typingStrictness/` (config, hatches, included,
  chain, codes). Single-file gates: `criticalCoverage.ts`, `criticalTests.ts`,
  `testQuality.ts`, `typeComplexity.ts`. Each directory has a same-named `.ts`
  beside it that is the public entry point and re-exports the parts.
- `src/adapters/` — external tools turned into violations: `lint.ts`,
  `tsc.ts`, `testRunner.ts`, `audit.ts`, `deadcode.ts`; `linters/` holds the
  oxlint/biome/eslint JSON parsers, `support/` the per-package-manager audit
  parsers, the per-runner test reports, lcov/istanbul readers, the
  `Unavailable` outcome kinds, the `runCommand` helpers, the per-invocation
  artifact directory under `.kragg/runs/` (`testCommands.ts`) and the
  messages for evidence the test gate refuses (`testEvidence.ts`).
- `src/scaffold/` — `kragg new` / `init` / `gen module`: `project.ts` (the
  engine), `initPlan.ts` (what `init` would change, decided before anything is
  written, so `--dry-run` and the real run cannot disagree), `kinds.ts`,
  `naming.ts`, `agents.ts`, `guardrails.ts`, `supplyChain.ts`, and
  `templates/` (`cli`, `api`, `mcp`, `common`).
- `src/coverage/` — `model.ts` is the one line-coverage model; `istanbul.ts`
  and `lcov.ts` normalize into it; `spans.ts` bounds a function from source.
- `src/analysis/` — the two analysis tiers. `compiler.ts` resolves which
  TypeScript compiler to analyze with; `sourceFile.ts` is the syntax tier's
  entry point, built from `walk.ts`, `modulePath.ts` and `imports.ts`;
  `program.ts` is the type-aware tier (one lazy shared `ts.Program`);
  `betweenness.ts` is Brandes' algorithm for the call graph.
- `src/environment/` — the target project's environment as data: `model.ts`,
  `project.ts` (entry point), `bin.ts` (project-local binary resolution —
  never `PATH`, never global, never kragg's own tree), `packageManager.ts`,
  `manifest.ts`, `workspaces.ts`, `missing.ts` ("not installed" vs. "ran and
  failed", which decides exit 3 vs. exit 1).
- `src/git/changes.ts` — changed-file detection for `--changed` / `--since`.
- `src/policy/` — `policy.ts` loads `kragg.json`, then `package.json#kragg`,
  then defaults; `readers.ts` holds the narrowing readers it is built from.
- `src/util/` — `globs.ts`, and `suppress.ts` for `// kragg: ignore`.
- `src/engine/` — the bottom layer, importable by everything:
  - `models.ts` — `Violation`, `GateResult`, `CompletedCommand`,
    `ProjectContext` as plain interfaces.
  - `gate.ts` — `GateSpec`, `runGates`, `FAST`/`SLOW`, skip/halt semantics.
  - `report.ts` — dedupe, caps, exit codes; re-exports the payload and
    renderer modules.
  - `reportPayload.ts` — **the cross-language wire format.** The only place
    camelCase becomes snake_case.
  - `reportRender.ts`, `reportMeta.ts` — text/JSON rendering, and run metadata.
  - `journal.ts` — `.kragg/history.jsonl`, append-only.
  - `runner.ts` — the only approved external-command wrapper, and the one
    legitimate `node:child_process` import in the repo.
- `test/` — 46 test files using `node:test`, flat, plus `test/fixtures/`
  and one non-test helper, `conformanceContract.ts`. `conformance.test.ts`
  drives the versioned fixtures under `test/fixtures/conformance/` that pin
  the cross-language contract; see `docs/spec-conformance.md`.
- `docs/architecture.md`: the ideas behind the module layout. Read it first.
- `docs/dependency-policy.md`: the standing supply-chain policy. Read it
  before touching `package.json`.
- `docs/spec-conformance.md`: the contract with the Python implementation.
- `kragg.json`: this repo's own policy — kragg checks itself with it.
- `pnpm-workspace.yaml`: pnpm settings, including all supply-chain hardening.
  Note that `.npmrc` is NOT where pnpm settings go as of pnpm v11.

Update this section when the repo structure changes.

## Commands

Development requires **Node 24** (see `.node-version`): the tests import
`.ts` files directly and rely on Node's native type stripping, so there is no
build step in the test loop. The *published* package is compiled JavaScript
and supports Node 20+.

### Development

- Install: `pnpm install --ignore-scripts`
- Typecheck: `pnpm run typecheck`
- Build: `pnpm run build` (`tsc -p tsconfig.build.json`)
- Test: `pnpm run test` (`node --test "test/**/*.test.ts"`)
- Run the CLI from source: `node src/cli.ts --help`
- Run the built CLI: `node dist/cli.js --help`
- kragg checks itself: `node dist/cli.js check --all`

Use the narrowest relevant command first. Run typecheck and test before
claiming completion.

### The CLI surface

Every command below is implemented. `node dist/cli.js --help` is the
authority; this list must match it.

| Command | What it does |
| --- | --- |
| `check` | the whole quality pipeline, one consolidated report |
| `security` | the security subset only |
| `fix` | format and safely fix lint findings |
| `map` | exported symbols, so nothing gets reinvented |
| `spec` | the test suite rendered as a documentation tree |
| `brief` | a reviewable digest of the change set |
| `status` | recent run history, without re-running |
| `policy show` | the effective policy, after defaults and overrides |
| `doctor` | is this project set up so the gates can run? |
| `coverage` | uncovered lines in critical functions, ranked by fan-in |
| `criticality` | call-graph risk -> `CRITICALITY.md` + `.kragg/criticality.json` |
| `mutation` | mutation-test critical files with Stryker |
| `flaky` | gates that flipped on an unchanged commit |
| `audit` | dead code and dependency drift |
| `new <name>` | scaffold a project (`--kind cli\|api\|mcp`) |
| `gen module <n>` | service/domain/test slots in the layered layout |
| `init` | add guardrails to an existing project |
| `hook claude` | hook adapter; reads hook JSON on stdin |

`check` and `security` share `--file`, `--format`, `--max-violations` and
`--no-journal`. `--changed`, `--since`, `--fail-fast` and `--all` are
`check`-only. The rest: `fix --file`; `status --format --last`; `map --write`;
`brief --since`; `criticality --write --path`; `mutation --path --since --all
--update-baseline`; `flaky --last --rerun`.

Everything the CLI accepts must act, and `--help` (`src/cli/usage.ts`) is the
list of what it accepts — `test/cli.test.ts` walks the help text against the
per-command table. Exit 2, never a silent no-op, for: a flag the command does
not accept, a `--format` other than `text`/`json`, a count that is not a
non-negative integer, a positional the command has no use for, `--file`
alongside `--changed`/`--since`, and `criticality --write --path` (a scoped
`criticality.json` would read downstream as "everything else is uncritical").

## Conventions

- ESM only. Every relative import — in `src/` and in `test/` alike — carries
  a literal `.ts` extension. See the hard rule above; `.js` in source is a
  bug, not a style choice.
- Type-only imports use `import type` — `verbatimModuleSyntax` requires it.
  `erasableSyntaxOnly` is on, so no enums and no parameter properties.
- Domain types are camelCase; the JSON wire format is snake_case. The
  translation happens in `src/engine/reportPayload.ts` and nowhere else.
- Data types are plain `interface`s, not classes, so every value is
  JSON-serializable and structurally cloneable. Behaviour lives in free
  functions.
- Config is data (JSON), never executable. There is no `kragg.config.ts` and
  there will not be one.
- Fail closed. A malformed config value is rejected by name (`PolicyError`,
  exit 2) and never silently drops a restriction; an absent key takes the
  default, a configured opt-out (`[]`, `0`, `null`, `"off"`) is honoured.
