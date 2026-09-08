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

### Added

- **TOR-1376** — metric-gate calibration on representative TypeScript
  projects, and a regression net so the result cannot be undone quietly.
  `scripts/calibrate.ts` measures `complexity`, `maintainability`, `halstead`,
  `type-complexity` and `nullable-default` against a list of sample roots by
  calling the same gate entry points `check` calls, and reports the population
  each violation count came out of — violation rates, order statistics,
  distribution buckets and per-finding distance from the budget — as JSON or a
  markdown table. It adds no dependency and spawns nothing except `git
  rev-parse` through the approved runner.
  [`docs/calibration.md`](docs/calibration.md) records a dated run over a CLI,
  a Next.js application, a pnpm workspace and the three scaffolds (472
  application files, 3,025 blocks, 3,099 annotation sites), with a per-finding
  precision assessment, suppression frequency and remediation cost.
  `test/fixtures/knownDefects.ts` and `test/knownDefects.test.ts` hold one
  measured defect per metric gate plus a clean control, so a future threshold
  change that stops detecting any of them fails the suite instead of passing
  quietly. `KNOWN_LIMITATIONS.md` now states the measured precision limits —
  chiefly that `??`/`?.` supply 12–19% of a TypeScript cyclomatic score, that
  roughly a third of a React score is JSX rendering, that Halstead counts
  static markup and a block's nested closures, and that the type-aware tier
  sees one tsconfig and so covers a workspace only in part.
  **No threshold, grade band, profile or default was changed**: the proposals
  the measurements support are written up in `docs/calibration.md` and marked
  as not applied, because each one is a number Python kragg also ships.
- **TOR-1375** — the agent-facing inventories are focused and bounded.
  `kragg map` and `kragg spec` on this repository printed 94,729 and 86,284
  characters, with no way to ask for one directory, one symbol or just what
  changed — an inventory too expensive to read is one an agent skips, which is
  the reinvention `map` exists to prevent arriving through the back door.
  `map`, `spec` and `brief` now take `--path <p>` (repeatable file or
  directory prefixes); `map` and `spec` also take `--symbol <name>` (for
  `map`, an exported name, `Class.method`, or the exact `<module>#<name>`; for
  `spec`, a case-insensitive substring of a test or `describe` title) and
  `--changed` (files changed against `HEAD`, through the same
  `src/git/changes.ts` `check --changed` uses — outside a repository it is
  exit 3 and a message, never an empty inventory). All three take `--limit
  <n>`, defaulting to 100 entries, with `--limit 0` or `--all` for the
  deliberate full export; `map` and `spec` also take `--format text|json`,
  which carries `total`, `shown` and `truncated` beside the entries. Ordering
  is deterministic — by path then name for `map`, by path then source order
  for `spec` — so the JSON entry order is the text order and two runs over one
  tree are byte-identical. The default `map` is now 11,536 characters and the
  default `spec` 6,977.

  **A display budget is never a scope.** A truncated text render ends with
  `showing N of M … — pass --limit 0 for everything`; `map` still derives the
  whole project's criticality graph however narrow the printed map, so no gate
  can be quietened by asking for less; `map --write` always writes the
  complete `.kragg/map.md` and refuses `--path`, `--symbol` and `--changed`
  outright (a scoped map injected at session start reads as "nothing else
  exists", the same reasoning as `criticality --write --path`), while
  `--limit` is allowed and trims only the terminal. An empty selection prints
  "no symbols/tests match the selection" and exits 0, distinct from a project
  that has none; in JSON it is a valid object with `total: 0`.

  `kragg brief` now says where its gate section comes from: `## Last gate run`
  is labelled as a summary of `.kragg/history.jsonl` that was not re-run for
  the brief, and it states when the recorded verdict was reached at another
  commit, against an unidentifiable one, or on a dirty tree — so a stale
  `PASS` above a list of changed files can no longer be read as "this change
  set was checked". No change to the report JSON, the criticality sidecar or
  any exit code.

### Fixed

- **TOR-1366** — criticality freshness and compiler state are now invalidated
  by everything the analysis actually reads. Three separate ways a run could
  believe pre-edit state:
  - The freshness walk kept its own skip list and applied `dist`, `build`,
    `out` and `coverage` **by name at any depth**, so this repo's own
    `src/coverage/` was invisible to it: editing, adding or deleting a file
    under such a directory left `.kragg/criticality.json` reading `fresh`. It
    now uses the same `analysis/walk.ts` the syntax tier does, which skips
    those names only where they mean "generated" — as children of the repo
    root.
  - The fingerprint was a file count, a byte total and the newest mtime, so a
    same-size edit made by a tool that preserves timestamps changed none of
    them. It is now a **content hash** of every walked file (measured at ~6 ms
    over this repo's 214 source and test files, up from ~1 ms, against the ~1 s
    a graph rebuild costs), plus `kragg.json`, `package.json#kragg`,
    `tsconfig.json` and the resolved compiler's version and path — each of
    which can move the call graph with no source byte changing.
  - `analysis/program.ts` memoized `ts.Program` handles in a module-level map
    and `resolveTypeScript` cached compilers per root forever, so a long-lived
    process using the library API that ran, edited files and ran again was
    served the first run's program. The run context is now the only owner of
    the run's program (still exactly one, still lazy), and compiler resolution
    is keyed on the resolved entry path plus its size and mtime.

  On a read-only checkout, `kragg criticality --write` reported the write
  failure as a bare `EACCES: permission denied, open …`; it still exits 3, but
  now names the artifacts and the fix. The milder case had no signal at all —
  when the data landed but its freshness stamp could not be written, the
  command printed `Wrote …`, exited 0 and left every later run silently
  re-deriving; that is now a stderr line naming the consequence. The sidecar's
  internal `version` is now `2`; a version-1 stamp reads as stale rather than
  as evidence of anything. `.kragg/criticality.json` and every report field are
  unchanged — Python's reader cannot observe any of this.
- **TOR-1368: `kragg flaky --rerun N` verifies it ran the intended suite before
  it reports stability.** The reruns built their own invocation and got both
  halves of it wrong: they dropped the `test_runner` override, so a project
  pinned to `node` was re-run under whatever inference guessed (or told to
  install a vitest it had deliberately not chosen), and they passed
  `test_paths` — bare directories — where `check` passes globs, so
  `node --test test` died on `Cannot find module .../test` and the TAP reader
  turned that into "1 test, 1 failed". The same phantom failed in every run,
  `failures === runs` read as "not intermittent", and the command printed
  `no flaky tests across N runs` and exit 0 about a suite that had never
  executed. Reruns now go through the same adapter call as `check`'s test gate,
  with the policy's runner and test paths; `adapters/support/testCommands.ts`
  is the single place that expands `test_paths` into argv, and `runTests`
  requires both settings so no caller can omit them again. Before any ratio is
  computed, every rerun must be a COMPLETED run of that suite: a run that could
  not start, was killed, produced no complete report, discovered zero tests, or
  failed without naming a test is not a sample, and one such run ends the sweep
  with exit 3 naming what happened. A test that fails in every run is now
  reported as a stable failure (exit 1) rather than dropped, and the output
  names the per-run totals and each test's pass/fail tally.

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
- TOR-1369: `kragg check --changed --format json` with nothing in the change
  set emits the ordinary report payload with an empty gate list instead of the
  text sentence "no changed TypeScript files". No keys are added or changed;
  the text format still prints the sentence, and neither form is journaled.
- TOR-1369: `--help` now documents every flag every command accepts, and a test
  walks the help text against the per-command table so the two cannot drift.
- **TOR-1367**: `secret_scanner` naming a scanner (`"gitleaks"` or
  `"secretlint"`) is now a REQUIRED tool. A named scanner that is not
  installed, or is too old to use safely, is `error: true` and exit 3 with its
  install command, where it used to be a skip and exit 0 — a project that
  pinned a scanner got a green run over a repository nothing had scanned.
  `"auto"` is unchanged: it is optional autodetection and still skips visibly,
  naming both tools, when neither is installed. `"off"` still skips.
- **TOR-1367**: a gitleaks that is installed and CRASHES on `gitleaks version`
  is now an error carrying the probe's own stderr, under every setting
  including `"auto"`. Previously it counted as "unusable", `"auto"` fell
  through to secretlint, and the crash vanished from the report entirely — the
  run came back green from the second scanner and nobody learned the first one
  was broken. A gitleaks that is merely ABSENT still falls through, as before.
- **TOR-1367**: secretlint is pointed at the path it was given. A literal file
  target — from `--file`, `--changed`, or the Claude PostToolUse hook — used to
  have the recursive directory glob appended (`src/a.ts` became
  `src/a.ts/**/*`), which matches nothing: secretlint exited 0 having read no
  file and the gate reported a clean scan of the file the caller named.
  Directories still become globs, explicit globs are still passed through, and
  a scan scope that does not exist on disk is now an error instead of a glob
  that matches nothing.
- **TOR-1367**: `kragg doctor` distinguishes optional autodetection from a
  required tool. A `lint_tool`, `test_runner` or `secret_scanner` that names a
  tool the project does not have is reported as
  `MISSING -> required by <setting>` with its install command and fails the
  doctor run (exit 1), instead of the advisory `none installed` — or, for a
  pinned `gitleaks` with secretlint installed, the outright wrong
  `secret scanner: ok (secretlint)` and exit 0 while `kragg check` was about to
  exit 3. `"auto"` lines now say `none installed — optional`, `"off"` lines say
  `disabled`, and the scanner line resolves gitleaks the way the gate does.

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
- TOR-1369: `kragg criticality --path` is honoured. It was in the accepted-flag
  table and read by nothing, so a scoped invocation analyzed the whole program
  and printed a table that looked scoped. It now narrows the call graph to the
  files under the given paths (repeatable), and a path matching no analyzed
  source file is exit 2 rather than an empty table that reads as "no risk".
  `--path` with `--write` is refused (exit 2): a scoped
  `.kragg/criticality.json` does not read as partial downstream, it reads as
  "every function outside the scope is uncritical", and `critical-tests` and
  `critical-coverage` would go quiet about all of them.
- TOR-1369: `kragg mutation`'s baseline flag is `--update-baseline`, the name
  the README and the Python sibling have always used. **`--write` is no longer
  accepted for `mutation`** (exit 2); the other `--write` commands are
  unchanged.
- TOR-1369: `kragg mutation` no longer narrows to the git change set unless
  `--since` says so. The CLI passed "compare against HEAD" by default, so a
  clean tree mutated nothing and exited 0 while the docs described the change
  intersection as opt-in.
- TOR-1369: an out-of-domain flag VALUE is a usage error instead of a silent
  fallback: `--format` other than `text`/`json`, and `--max-violations`,
  `--last` or `--rerun` that is not a non-negative integer, now exit 2 (as they
  already do in the Python sibling's argparse).
- TOR-1369: a positional argument a command has no use for (`kragg check
  src/a.ts`, `kragg status 20`) is exit 2 instead of being dropped, and `--file`
  together with `--changed`/`--since` is exit 2 instead of being discarded in
  favour of git's file set.

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
