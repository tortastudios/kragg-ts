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

### Changed

- **TOR-1418** — every flagged location now reaches the JSON payload as its own
  violation object. The report's display dedupe grouped findings by
  `(code, message)` and folded the other locations into the survivor's message
  — `maintainability index grade C (minimum: A) (+2 more at src/scene.ts,
  src/simulation.ts)` — so a gate with three affected files emitted **one**
  violation object naming one file, and no structured field named the other
  two. A consumer that reads `file`/`line`/`code` (a file-scoped agent deciding
  what it has been assigned) undercounted the affected files and read an
  actually-flagged file as clean. Dedupe now groups by
  `(code, message, location)`: only the identical finding reported twice at the
  same place collapses, with a bare `(+N more)` tail, and everything else is its
  own entry with its own `file`, `line` and `column`, under the unchanged
  per-gate cap.

  **No key was added, renamed or retyped.** `ViolationPayload` is the same six
  fields, `violation_count` is still the raw total, and `truncated` still means
  exactly one thing — the `max_violations_per_gate` cap dropped entries — rather
  than being `false` while a fold hid a location. Text output changes: a family
  spanning several files now prints one line per file instead of one line with
  the rest in prose. Python still folds across locations, which is now
  divergence 40 in `docs/spec-conformance.md`; `test/fixtures/regressions/`
  gains `folded-locations`, which fails if the fold comes back.

- The npm package is now `@tortastudios/kragg-ts`, not the bare `kragg-ts`
  this project shipped a few commits earlier. The org owns the scope on
  npm, so the package lives there too. The command it installs is still
  `kragg`, and every scaffold's self-pin, the `$schema` example, and the
  compatibility lanes' install paths were updated to match.

### Added

- **TOR-1378** — releases are gated on end-to-end regressions and on truthful
  self-check evidence, both against the BUILT `dist/cli.js`. 1,090 passing
  unit tests did not catch false-green behaviour between the engine, the
  adapters, the policy and the CLI, because each of those defects lived at a
  seam a unit test does not cross — and each was reproduced, at the time, by a
  fake that disappeared when its issue merged. Two things are new, and one CI
  job (`release-gate` in `.github/workflows/ci.yml`) runs both:
  - **`pnpm run regressions`** — `test/regressions.test.ts` over real fixture
    PROJECTS in `test/fixtures/regressions/`, one per closed defect, driven
    through the packaged CLI as a child process. A runtime skip must not
    silence the slow tier and a thrown gate must not destroy the consolidated
    report (TOR-1358); an unchanged caller's compiler error must survive
    `--changed` (TOR-1359); a crashed runner must not pass on the coverage
    report an earlier run left at the published path (TOR-1360); twenty-five
    critical functions must all be enforced while twenty are printed
    (TOR-1361); `init` on a CommonJS project whose policy lives in
    `package.json#kragg` must add no `type`/`engines`/`packageManager` and
    write no shadowing `kragg.json` (TOR-1362); a wrong-typed policy value
    must be exit 2 with nothing run (TOR-1363); a critical function the test
    run never loaded must be `critical-unmeasured`, not a pass (TOR-1364); a
    configuration-only change set must promote `--changed` to a full run
    (TOR-1365); an edit confined to `src/coverage/` must invalidate the
    criticality sidecar (TOR-1366); a named, uninstalled scanner must be
    `error: true` and exit 3 (TOR-1367); a rerun sweep that discovers no tests
    must be exit 3 and must never print "no flaky tests" (TOR-1368) — plus an
    ordinary-success control that exits 0 having demonstrably compiled the
    project and executed its suite. Every case asserts the process exit
    status, the payload's own fields and the artifacts on disk
    (`.kragg/history.jsonl`, `.kragg/criticality.json`, `CRITICALITY.md`,
    `coverage/lcov.info`); **none records a snapshot**. Each case was
    validated by reopening its defect in `src/` and confirming the case goes
    red.
  - **`pnpm run selfcheck`** — `scripts/selfcheck.ts` runs
    `check --all --format json` on this repository and refuses the summary
    line as evidence: it ENUMERATES every gate that did not run, with its
    reason, on every run, and fails unless each matches a reviewed entry in
    `scripts/selfcheck/expectations.ts`. An entry pins the gate name AND a
    substring of the skip reason, so a gate switched off in `kragg.json`
    cannot inherit the entry written for a missing tool; a gate that could not
    run always fails; an entry that stops matching is a notice, not a failure,
    since more ran than expected. One entry today — `detect-secrets` with no
    scanner installed — and installing gitleaks in CI was considered and
    deliberately not done. `test/selfCheck.test.ts` tests the evaluation.

  No gate, threshold, exclusion or wire key changed. Fixture suites are named
  `*.suite.js`/`*.suite.ts` (with each fixture's `test_paths` naming that
  pattern) so this repository's own `test/**/*.{test,spec}.*` discovery cannot
  execute a fixture's suite as if it were kragg's own.
- **TOR-1371** — explicit tsconfig selection, honest solution-style
  reporting, and bounded package-level checks for workspaces. Three layouts
  were mishandled, each reproduced before the change: a project configured by
  `tsconfig.base.json` + `tsconfig.app.json` with no `tsconfig.json` could not
  be checked at all (`tsc` error, `tsconfig-missing`, no program); a
  solution-style root `tsconfig.json` (`references`, no inputs — the Vite
  template) made **`tsc -p` exit 0 having checked nothing, so the `tsc` gate
  reported `[PASS]`** over a project with a real type error, while
  `typing-strictness` judged the solution file's empty `compilerOptions` as
  four violations; and a pnpm workspace root run errored on a missing root
  tsconfig, resolved one compiler for everything, and never mentioned
  `packages/*` — the type error in `packages/b` was invisible.

  A new policy setting, **`tsconfig`** (default `"tsconfig.json"`, validated
  like every other key, mirrored in `kragg.schema.json`, TypeScript-only), is
  resolved ONCE by `projectTsconfig` in `src/environment/project.ts` and read
  by every consumer: the shared program, the `tsc` gate's `--project`, the
  `typing-strictness` audit (whose findings now name the selected file), the
  `boundaries`/`structure` alias table (`paths`/`baseUrl` come from the
  selected file, keyed by its path) and the criticality freshness stamp (which
  hashes the selected file under its own name, so switching the setting is a
  change even when no file moved). A configured file that does not exist is
  exit 2 before any gate runs; a missing *default* stays the gates' finding.
  `readProjectConfig` in `src/analysis/program.ts` classifies a config as
  missing / unreadable / invalid / **solution** / empty, and the program
  builder, the `tsc` adapter (pre-flight, before spawning — the one shape the
  compiler accepts silently) and `typing-strictness` all refuse the solution
  shape as `error: true` with one message naming the referenced projects and
  the one-line fix. References are deliberately not expanded into N runs over
  one tree; a hybrid config (references *and* inputs) is audited for its own
  inputs with the existing advisory.

  **`check --package <name-or-path>` / `security --package …`** (repeatable)
  check a workspace member instead of the root: the member's root, its own
  policy (else the root's — never the defaults), its own `tsconfig`, its own
  compiler (`resolveTypeScript` from the member; a workspace mixing TypeScript
  5.9.3 and 6.0.3 uses each where installed and prints which), exactly one
  lazy program, and its own `.kragg/history.jsonl`. Members are never merged:
  text output has one section per member and a workspace summary line;
  `--format json` prints an **array** of the ordinary per-member payloads
  (unchanged schema, own `targets`); the exit code is the worst member's. An
  unknown member, a member whose configured tsconfig is missing, or a
  malformed member policy is exit 2 with nothing run. `--package` with
  `--file`/`--changed`/`--since` is a usage error. A root run in a workspace
  now prints on stderr which members it did NOT check, or why the list could
  not be read. `src/environment/workspaces.ts` expands `pnpm-workspace.yaml#
  packages` and `package.json#workspaces` to members through two small
  **fail-closed** readers (`workspacePatterns.ts`): a YAML shape or a glob
  outside the supported grammar empties the list with the line or pattern
  named, never a partial list. `doctor` now names the selected tsconfig, the
  compiler it would analyze with (with the bundled-fallback note), the
  workspace members, and the per-member invocation. The pipeline runner moved
  to `src/commands/pipeline.ts` (re-exported from `check.ts`) so `check`,
  `security` and `packages.ts` share one, including the legacy-debt baseline:
  a member reads and records the file its effective policy names at its OWN
  root, and refuses `--update-baseline` there when it names none.
  No wire key was added or changed;
  the stamp sidecar keeps its keys. `KNOWN_LIMITATIONS.md` lists what remains
  unsupported (nested workspaces are not expanded from the root, `--changed`
  per member, glob/YAML syntax outside the grammar, non-TypeScript members).
- **TOR-1379** — the packaged CLI, the published API, the scaffolds and the
  real external tools are executed, on the runtimes and platforms
  `package.json` claims. `pnpm test` imports `src/*.ts` on the single Node in
  `.node-version`, on one operating system: it never built, never packed,
  never installed, and so `engines.node: ">=20"`, `bin`/`main`/`types`/
  `exports`, and the Windows branch in `src/engine/runner.ts` had **no**
  executable evidence behind any of them. `scripts/compat.ts` adds three
  lanes, and CI runs exactly the commands a maintainer runs by hand:
  - **`packaged`** — build, `pnpm pack`, install the **tarball** into a
    throwaway project, then on the row's Node run `--version`, `--help`, the
    installed `node_modules/.bin` shim, a real `kragg check` whose `tsc` and
    `lint` gates must *spawn* the fixture's own binaries (on Windows, `.cmd`
    batch shims), and a TypeScript consumer compiled against the packed
    `.d.ts` and then executed. `.github/workflows/compat.yml` runs it on
    ubuntu **and windows** across Node **20, 22 and 24**.
  - **`scaffolds`** — every `kragg new --kind` output (`cli`, `api`, `mcp`
    with both SDKs) is generated, installed with `--ignore-scripts` and made
    to pass its own `pnpm exec kragg check`.
  - **`tools`** — the real vitest, `node --test`, bun, oxlint, biome, ESLint
    and secretlint at pinned versions, asserting each adapter turns that
    tool's *current* output into a located, rule-identified violation and
    that the runner's own coverage report was read and published. It lives in
    `.github/workflows/external-tools.yml`: weekly and on demand,
    `continue-on-error`, **never a required check**, because external version
    drift must not turn an unrelated pull request red — the same reasoning
    that already keeps the conformance job out of `check`.

  A lane never reports a skip as a pass: a row whose tool is missing prints
  `SKIP` with the reason, and `--strict` (how the advisory workflow runs)
  makes that a failure. `test/packaging.test.ts` asserts the always-true half
  on every run — every published entry point maps to a source file the build
  compiles, `files` allowlists it, and `engines.node`'s floor is in the
  matrix. README and `KNOWN_LIMITATIONS.md` now state, row by row, which
  platform/runtime combinations are **asserted** and which are merely claimed
  (macOS, ARM, odd-numbered Node, `npm`/`yarn` installs: not asserted). **No
  wire key, code, threshold or exclusion changes.**

- **TOR-1373** — the evidence linking a critical change to a test is a
  checker-bound reference, and the limits of the static signals are stated.
  `critical-tests` passed on ANY changed file under a test path, so a
  whitespace edit in an unrelated `test/other.test.ts` vouched for a rewrite
  of the authorization entry point; `test-quality`'s `critical-untested` was
  a substring search over the test text, satisfied by `// TODO
  verifyPassword`, the title `it("verifyPassword works")`, or an unrelated
  `send` on another class. Both gates now resolve test code through the run's
  one shared `ts.Program` (`src/gates/testDepth/references.ts`): a reference
  is an identifier in a test-tree file, outside any `it.skip`/`test.todo`/
  `describe.skip`, whose symbol — imports, `as` aliases, `export ... from`
  re-exports and shared helpers followed by `getAliasedSymbol` — declares a
  function the criticality graph registered, named by the same registration
  pass that named the sidecar's nodes. No direct call is required:
  `expectAuth(verifyPassword)`, a `describe`-level fixture and a helper in
  `test/helpers.ts` all count, so valid indirect tests are not rejected.
  `critical-tests` accepts a changed test only when it (or a test-tree module
  it imports) binds the changed function **or its module**; otherwise the
  violation says which changed test files were examined and why each did not
  qualify (no bound reference, bound only inside a skipped test, or outside
  the `tsconfig.json` program). `test-quality` reports a function whose only
  references sit in skipped tests as such, names test files the program does
  not contain rather than text-matching them, and its fix hint no longer
  demands a direct call. A program that will not build makes either gate
  `error: true` (exit 3), never a pass; the program is loaded only once there
  is something to bind. README, `KNOWN_LIMITATIONS.md` and the `spec`
  property section now state what a bound reference or an assertion-shaped
  call proves — that a test *exercises* the function — and does not (any
  behavioural coverage), and that `spec`'s property summary is a word-bounded
  name occurrence in a property test's text, not a call. **No wire key,
  code or threshold changes.** The stricter rule found 16 critical helpers in
  this repository that no test bound (their names had matched English words
  in test titles); each gained a direct unit test.
- **TOR-1377** — a reviewed adoption path for legacy debt, and suppression
  accountability. `kragg.json#baseline` names a git-tracked baseline file
  (conventionally `.kragg/baseline.json`; `null`/absent means none) that only
  `kragg check --update-baseline` writes — full runs only, never over a broken
  environment, always replacing the previous file so a fixed finding is a
  deletion in review. Findings recorded there are reported as `baselined:`
  advisories of their gate instead of failing the run; every finding NOT in
  it fails as before, so a new regression cannot hide behind old debt. Only
  the metric, structure and test-quality gates are eligible (`lint`,
  `complexity`, `maintainability`, `halstead`, `type-complexity`,
  `boundaries`, `structure`, `nullable-default`, `test-quality`,
  `critical-coverage`); `detect-secrets`, `secret-default`,
  `forbidden-calls`, `tsc`, `typing-strictness`, `test-coverage`,
  `critical-tests`, `audit`, every errored gate and every skip are refused at
  record time, rejected at read time and ignored at apply time. An entry is
  `(gate, file, code, message, fingerprint-of-the-flagged-line)` with no line
  number: it survives edits above it and goes **stale** — reported as an
  advisory, never dropped or re-matched — when the line, the message or the
  file name changes, so a rename is a re-review. **No wire key is added**:
  accepted and stale findings ride in the existing `advisories` list, and the
  cross-language fixtures are unchanged. The Claude hook applies the same
  baseline as `check`. `kragg.schema.json` gains the key.
  `// kragg: ignore` now **requires a reason** — `// kragg: ignore --
  <reason>` (or `/* kragg: ignore -- <reason> */`): a bare marker suppresses
  nothing and the gate reports the finding it was written over with a note
  naming the bare marker. kragg-ts's own three live markers carry reasons.
  `kragg brief` gains `## Suppressions` (every marker the change set added or
  removed, with its reason, bare ones flagged) and `## Baseline` (entries
  added, removed or stale) between the critical and gate sections. The
  scaffold's `AGENTS.md` and `.gitignore` lines state the new rules.
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

- **TOR-1381 — documentation, the dependency inventory and scaffold
  onboarding reconciled with what actually ships.** Every claim was checked
  against the built CLI, the registry and the installed tree rather than
  against another document. What was wrong, and what changed:
  - The generated project's own cooldown (`minimumReleaseAge: 43200`,
    strict) refuses the exact `kragg-ts` pin the scaffold writes for the
    first month after every release — reproduced with a six-day-old exact pin
    under the generated `pnpm-workspace.yaml`
    (`ERR_PNPM_NO_MATURE_MATCHING_VERSION`), the state `kragg-ts@0.1.0` will
    be in the day it is published. `kragg new` (every kind) and `kragg init`
    now name `kragg-ts` in `minimumReleaseAgeExclude`, with the reason
    written beside it, exactly when they write the pin; a `0.0.0` build
    writes neither. The floor, the strict flag and every other entry are
    untouched, and `test/scaffold.test.ts` asserts pin and exemption appear
    together or not at all.
  - `docs/dependency-policy.md` said the installed tree was four packages
    and that `oxlint` had zero dependencies. `oxlint@1.73.0` declares
    nineteen optional platform bindings; the lockfile holds 23 entries and
    five land on any one machine. The inventory now says so, and says why
    that is the shape rule 5 asks of a native addon. `oxlint`'s approval is
    not revisited; no dependency was added or removed.
  - README's `$schema` example (and the schema's own description, and the
    TOR-1363 entry above) pointed at `node_modules/kragg/`, a directory the
    `kragg-ts` package never creates.
  - `KNOWN_LIMITATIONS.md` still listed Windows as untested and non-ASCII
    changed paths as dropped under "shared with Python", both closed here by
    TOR-1379 and TOR-1365 and contradicted elsewhere in the same file; it now
    also states what the scaffold rows do not assert about the registry.
  - README claimed `npm`/`yarn` installs "work the same way" while the matrix
    asserts only pnpm; that a missing tool is always a skip, when a named
    tool or `tsc` is exit 3; that kragg "drives seven programs" when seven is
    the count the weekly lane checks; and never showed `--mcp-sdk official`.
    `AGENTS.md`'s flag summary omitted `init --dry-run` and the scaffold
    commands' own flags. Module and test-file counts in `AGENTS.md`,
    `docs/architecture.md` and the dependency policy now match the tree
    (192 modules, 59 test files).
  - `kragg doctor` under `secret_scanner: "auto"` printed "install gitleaks
    or secretlint" with no command; it now prints one `MISSING -> Fix:` line
    per absent scanner, as it already did for the linters. No gate,
    threshold, exclusion or wire key changed.
- **TOR-1379: the published CLI did nothing when installed, and exited 0.**
  `node node_modules/kragg-ts/dist/cli.js --version` printed nothing and
  returned 0 — no command ran. The entry-point guard compared
  `import.meta.url`, which Node resolves through symlinks, against
  `pathToFileURL(process.argv[1])`, which it does not; pnpm's
  `node_modules/<name>` → `.pnpm/…` store link makes the two differ, as do npm
  and yarn workspace links and `/var` → `/private/var` on macOS. A CLI that
  silently succeeds at nothing is the exact fail-open outcome this codebase
  exists to refuse. `src/cli/entry.ts` now compares **real** paths, so an
  invocation through any link runs and an `import` from a test still does not;
  `test/packaging.test.ts` covers both, including an end-to-end spawn through
  a symlink.
- **TOR-1379: two of the four scaffolds failed their own first
  `kragg check`.** `kragg new --kind api` produced three type errors and
  `--kind mcp --mcp-sdk official` one, all inside `node_modules`: hono's and
  the MCP SDK's declarations reference `MessageEvent`, `BinaryType` and
  `HeadersInit`, the generated `tsconfig.json` sets `skipLibCheck` false (on
  purpose), and `lib` was `["es2023"]` for every kind. The generated `lib` is
  now per-kind — `["es2023", "dom"]` for `api` and `mcp`, unchanged for `cli`
  and `kragg init`, which depend on nothing that needs it.
- **TOR-1372: the test gate runs a command the project can state, over files
  it can name — and a run that discovered nothing is not a pass.** Runner
  detection reads `package.json#scripts.test` to learn WHICH RUNNER a project
  uses, and kragg then rebuilt the argv from policy. On a project whose script
  is `node --import tsx --test "src/**/*.test.ts"` that reconstruction dropped
  the loader and replaced the file selection with `test_paths`, so kragg ran
  `node --test test/**/… tests/**/…`, discovered **zero tests**, and reported
  `[PASS] test-coverage`. Three changes, and the gate on this repository's own
  reproduction goes from a green 0-test run to exit 3:
  - **`test_command`**, a new policy key: the exact argv that runs the suite,
    without file patterns (`["node", "--import", "tsx", "--test"]`). It is an
    ARGV ARRAY and a shell string is rejected by name (exit 2) — `runner.ts`
    spawns with `shell: false`, so a string would be one program with spaces in
    it, and splitting it would mean writing the shell lexer this repository
    exists without. kragg appends the reporter and coverage flags it has to
    parse plus the `test_paths` patterns, and does not duplicate the runner's
    own run token. Element 0 resolves exactly like every other tool — the
    project's `node_modules/.bin`, or `node` / `bun` as runtimes — never from
    `PATH`, never a global install and never a path; a program kragg cannot map
    to a report format is refused at load unless `test_runner` names one.
    Validated by TOR-1363's readers, mirrored in `kragg.schema.json`, shown by
    `kragg policy show`.
  - **`test_paths` entries may be patterns**, so a colocated suite is
    expressible (`src/**/*.test.ts`; `**` spans zero or more segments, `*` and
    `?` stay in one, `{a,b}` alternates). `src/util/testPaths.ts` is now the
    single answer to "what does the runner discover", "which files are the test
    corpus" and "is this changed file a test change", so `check`'s test gate,
    `flaky --rerun`, `test-quality`, `critical-tests` and `kragg spec` cannot
    disagree about what the suite is. A pattern's directory is walked and the
    pattern then narrows the result — pointing at `src/**/*.test.ts` does not
    pull `src/` into the corpus, which would have made `test-quality`'s
    critical-function reference check true for every function in the codebase.
  - **A completed run that discovered no tests is `error: true` and exit 3**,
    naming the argv, the patterns searched and the three settings that change
    the answer. Zero failures out of zero tests is arithmetic, not evidence —
    the rule TOR-1368 already applies to a `flaky --rerun` sample, applied to
    the gate that produces it. `"test_runner": "off"` is still the way to say
    the gate should not run.

  The gate's output now always states which invocation ran and where it came
  from, and says in as many words that a detected runner is not the project's
  script: it prints the argv, the `scripts.test` text it was inferred from, and
  that the script was not run. An unsupported runner (`jest`, `mocha`) still
  skips visibly and never passes, and now names `test_command` as well as
  `test_runner`. Paths with spaces survive throughout — every invocation is an
  argv array, so nothing is ever quoted or split. No wire key is added, renamed
  or removed; `test_command` joins the TypeScript-only tail of `policy show`.

- **TOR-1370** — the Claude Code hook checks what the equivalent command
  checks, and a hook that fails is no longer silent.
  - **Scope.** `handleStop` ran the pipeline over `policy.sourcePaths[0]`
    (inherited from Python's `_stop`), so in a project declaring
    `source_paths: ["src", "lib"]` the hook's per-file tools — the linter, the
    secret scanner — were pointed at `src` alone: `kragg check` reported a
    `no-debugger` violation in `lib/` and exited 1, while the Stop hook on the
    same tree emitted nothing, let the turn end, and journalled `passed: true`.
    The hook now states an INTENT (`full`, `file`, `changed`) that
    `src/commands/scope.ts` — the one resolver `check` and `security` use —
    expands, so a Stop is `kragg check`, a post-edit is `check --file <path>`,
    and a tool that edited no single file is `check --changed`, including the
    rules the hook must not reimplement (a configuration edit promoting an
    incremental run, deletions, an edited file outside the source paths). The
    hook loads no policy and derives no file list of its own any more.
  - **Observability.** Failing open is the deliberate exception and it is
    unchanged — exit 0, nothing blocked, valid protocol JSON or no output at
    all — but every internal failure is now RECORDED: a line on stderr (debug
    output at exit 0, never a `hook error` notice), an append-only entry in
    `.kragg/hook-errors.jsonl` carrying a timestamp, the event name narrowed to
    a fixed set and the error message, and a first line in the next
    `SessionStart` context: `N kragg hook failures recorded since the last
    session`. The record NEVER contains the stdin payload — a `tool_input` is a
    tool's own arguments, which for `Bash` is a command line. The injected
    check seam answers `report` / `nothing` / `failed` instead of
    `CheckReport | null`, because that `null` meant both "nothing to check" and
    "could not run at all" and both read as a pass.
  - **Recursion.** `stop_hook_active` is unchanged and still pinned. Alongside
    it, `KRAGG_HOOK_ACTIVE` is set for the duration of a hook run and inherited
    by everything the pipeline spawns, so a project whose test command or
    wrapper script invokes `kragg hook claude` re-enters a no-op instead of
    starting another full pipeline inside the one already running.
  - **Truncation** is unchanged at 9000 characters with the in-band marker, and
    is now pinned on both emitting paths (a block `reason` and a SessionStart
    `additionalContext`) with the assertion that the cut is applied to the text
    and never to the JSON envelope, so `decision` always survives.

  No wire format moves: `.kragg/history.jsonl` keeps its keys and its
  `"changed"`/`"full"` mode values, the report payload is untouched, and the
  `hook-protocol` conformance golden is byte-identical.
  `.kragg/hook-errors.jsonl` is a new kragg-ts-only file in the journal's
  shape, rotated at 200 lines, that no gate and no Python reader consults.
  `src/hooks/session.ts` and `src/hooks/diagnostics.ts` split the SessionStart
  and diagnostics halves out of `claude.ts`.
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
- **TOR-1365 — incremental input selection is unified, and a configuration
  change no longer bypasses checking.** `kragg check --changed` after editing
  only `kragg.json`, `tsconfig.json`, `package.json`, a lockfile or a linter
  config resolved an empty TypeScript selection, printed "no changed
  TypeScript files" and exited **0 without running a single gate** — over the
  files that decide what every gate concludes about every file. A change set
  containing a configuration or dependency input (`kragg.json`,
  `tsconfig*.json`, `package.json`, the lockfiles, `pnpm-workspace.yaml`, the
  linter configs `.oxlintrc.*` / `oxlint.config.*` / `biome.json(c)` /
  `eslint.config.*` / `.eslintrc*`, the test-runner configs `vitest.config.*` /
  `vitest.workspace.*` / `bunfig.toml`, and the configured `secret_baseline`)
  now runs a **full** check, reporting `mode: "full"` and `targets` of the
  source paths — what was actually checked — with the reason on stderr so the
  promotion is never a surprise. A change set whose only source change is a
  **deletion** is promoted for the same reason: a deleted file is still never
  handed to a per-file tool, it just stops being mistaken for "nothing
  changed". Also fixed, in the same resolution:
  - **Non-ASCII paths are no longer silently dropped.** Every git plumbing call
    is `-z`, so `src/café.ts` survives instead of arriving as
    `"src/caf\303\251.ts"`, matching nothing on disk and leaving the selection
    without a word.
  - **A git failure is exit 3 with git's own message**, never an empty
    selection: an unknown `--since` ref now says `git merge-base: fatal: …`
    rather than "not a git repository", and a repository with no commit yet is
    an error rather than a run that silently checked only untracked files. A
    genuinely empty change set is unchanged — exit 0 and the documented clean
    run.
  - **`--file` on a path that does not exist is a usage error (exit 2) naming
    it**, on `check` and `security` alike. It used to run the pipeline: the
    linter errored about *itself* finding no files while five path-aware gates
    matched nothing and printed `[PASS]`.
  - **`--file` on a directory now narrows every gate, not just the linter.**
    `targets` stays exactly as typed (it is on the wire, and the
    cross-language contract pins it as "as given"); the internal narrowing is
    the expansion, so `typing-strictness`, `type-complexity`,
    `nullable-default`, `secret-default` and `forbidden-calls` stop reporting
    `[PASS]` over zero files.
  - **One resolver.** `check` and `security` share
    `src/commands/scope.ts` instead of each deriving `--file` semantics; which
    scope every gate honours — and which whole-program gates deliberately
    ignore it — is now a table in `README.md` and `docs/architecture.md`. No
    whole-program verdict was narrowed. No wire key was added or renamed.

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

- **TOR-1374: reviewed critical functions.** `critical_functions` in
  `kragg.json` (or `package.json#kragg`) names functions a human decided are
  high-consequence, each with the reason it is critical, which is required:
  `{"src/auth/login#verifyPassword": "authorization entrypoint"}`.
  Centrality only measures how much
  other code leans on a function, so an authorization or payment entrypoint
  with one caller ranked last and every criticality-driven gate was silent
  about it. A declaration is **additive**: it makes a function critical
  alongside the graph's own selection, never demotes one, and both reasons are
  shown when it does both. From there it flows unchanged into `critical-tests`,
  `test-quality`, `critical-coverage`, `kragg coverage` and mutation
  targeting. `CRITICALITY.md` and the terminal table gain a `Why` column —
  `declared: authorization entrypoint` against `fan-in 7, betweenness 0.3000` —
  and the gates quote the reason when they name a declared function. A
  declaration that matches no analysed function is an ERROR: `kragg
  criticality` exits 3 naming the stale entry (with the nearest match when a
  rename is obvious) and writes nothing, and the three gates report
  `error: true`, so a rename cannot silently retire the protection. **No wire
  key is added**: a declared function reaches `.kragg/criticality.json` as an
  ordinary six-key record with `is_critical: true`, and the reason is
  re-derived from the policy wherever it is shown rather than stored — which is
  also why a declaration takes effect on the next read without re-running
  `kragg criticality --write`. Recorded as divergence 29 in
  `docs/spec-conformance.md`; the default is an empty declaration list, so a
  project that declares nothing sees byte-identical output.
- TOR-1363: `kragg.schema.json`, shipped in the package, mirrors the keys,
  types and ranges the loader enforces so an editor can validate `kragg.json`
  (`"$schema": "./node_modules/kragg-ts/kragg.schema.json"`); `$schema` is
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

### Changed

- The npm package is now published as `kragg-ts`, not `kragg`. The command
  it installs is still `kragg`. The Python sibling already owns the name
  `kragg` on PyPI, and the two are different packages, so `kragg` on npm
  would have been misleading either way. A project scaffolded by `kragg new`
  now pins `kragg-ts` as its dev dependency once this build is a released
  version.
- `oxlint` is now an approved dev dependency, not an unreviewed one.
  kragg-ts runs its own `lint` gate against its own source with it, the way
  any project using kragg would. It ships to nobody who installs the
  package.

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
