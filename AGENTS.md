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
  human approval. Read `docs/dependency-policy.md` first. Zero runtime
  dependencies is a design constraint, not a current state of affairs.
- **Do not run dependency lifecycle scripts.** Never `pnpm approve-builds`,
  never add to `allowBuilds`, never set `dangerouslyAllowAllBuilds`. Install
  with `pnpm install --ignore-scripts`.
- **Do not use `npm install`, `yarn`, or `bun`** for installs here. pnpm only.
- **Do not unpin or loosen a version.** No `^`, no `~`, no `latest`.
- **Do not weaken `tsconfig.json`.** Every strictness flag there is load-
  bearing: this project dogfoods its own future `typing-strictness` gate.
  Fix the code, do not relax the compiler. That includes not adding
  `skipLibCheck`, not adding `// @ts-ignore`, and not widening a type to
  `any` to clear an error.
- **Never spawn a subprocess with a shell.** `src/engine/runner.ts` is the
  only approved place to spawn anything, and it passes an argv array with
  `shell: false`. Do not import `node:child_process` elsewhere; do not use
  `exec`/`execSync`; do not build a command by string concatenation.
- **Never report a passing gate that did not run.** Stubs exit 2 and say
  "not implemented". A tool that reports green before it can check anything
  is worse than no tool.

## Project Map

- `src/cli.ts`: CLI argument parsing and dispatch (`node:util` `parseArgs`).
  Currently `check`/`status` are honest not-implemented stubs.
- `src/index.ts`: the package's public API surface. Keep it small.
- `src/engine/models.ts`: shared result/context data types (`Violation`,
  `GateResult`, `CompletedCommand`, `ProjectContext`) as plain interfaces.
- `src/engine/gate.ts`: gate pipeline engine — `GateSpec`, `runGates`,
  `FAST`/`SLOW` tiers, and the skip/halt semantics.
- `src/engine/report.ts`: consolidated reports, the JSON wire schema, text
  rendering, violation dedupe/caps, and exit codes. **This file is the
  cross-language contract.**
- `src/engine/journal.ts`: `.kragg/history.jsonl` append-only run journal.
- `src/engine/runner.ts`: the only approved external-command wrapper.
- `src/environment/project.ts`: package-manager detection, project-local
  binary resolution, workspace detection. Interfaces and TODOs only.
- `src/policy/policy.ts`: `kragg.json` / `package.json#kragg` policy loading.
- `src/gates/`: built-in guardrail checks. Empty — this is the next
  substantial piece of work.
- `test/`: focused unit tests using `node:test`.
- `docs/dependency-policy.md`: the standing supply-chain policy. Read it
  before touching `package.json`.
- `docs/spec-conformance.md`: the contract with the Python implementation.
- `pnpm-workspace.yaml`: pnpm settings, including all supply-chain hardening.
  Note that `.npmrc` is NOT where pnpm settings go as of pnpm v11.

Update this section when the repo structure changes.

## Commands

Development requires **Node 24** (see `.node-version`): the tests import
`.ts` files directly and rely on Node's native type stripping, so there is no
build step in the test loop. The *published* package is compiled JavaScript
and supports Node 20+.

- Install: `pnpm install --ignore-scripts`
- Typecheck: `pnpm run typecheck`
- Build: `pnpm run build`
- Test: `pnpm run test`
- Run the CLI from source: `node src/cli.ts --help`
- Run the built CLI: `node dist/cli.js --help`

Use the narrowest relevant command first. Run typecheck and test before
claiming completion.

## Conventions

- ESM only. Relative imports in `src/` carry an explicit `.js` extension;
  imports in `test/` that reach into `src/` carry `.ts` (see the comment in
  `tsconfig.json`).
- Type-only imports use `import type` — `verbatimModuleSyntax` requires it.
- Domain types are camelCase; the JSON wire format is snake_case. The
  translation happens in `src/engine/report.ts` and nowhere else.
- Data types are plain `interface`s, not classes, so every value is
  JSON-serializable and structurally cloneable. Behaviour lives in free
  functions.
- Config is data (JSON), never executable. There is no `kragg.config.ts` and
  there will not be one.
- Fail closed. A malformed config degrades to the stricter default and never
  silently drops a restriction.
