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
  **one** runtime dependency (`typescript`) and **two** dev dependencies
  (`@types/node`, `oxlint`). That is a standing constraint, not a starting
  point.
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

192 modules under `src/`, listed top-down in the order `kragg.json`'s
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
  plus `hookCheck.ts` (the `RunCheck` injected into the hook, which resolves
  the hook's scope through `scope.ts` so the hook and the command check the
  same files), `scope.ts`
  (the one resolver for `full`/`changed`/`file`, shared by `check` and
  `security`: what the external tools are invoked on, what the path-aware
  gates narrow to, when a configuration change makes an incremental run a
  full one, and which unresolvable selections are exit 2 or exit 3),
  `pipeline.ts` (the one runner `check`, `security` and package runs share:
  run the gates, build the report, journal it, render it), `packages.ts`
  (`--package`: one complete run per workspace member — its own root, policy,
  tsconfig, compiler and program — plus the stderr notice a root run prints
  about the members it did not check) and
  `inventory.ts` (the filter and output-budget vocabulary `map`, `spec` and
  `brief` share). The five commands too large for one file have their own
  directory: `map/` (`symbols`, `render`, `select`), `spec/` (`property`,
  `select`), `mutation/` (`targets`, `stryker`, `report`, `baseline`),
  `flaky/` (`reruns` — the active `--rerun N` sweep, and the rule that only a
  completed run of the intended suite counts as a sample), `brief/`
  (`exemptions` — the `## Suppressions` and `## Baseline` sections).
- `src/hooks/` — `claude.ts` (event dispatch; the deliberate fail-**open**
  exception to everything else here, and the module that says which of the
  CLI's scopes an event means, never which files), `protocol.ts` (narrowing
  untrusted stdin, building the stdout JSON the harness reads), `session.ts`
  (the SessionStart context: last run, critical functions, recorded hook
  failures) and `diagnostics.ts` (`.kragg/hook-errors.jsonl` — failing open is
  not failing invisibly; never write the stdin payload there).
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
  three test-depth gates; `testFiles.ts` is the test corpus `test_paths`
  selects, and `references.ts` binds test code in it to critical functions
  through the checker), `typingStrictness/` (config, hatches, included,
  chain, codes). Single-file gates: `criticalCoverage.ts`, `criticalTests.ts`,
  `testQuality.ts`, `typeComplexity.ts`. Each directory has a same-named `.ts`
  beside it that is the public entry point and re-exports the parts.
- `src/adapters/` — external tools turned into violations: `lint.ts`,
  `tsc.ts`, `testRunner.ts`, `audit.ts`, `deadcode.ts`; `linters/` holds the
  oxlint/biome/eslint JSON parsers, `support/` the per-package-manager audit
  parsers, the per-runner test reports, lcov/istanbul readers, the
  `Unavailable` outcome kinds, the `runCommand` helpers, the per-invocation
  artifact directory under `.kragg/runs/` (`testCommands.ts`), WHICH command
  runs the suite and where it came from (`testInvocation.ts` — `test_command`
  or detection, and the provenance sentence that says which) and the messages
  for evidence the test gate refuses (`testEvidence.ts`).
- `src/scaffold/` — `kragg new` / `init` / `gen module`: `project.ts` (the
  engine), `initPlan.ts` (what `init` would change, decided before anything is
  written, so `--dry-run` and the real run cannot disagree), `kinds.ts`,
  `naming.ts`, `agents.ts`, `guardrails.ts`, `supplyChain.ts`, and
  `templates/` (`cli`, `api`, `mcp`, `common`).
- `src/coverage/` — `model.ts` is the one line-coverage model; `istanbul.ts`
  and `lcov.ts` normalize into it; `spans.ts` bounds a function (or a class
  node) from source, keyed the way `criticality.json` spells its name;
  `inventory.ts` is the source files a report is expected to describe, so a
  file the run never loaded counts as uncovered instead of vanishing.
- `src/analysis/` — the two analysis tiers. `compiler.ts` resolves which
  TypeScript compiler to analyze with; `sourceFile.ts` is the syntax tier's
  entry point, built from `walk.ts`, `modulePath.ts` and `imports.ts`;
  `program.ts` is the type-aware tier (one lazy shared `ts.Program`);
  `betweenness.ts` is Brandes' algorithm for the call graph.
- `src/environment/` — the target project's environment as data: `model.ts`,
  `project.ts` (entry point, and `projectTsconfig` — the ONE resolver of which
  tsconfig a run reads, from the policy's `tsconfig`), `bin.ts` (project-local
  binary resolution — never `PATH`, never global, never kragg's own tree),
  `packageManager.ts`, `manifest.ts`, `workspaces.ts` (workspace declarations
  expanded to members, or an honest note about why they could not be),
  `workspacePatterns.ts` (the two small fail-closed grammars that expansion is
  built on: `pnpm-workspace.yaml#packages` and workspace globs), `missing.ts`
  ("not installed" vs. "ran and failed", which decides exit 3 vs. exit 1).
- `src/git/changes.ts` — changed-file detection for `--changed` / `--since`.
- `src/policy/` — `policy.ts` turns a config table into a `KraggPolicy`;
  `source.ts` answers where that table came from (`kragg.json`, then
  `package.json#kragg`, then an empty one) and whether a project declares a
  policy at all, which is what a `--package` member asks before inheriting the
  root's; `readers.ts` holds the narrowing readers it is built from,
  `names.ts` the "did you mean" suggestion they and
  `gates/criticality/declared.ts` share, and `serialize.ts` the `policy show`
  key order that is a contract with Python; `baseline.ts` is the reviewed
  legacy-debt baseline `kragg.json#baseline` names — which gates may be
  recorded (and which never), the line-fingerprint identity, and the
  apply/record/stale logic `check`, the hook and `brief` use.
- `src/util/` — `globs.ts`, `suppress.ts` for
  `// kragg: ignore -- <reason>` (a bare marker is not honoured), and
  `testPaths.ts`, the one answer to what `test_paths` selects: the patterns the
  runner discovers with, the directories a walk starts from, and whether one
  file belongs to the suite.
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
- `test/` — 59 test files using `node:test`, flat, plus `test/fixtures/`
  and one non-test helper, `conformanceContract.ts`. `conformance.test.ts`
  drives the versioned fixtures under `test/fixtures/conformance/` that pin
  the cross-language contract; see `docs/spec-conformance.md`.
  `fixtures/knownDefects.ts` is the known-defect corpus for the metric gates —
  one measured defect per gate plus a clean control — asserted by
  `knownDefects.test.ts`. It exists so a threshold change cannot stop detecting
  a real defect quietly; update it together with `docs/calibration.md`, never
  by deleting an assertion.
- `scripts/` — maintenance tooling, not shipped (`tsconfig.build.json` compiles
  `src` only) but covered by `pnpm run typecheck`. `calibrate.ts` measures the
  metric gates against a list of sample projects; see `docs/calibration.md`.
  `compat.ts` + `compat/` is the compatibility harness: it packs the package,
  installs the TARBALL and exercises the CLI, the published API, the four
  scaffolds and the real external tools. `.github/workflows/compat.yml`
  (blocking; ubuntu + windows × Node 20/22/24) and
  `.github/workflows/external-tools.yml` (advisory, weekly) run exactly these
  commands, so a red row reproduces locally. `compat/manifest.ts` is the one
  definition of "the published entry points" and `test/packaging.test.ts`
  asserts against it on every run.
- `docs/architecture.md`: the ideas behind the module layout. Read it first.
- `docs/dependency-policy.md`: the standing supply-chain policy. Read it
  before touching `package.json`.
- `docs/spec-conformance.md`: the contract with the Python implementation.
- `docs/calibration.md`: what the metric gates' ported thresholds actually do
  on real TypeScript, and how to re-derive the numbers. Read it before
  proposing a threshold change — and note that changing one is a policy and
  conformance decision, not an implementation choice.
- `kragg.json`: this repo's own policy — kragg checks itself with it.
- `pnpm-workspace.yaml`: pnpm settings, including all supply-chain hardening.
  Note that `.npmrc` is NOT where pnpm settings go as of pnpm v11.

Update this section when the repo structure changes.

## Commands

Development requires **Node 24** (see `.node-version`): the tests import
`.ts` files directly and rely on Node's native type stripping, so there is no
build step in the test loop. The *published* package is compiled JavaScript
and supports Node 20+ — asserted, not assumed: `.github/workflows/compat.yml`
installs the packed tarball and runs it on ubuntu and windows across Node 20,
22 and 24. Widening or narrowing `engines.node` means changing that matrix in
the same commit; `test/packaging.test.ts` fails if the two disagree.

### Development

- Install: `pnpm install --ignore-scripts`
- Typecheck: `pnpm run typecheck`
- Build: `pnpm run build` (`tsc -p tsconfig.build.json`)
- Test: `pnpm run test` (`node --test "test/**/*.test.ts"`)
- Run the CLI from source: `node src/cli.ts --help`
- Run the built CLI: `node dist/cli.js --help`
- kragg checks itself: `node dist/cli.js check --all`
- Compatibility (needs a build first; each lane prints what it ran):
  - `node scripts/compat.ts packaged --node <path/to/node>` — pack, install
    the tarball, run the CLI and a typed consumer on THAT Node
  - `node scripts/compat.ts scaffolds` — every `kragg new --kind` output
    installs and passes its own `pnpm exec kragg check`
  - `node scripts/compat.ts tools` — the real vitest/node/bun and
    oxlint/biome/eslint/secretlint against the adapters. Advisory lane; see
    the header of `scripts/compat/tools.ts` for why it is not blocking.

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

`check` and `security` share `--file`, `--format`, `--max-violations`,
`--no-journal` and `--package`; of the two, only `check` takes `--changed`,
`--since`, `--fail-fast`, `--all` and `--update-baseline`. The rest:
`fix --file`; `status --format --last`; `map`/`spec --path --symbol --changed
--limit --all --format`, plus `map --write`; `brief --since --path --limit
--all`; `criticality --write --path`; `mutation --path --since --all
--update-baseline`; `flaky --last --rerun`; `init --dry-run`. The scaffold
commands parse their own argv and carry their own `--help`: `new` takes
`--kind`, `--mcp-sdk`, `--package` and `--allow-shadowing`, and `gen module`
takes `--root`; neither appears in the main usage text.

The three inventories (`map`, `spec`, `brief`) share one filter and budget
vocabulary in `src/commands/inventory.ts`. Its rule is that a display budget
is never a scope: `map` derives the whole criticality graph however narrow the
printed map, `map --write` always persists the complete `.kragg/map.md` (and
refuses the content filters, as `criticality --write --path` does), and a
truncated render always names the total it withheld.

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
