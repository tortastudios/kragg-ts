# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Because kragg's output is consumed by CI jobs and coding agents, two things
count as **breaking** here even though they are not API changes in the usual
sense:

- a change to the report JSON (`schema_version`, key names, value shapes), and
- a change to what an exit code means.

Both are a contract shared with the Python implementation. New *gates* and new
*violation codes* are additive and are not breaking, even though they can turn
a previously green run red — see [Gate additions](#gate-additions) below.

## [Unreleased]

### Fixed

- **TOR-1359** — `tsc` in incremental mode (`--changed`, `--file`, and
  therefore the Claude PostToolUse hook) no longer hides type errors outside
  the selected files. The whole project was already compiled through its own
  `tsconfig.json`, but every diagnostic whose file was not in the selection was
  dropped — including the error in `b.ts` that an edit to `a.ts` introduced, so
  the gate reported `[PASS] tsc` and exit 0 while `tsc -p tsconfig.json` was
  failing. Nothing is dropped now: the whole-project verdict is the verdict.
  Diagnostics with no file come first, then those in the selected files, then
  the rest, and the report's existing dedupe and per-gate cap handle volume.
- **TOR-1358**: a gate that SKIPS no longer counts as a failure in the
  pipeline. A visible skip is `passed: false, skipped: true`, so one gate
  stepping aside from inside its own run — no secret scanner installed, no
  linter, no test files, no git repository — skipped every slow gate with
  `static gates failed` and reported a green run that had never executed the
  tests or the audit. On this repo, `kragg check` printed 14 passed, 0 failed
  and exit 0 with `test-coverage`, `critical-coverage` and `audit` all
  suppressed. Only a gate that ran and did not pass now halts the slow tier or
  `--fail-fast`; `error: true` still counts, and exit 3 still outranks
  everything. (`crag/spec/SPEC.md` §2.3, §4.1.)
- **TOR-1358**: a gate whose `run` throws is now reported as that gate's
  `error: true` (exit 3) with the exception's message in `raw_output`, instead
  of propagating out of the pipeline and destroying the consolidated report.
  The remaining gates still run, the report and the journal entry still list
  every gate, and the exception is not swallowed.
- **TOR-1362:** `kragg init` no longer changes what an existing project means.
  It previously merged `"type": "module"`, `engines`, `packageManager` and
  `private` into any `package.json` — turning a CommonJS project into ESM,
  where `require()` of the project's own files then fails — and wrote a default
  `kragg.json` even when the project configured kragg in `package.json#kragg`.
  Since a standalone `kragg.json` wins outright over the embedded table, that
  replaced the project's policy with weaker defaults: stricter thresholds,
  `forbidden_calls` entries and non-default `source_paths` all stopped
  applying. `init` now withholds those four manifest keys from a manifest that
  already exists, creates `kragg.json` only when the project states no policy
  at all, leaves an existing `kragg.json` untouched rather than merging
  defaults into it, and names the source and test directories that actually
  exist instead of asserting `src/` and `test/`. Every file and key it leaves
  alone is reported with the reason.
- TOR-1380: `docs/spec-conformance.md` no longer claims the spec "is still not
  created" or describes the conformance suite in the conditional. It has
  existed since crag `f76a7d03` (2026-08-07).
- TOR-1360: `test-coverage` and `critical-coverage` accept only complete
  evidence from the current invocation. The runner writes into a private
  `.kragg/runs/` directory created for the run (so concurrent runs cannot read
  each other's artifacts); a runner that crashes, is killed by the timeout, or
  leaves a partial report (truncated JSON, an lcov ending inside a record, TAP
  with no summary) is `error: true` / exit 3 — previously a stale
  `.kragg/test-report.json` or `coverage/coverage-final.json` from an earlier
  run could pass the gate. Green tests with no usable coverage artifact are
  likewise an error (with any test failures still listed), not a plain
  failure. `critical-coverage` now consumes the coverage `test-coverage` just
  measured instead of re-reading disk, so switching from vitest to `node
  --test`/`bun test` can no longer select the older istanbul report over this
  run's lcov. The coverage artifact is published to `coverage_report_path`
  afterwards for `kragg coverage`. `kragg mutation` refuses to start Stryker
  while an earlier report it could not remove is still at the report path.
- **TOR-1364: coverage completeness is reconciled against the project, and
  unavailable evidence is an error.** Three ways a coverage gate could report
  green without having looked are closed. (1) A critical function whose file
  the test run never loaded had no entry in the coverage report and therefore
  no uncovered lines: it passed `critical-coverage`. It is now a violation
  with its own code, `critical-unmeasured`, whose message states the cause —
  `the test run never loaded src/x.ts (no entry in the coverage report)`, a
  name the source could not disambiguate, or a body the report is silent on
  — and `kragg coverage` lists the same rows under the same words instead of
  `no coverage entry`. (2) The `test-coverage` percentage counted only the
  files present in the report, so a project whose tests imported three of
  forty modules could report 100%; every TypeScript file under
  `source_paths` the report does not mention now counts with all of its
  statement lines uncovered (the count is read from the source with the
  project's compiler, and the gate's output names the files: `3 of 5 source
  files never loaded by the test run, counted as uncovered (6 statement lines
  read from the source): …`), files outside `source_paths` no longer move
  the number, and a report that leaves no line to count under the source
  paths is an error rather than 100%. (3) `critical-coverage` handed a report
  naming no file under the source paths treated every critical function as
  unmeasured; it is now `error: true` (exit 3) naming what was expected.
  Attribution is exact where it used to decline: two classes with a
  same-named method (`Reader.close`/`Writer.close`) each get their own
  extent from the source, keyed the way `criticality.json` spells the name,
  so neither is blamed for the other's lines and neither slips through as
  unmeasured; overload signatures are no longer mistaken for a name bound
  twice; a class that is itself a critical node (`new Foo()` on a class with
  no constructor) is measured by its own lines and V8's field-initializer
  record, never by its methods' lines. All of this is **line** coverage; no
  message implies a branch verdict.
- **TOR-1364: `kragg coverage` reads the artifact the project's own runner
  publishes.** It read `coverage/coverage-final.json` or `.kragg/…` and then
  `coverage/lcov.info`, ignoring `coverage_report_path` entirely — so with a
  custom path it printed `no coverage data` on a project that had plenty, and
  after a switch from vitest to `node --test` it preferred the stale istanbul
  file over this run's tracefile. It now detects the runner the way the gate
  does and reads exactly one file: `coverage_report_path` for vitest, the
  `lcov.info` beside it for node and bun. A missing file still prints
  `cmd_coverage`'s line and exits 0, followed by the path that was expected;
  a file that is present but unusable — truncated, not JSON, naming no file
  under the source paths — is exit 3 with the file named, never
  `no coverage data`; a project with no runner is exit 3, since nothing
  publishes coverage for it.
- **TOR-1361: `.kragg/criticality.json` keeps the complete eligible
  population.** `analyze` truncated its result to the twenty riskiest
  functions, and since both `kragg criticality --write` and the check
  pipeline's derive-with-cache persist exactly what it returns, a *display*
  limit was silently capping *enforcement*: on this repo `critical-tests`,
  `test-quality`, `critical-coverage` and `kragg mutation`'s criticality
  scoping saw 4 of 108 eligible critical functions. The analysis is now
  complete and the twenty-row limit applies only where a human reads it —
  `CRITICALITY.md` and the terminal table. The sidecar's record shape, key
  order and ranking are unchanged; only the number of records grows. The
  `topN` option is gone rather than raised, so enforcement cannot be capped
  again. This is a new divergence from Python, which truncates the analysis
  itself; see the divergence tables in `README.md` and
  `docs/spec-conformance.md`.

### Added

- TOR-1363: `kragg.schema.json`, shipped in the package, mirrors the keys,
  types and ranges the loader enforces so an editor can validate `kragg.json`
  (`"$schema": "./node_modules/kragg/kragg.schema.json"`); `$schema` is
  accepted by the loader as the one non-setting key. A test keeps schema and
  loader in lockstep; no validator dependency is involved.
- **TOR-1362:** `kragg init --dry-run` prints the exact changes `init` would
  make — files to create, keys to add, files and keys skipped and why — and
  writes nothing, not even the target directory. The plan it prints is the
  same one the real run applies, so the two cannot drift apart.
- **TOR-1362:** `kragg init` refuses a read-only target before its first write
  (exit 2, one line, nothing written) instead of failing part way through with
  an uncaught `EACCES` and exit 1.
- TOR-1380: executable conformance checks against the Python sibling. The
  sibling grew a normative `spec/` in its 0.9.0 release, so
  `.github/workflows/ci.yml`'s `TODO(spec)` is now a real `conformance` job: it
  checks `tortastudios/crag` out at the **pinned full commit SHA**
  `f76a7d0321ca6498d5c00653c493aa5ffdf2383d`, runs `spec/run_conformance.py`
  against `dist/cli.js`, and then runs this repo's own fixtures. Seven
  versioned fixtures live in `test/fixtures/conformance/`, driven by
  `test/conformance.test.ts` (`pnpm run conformance`), covering the report
  fields and their nulls, exit codes 0/1/2/3, skipped and errored gates, the
  journal as a reader and a writer, `.kragg/criticality.json` and its sidecar,
  and the `hook claude` protocol. Each fixture records the spec revision it was
  taken against and, where the two implementations deliberately differ, an
  explicit divergence record instead of a normalization.
  `docs/spec-conformance.md` is rewritten around what now exists: where the
  spec lives, how to run both suites, every normalization rule and its
  justification, the divergence table, and the recorded drift on both sides.

### Changed

- TOR-1363: malformed policy is rejected instead of silently becoming a
  default. A wrong-typed value (`"max_file_lines": "100"`), an out-of-range
  budget, a list with a non-string element, a `forbidden_calls` hint that is
  not a string, a `package.json#kragg` that is not an object, and any key
  kragg does not know are all exit 2 with a message naming the file and the
  setting (`kragg.json#forbidden_calls[1] must be a string (got 7)`; unknown
  keys suggest the nearest setting). Absent keys still take the defaults;
  explicit opt-outs (`[]`, `{}`, `0`, `null`, `"off"`) load exactly as
  written. Previously a ban list written as `["node:child_process", 7]`
  loaded as *no bans* and a misspelled key configured nothing, with no error
  in either case.

## [0.0.0] — unreleased

Initial implementation. Not published to npm.

### Added

**The engine and its contract**

- `kragg check` / `kragg security`, running a fixed pipeline of 18 gates in two
  tiers. All fast gates run even after one fails, so a single invocation
  surfaces every failure; slow gates skip once a fast gate has failed.
- Exit codes `0` pass / `1` violations / `2` usage or config error / `3`
  environment broken. Exit 3 outranks exit 1.
- `--format json` emitting `schema_version` 1 with snake_case keys, matching
  the Python implementation byte for byte.
- `.kragg/history.jsonl` run journal, and `kragg status` to read it back.

**Native gates** (no external tool, built on the TypeScript compiler API)

- `typing-strictness` — audits that `tsconfig.json` meets the strict floor,
  carries no escape hatches (`@ts-ignore`, `as any`, double casts,
  `@ts-nocheck`), **and covers every source file**.
- `complexity`, `maintainability`, `halstead` — radon's metrics over the
  TypeScript AST.
- `type-complexity` — annotation nesting and length budgets.
- `boundaries` — the layered import contract, resolving tsconfig `paths`
  aliases and following barrel re-export chains.
- `structure` — file-length and public-symbol budgets, enumerating `export *`.
- `forbidden-calls` — project-banned APIs resolved through `ts.TypeChecker`.
- `nullable-default` — `||` mis-coalescing a legitimate `0` / `""` / `false`.
- `secret-default` — secrets given silent fallback values.
- `critical-tests`, `test-quality`, `critical-coverage` — the test-depth gates.

**External tool adapters**, each resolved from the project's own
`node_modules/.bin` and skipping visibly with an install command when absent

- `lint` — oxlint, biome or eslint, auto-detected from project config.
- `tsc` — the project's own compiler.
- `test-coverage` — vitest, `node --test` or `bun test`; istanbul JSON and lcov.
- `audit` — npm, pnpm, yarn or bun.
- `detect-secrets` — gitleaks or secretlint. **No scanner is bundled.**

**Commands**

- `map`, `spec`, `brief`, `coverage`, `criticality`, `mutation`, `flaky`,
  `audit`, `doctor`, `policy show`, `fix`.
- `new` (`cli` | `api` | `mcp`), `gen module`, `init`.
- `hook claude` — reads hook JSON on stdin; fails open by design.

### Deliberate divergences from the Python implementation

Each is documented at the site, and collected in `README.md`.

- `forbidden-calls` resolves through the type checker, so subclass overrides,
  unannotated receivers and re-export chains are caught.
- `nullable-default` is a redesign; `.get(k, default)` has no JS analogue.
- Cyclomatic complexity scores a `switch` **once**, not once per `case`, on
  measured evidence that flat dispatch tables were failing the gate without
  being complex.
- `structure` counts real `export` declarations rather than a
  leading-underscore convention.
- `secret_name_suffixes` includes `ServiceKey`.
- Criticality data carries a sidecar freshness stamp so stale call-graph data
  is re-derived rather than trusted. `criticality.json` itself stays readable
  by the Python implementation.

### Known limitations

Stated in full in [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). The short
version: complexity thresholds are Python's and were never recalibrated;
`nullable-default` is high-precision and low-recall by design; scaffold
templates for hono, fastmcp and `@modelcontextprotocol/sdk` were never
compiled; Stryker's handshake has never been executed; Windows is untested.

### Supply chain

- One runtime dependency (`typescript`) and one dev dependency
  (`@types/node`), both pinned to exact versions. No bundler, no test
  framework.
- pnpm pinned via corepack, dependency lifecycle scripts disabled, empty build
  allowlist, and a 30-day minimum release age enforced mechanically.

---

## Gate additions

A new gate, or a new violation code on an existing gate, can turn a
previously green run red without anything in your code changing. That is the
tool working, not a regression — but it is disruptive, so:

- New gates and codes are listed in the release notes, always.
- A new gate that requires configuration **skips visibly** until configured,
  rather than failing a project that has not opted in.
- Existing violation codes are not repurposed. If the meaning of a check
  changes, it gets a new code.
