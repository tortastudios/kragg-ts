# kragg

An opinionated guardrails framework for AI-assisted TypeScript projects.

kragg is **agent-first**: coding agents (Claude Code, Codex, Cursor, Gemini
CLI) are the primary users, running check → fix loops. It gives them one
command, structured results, meaningful exit codes, and copy-pasteable fixes.

This is the JS/TS sibling of the Python
[`kragg`](https://github.com/tortastudios/crag). The two share no code. They
share a **contract** — the same JSON report schema, the same exit codes, the
same `.kragg/history.jsonl` journal, the same hook protocol — so a CI job or an
agent can consume either without knowing which ran. See
[docs/spec-conformance.md](docs/spec-conformance.md).

## Why

Agents write a lot of code quickly. The bottleneck is not generation, it is
knowing whether what was generated is safe to keep.

Three properties matter more than the gate list:

- **One invocation reveals every failure.** All fast gates run even after one
  fails, so an agent never re-runs to discover problem #2. Slow gates skip once
  a fast gate has failed, since their results would be invalidated by the fix.
- **The output is honest.** A gate that could not run is exit 3, not a pass. A
  gate with nothing configured is reported as *skipped*, with the exact command
  to configure it — never omitted, never silently green.
- **The output is small.** Violations are deduplicated, capped per gate, and
  reported as `file:line` pointers with fix hints instead of raw tool dumps.
  Every byte competes with the agent's context window.

## Install

Not yet published. From a checkout:

```sh
pnpm install --ignore-scripts
pnpm run build
node dist/cli.js check
```

## Commands

```sh
kragg check                    # all gates, one consolidated report
kragg check --changed          # only files changed vs HEAD (cheap inner loop)
kragg check --since main       # changed vs merge-base with a ref
kragg check --file src/a.ts    # scope to specific files (repeatable)
kragg check --format json      # stable machine-readable schema
kragg security                 # the security subset, cheap enough for every push
kragg fix                      # format and safely auto-fix lint findings

kragg map                      # exported symbols — what already exists
kragg map --path src/analysis  # ...just this directory or file (repeatable)
kragg map --symbol runCommand  # ...just this exported name, or module#name
kragg map --changed            # ...just what changed against HEAD
kragg map --limit 0            # the full export (--all is the same thing)
kragg map --format json        # entries plus total / shown / truncated
kragg spec                     # the test suite rendered as a documentation tree
kragg spec --symbol coverage   # ...cases whose title or describe says this
kragg brief                    # a reviewable digest of the change set
kragg brief --path src/gates   # ...restricted to one area of the change set
kragg status                   # what failed last run, without re-running
kragg policy show              # the effective policy, resolved
kragg doctor                   # environment diagnostics with exact fixes

kragg coverage                 # uncovered lines in critical functions, ranked
kragg criticality --write      # call-graph risk -> CRITICALITY.md + .kragg/
kragg mutation                 # mutation-test critical files with Stryker
kragg flaky                    # gates that flipped on an unchanged commit
kragg audit                    # dead code and dependency drift

kragg new my-app --kind cli    # scaffold (cli | api | mcp)
kragg gen module payments      # service/domain/test slots in the layout
kragg init                     # add guardrails to an existing project
kragg init --dry-run           # ...or just print what that would change
kragg hook claude              # harness hook adapter (reads hook JSON on stdin)
```

### Exit codes

Branchable without parsing a single line of prose.

| Code | Meaning |
| --- | --- |
| `0` | all gates passed (a skipped gate is not a failure) |
| `1` | gates ran and found violations — fix the code |
| `2` | usage error, or unusable config — fix the command line |
| `3` | environment broken — a gate could not run; findings are unreliable |

Exit 3 outranks exit 1. A misconfigured `kragg.json` is exit **2**, not 3: it
is the same class of mistake as a misspelled flag, and the fix is one
character in a file, not reinstalling a tool.

## Gates

**Fast** — always all run, so one loop iteration surfaces everything:

| Gate | What it checks |
| --- | --- |
| `lint` | oxlint, biome or eslint — whichever the project configured |
| `tsc` | the project's own `tsc --noEmit` — always the whole project through its own `tsconfig.json`, with `--changed`/`--file` files reported first and nothing dropped |
| `typing-strictness` | that `tsconfig.json` actually meets the strict floor, has no escape hatches (`@ts-ignore`, `as any`, double casts), **and covers every source file** |
| `complexity` | cyclomatic complexity per function (radon's grade bands) |
| `maintainability` | maintainability index per file |
| `halstead` | Halstead effort, difficulty and estimated bugs |
| `type-complexity` | annotation nesting and length — data shapes should get names |
| `boundaries` | the layered import contract from `layers` |
| `structure` | file-length and public-symbol budgets |
| `forbidden-calls` | project-banned APIs, resolved through the type checker |
| `nullable-default` | `\|\|` mis-coalescing a legitimate `0` / `""` / `false` |
| `critical-tests` | critical functions cannot change without test changes |
| `test-quality` | no assertion-free tests; critical functions are referenced |
| `secret-default` | secrets given silent fallbacks — a blank key must fail at startup, not sign |
| `detect-secrets` | gitleaks or secretlint — autodetected under `"auto"`, required when `secret_scanner` names one |

**Slow** — skipped while fast gates fail:

| Gate | What it checks |
| --- | --- |
| `test-coverage` | the project's test suite, plus the coverage floor |
| `critical-coverage` | public critical functions must be measured and have no uncovered lines |
| `audit` | dependency vulnerabilities via the project's package manager |

kragg **bundles none of these tools**. Every external tool is resolved from the
project's own `node_modules/.bin` — never a global install, never kragg's own
tree — so a gate always runs the version the project declared. A missing tool
is a visible skip with the exact install command, not a silent pass.

## Scope: what a run actually looks at

There are three scopes, resolved once per invocation (`src/commands/scope.ts`)
and shared by `check` and `security` so the two cannot disagree:

| Mode | From | Per-file tools get | Path-aware gates get |
| --- | --- | --- | --- |
| `full` | the default | `source_paths` | the whole project |
| `changed` | `--changed` / `--since` | the changed source files that still exist | the same files |
| `file` | `--file` | the paths as typed (a directory included) | those paths expanded to the source files under them |

**A configuration edit is a change, and it changes everything.** `--changed`
after editing only `kragg.json`, `tsconfig*.json`, `package.json`, a lockfile,
`pnpm-workspace.yaml`, a linter config (`.oxlintrc.*`, `oxlint.config.*`,
`biome.json(c)`, `eslint.config.*`, `.eslintrc*`), a test-runner config
(`vitest.config.*`, `vitest.workspace.*`, `bunfig.toml`) or the configured
`secret_baseline` runs a **full** check — those files decide what every gate
concludes about every file, and the incremental run used to exit 0 without
running one. The report says `mode: "full"`, and the reason is printed on
stderr so the promotion is never a surprise.

**A deletion is a change too.** A deleted file is never handed to a per-file
tool — there is no file — but a change set whose only source change is a
removal also runs a full check, because deleting the module half the tree
imports is the change most likely to break the build. A rename needs no
promotion: its new path is in the selection and `tsc` compiles the whole
project anyway.

**An empty selection is not a failed one.** A clean tree, or a commit that
touched only a `README.md`, is exit 0 and the ordinary report with no gates.
Git being *unable to answer* — not a repository, an unknown `--since` ref, no
commit to diff against — is exit 3 carrying git's own message, never an empty
file list. A `--file` that names a path which is not there is exit 2 naming it.

### Which scope each gate honours

Narrowing a gate that reasons about the whole program would make it lie, so
several deliberately ignore the selection. That is documented, not accidental:

| Gate | Scope it honours | Why |
| --- | --- | --- |
| `lint` | the targets, verbatim | per-file, and the linter takes directories |
| `tsc` | **whole project, always** | the selection only orders diagnostics; the error a change causes is usually in a file that did not change |
| `typing-strictness` | the file list, for the source scan | the `tsconfig.json` audit always runs — a loosened floor must not ride in on an unrelated commit |
| `complexity`, `maintainability`, `halstead`, `structure` | **whole project** | per-file budgets, but cheap enough to keep whole so a run cannot report a budget it never measured |
| `type-complexity` | the file list | per-file annotation budgets |
| `boundaries` | **whole project** | a layering violation is a property of the import graph, not of one file |
| `forbidden-calls`, `nullable-default`, `secret-default` | the file list | per-file, type-aware |
| `detect-secrets` | the file list, else the whole project | credentials hide in `.env` files and fixtures, not only in `src/` |
| `critical-tests` | **whole project**, plus its own `--since` diff | it compares critical functions against test changes across the tree |
| `test-quality` | **whole project** | it answers "does a test reference this critical function", which no selection bounds |
| `test-coverage`, `critical-coverage`, `audit` | **whole project**, and they skip in incremental mode | a suite or an advisory scan means nothing partially run |

## Test depth

Green checkmarks are easy to fake, so kragg looks past them with layered,
mostly-deterministic signals:

- **what's run** — `kragg coverage` surfaces uncovered lines in critical
  functions ranked by fan-in, instead of a gameable global percentage. The
  `critical-coverage` gate fails on any uncovered line in a critical function,
  and on a critical function it could not measure: a file no test ever
  imported has no entry in any runner's report, and that is reported as
  `critical-unmeasured` with the cause (`the test run never loaded src/x.ts`)
  rather than passed. Works under vitest (istanbul JSON), `node --test` and
  `bun test` (lcov). Attribution comes from the source, keyed the way
  `criticality.json` spells a name, so `Reader.close` and `Writer.close` each
  answer for their own lines. This is **line** coverage: `if (broken) fix();`
  on one line counts as covered once the `if` ran; no branch verdict is
  implied anywhere.
  Both gates believe only **this invocation's** evidence: the runner writes
  into a private `.kragg/runs/` directory that did not exist before the run,
  so a runner that crashes, times out or leaves a partial report is an error
  (exit 3) — never a re-read of an older report, and never the other runner's
  format after a switch — and `critical-coverage` consumes the coverage
  `test-coverage` just measured rather than any file on disk. Two `kragg
  check`s in one project cannot read each other's artifacts. The
  `test-coverage` percentage is the **project's**: only files under
  `source_paths` count, and every source file the run never loaded counts
  with all of its statement lines uncovered (kragg reads the count off the
  source and names the files in the gate's output), so a suite that imports
  three of forty modules cannot report 100%. Once read, the coverage
  artifact is published to `coverage_report_path` (istanbul, vitest) or the
  `lcov.info` beside it (node, bun); `kragg coverage` reads exactly the one
  the project's runner writes, on demand, and treats a file that is present
  but unusable as an error rather than as "no data".
- **what's defended** — `kragg mutation` runs Stryker over critical files and
  reports surviving mutants as `file:line`. Accept equivalent mutants with
  `--update-baseline`; that baseline is the one `.kragg/` file deliberately
  git-tracked, because equivalent mutants are a reviewed, shared property.
- **what's claimed** — `kragg spec` renders `describe`/`it` strings as a
  documentation tree and flags critical functions with only example-based
  tests (property-based tests, via fast-check, kill more mutants).
- **what's trustworthy** — `kragg flaky` mines the run journal for gates that
  flipped on an unchanged commit; `--rerun N` re-runs the suite N times under
  the same `test_runner` and `test_paths` as `check`'s test gate and tallies
  every test. A test whose outcome varies is flaky (exit 1); one that fails
  every time is a stable failure, reported as such (exit 1). A run that did not
  complete the intended suite — no runner, a crash, a timeout, zero tests
  discovered — is exit 3 naming what happened, never "no flaky tests".

Mutation and active flaky runs are deliberately **outside** `kragg check`: they
are on-demand and CI surfaces, not inner-loop gates.

## Security contracts

No scanner can infer a repository's unstated security requirements — that this
codebase never shells out directly, that request bodies must be bounded. What
it can do is enforce them mechanically once a human states them. That is the
`forbidden-calls` gate's job: build the safe wrapper, then ban the raw API
repo-wide with a hint naming the wrapper.

```json
{
  "forbidden_calls": {
    "node:child_process": "spawn subprocesses through runCommand in src/engine/runner.ts"
  }
}
```

Resolution goes through `ts.TypeChecker`, so it catches what an import-based
banned-API linter cannot: subclass overrides, receivers with no annotation,
re-export chains, `await`ed dynamic imports. The wrapper's own call site is the
one legitimate use, marked with a trailing `// kragg: ignore -- <reason>` so
the exemption is **visible in review** rather than invisible in a config
allowlist.

kragg dogfoods this: `node:child_process` is banned in this very repository,
and `src/engine/runner.ts` carries the single exemption.

`secret-default` closes the inverse hole to a secret scanner — not a credential
*present* in the repo, but one *absent at runtime and silently defaulted*.

## Agent-native design

Agents drift where they have freedom, so the scaffold removes the freedom.
Every `kragg new` kind ships one layered layout (`entrypoints/` → `services/`
→ `domain/`) with the `boundaries` gate enforcing dependency direction from
the first commit, and `kragg gen module` creates new code in the one place it
belongs.

The tool holds the memory the agent lacks: `kragg map` is the inventory of what
exists, `.kragg/history.jsonl` remembers runs, `CRITICALITY.md` remembers risk,
and `kragg brief` renders the change set legible to a human reviewer.

Memory the agent cannot afford to read is memory it does not have, so the
inventories are **focused and bounded**. `map`, `spec` and `brief` take
`--path` (repeatable file or directory prefixes), `map` and `spec` also take
`--symbol` (an exported name, `Class.method`, or the exact `<module>#<name>`
for `map`; a case-insensitive substring of a test or `describe` title for
`spec`) and `--changed` (files changed against `HEAD`, the same detection
`check --changed` uses). All three take `--limit <n>`, which defaults to 100
entries — `--limit 0` or `--all` restores the complete export. `map` and
`spec` also take `--format json`, which carries `total`, `shown` and
`truncated` beside the entries. Ordering is deterministic: by path, then by
name for `map`, and by path, then source order for `spec`, so the JSON entry
order is the text order and two runs over one tree are byte-identical.

**A display budget is never a scope.** A truncated text render ends with
`showing N of M … — pass --limit 0 for everything`, so a bounded view cannot
be read as a complete one; `map` still derives the whole project's criticality
graph however narrow the printed map, so no gate goes quieter; and
`map --write` always writes the complete `.kragg/map.md`, refusing `--path`,
`--symbol` and `--changed` outright — a scoped map injected at session start
does not read as "part of the map", it reads as "nothing else exists".
`--limit` is allowed with `--write` and trims only the terminal.

`kragg brief` never runs a gate. Its `## Last gate run` section is a summary of
`.kragg/history.jsonl`, says so on its own line, and states when the recorded
verdict was reached at another commit or on a dirty tree — so a stale `PASS`
cannot be read as "this change set was checked".

Scaffolding emits `AGENTS.md` as the canonical agent contract — read by Codex,
Cursor and Gemini CLI, and by Claude Code via a `CLAUDE.md` pointer — plus
hooks that run `kragg check --changed` after edits.

## Exemptions are reviewed, never accumulated

Two ways exist to not fail on a finding, and both leave a trail a reviewer can
read.

**Suppressing one site.** The native gates honour
`// kragg: ignore -- <reason>` (or `/* kragg: ignore -- <reason> */`) on any
line the flagged node spans. **The reason is not optional**: a bare
`// kragg: ignore` suppresses nothing, and the gate reports the finding it was
written over with a note naming the bare marker. The content of the reason is
not judged — that is what review is for — and `kragg brief` lists every marker
the change set added or removed, with its reason, under `## Suppressions`.

**Adopting legacy debt.** An existing project has findings nobody will clear
in one sitting. Name a baseline file in the policy and record them:

```sh
# kragg.json: { "baseline": ".kragg/baseline.json" }
kragg check --update-baseline   # full runs only; add --all to reach the slow tier
```

Every finding recorded there is reported as a `baselined:` advisory of its
gate instead of failing the run, and every finding **not** in it fails exactly
as before, so a new regression cannot hide behind old debt. Nothing on the
wire changes shape: the accepted findings ride in the existing `advisories`
list and `advisory_count`. The file is git-tracked — commit it, and keep
`.gitignore` at `.kragg/*` followed by `!.kragg/baseline.json` — and only
`--update-baseline` ever writes it, replacing the previous one so a fixed
finding shows up as a deletion in review.

What a baseline can never hold, enforced in code: `detect-secrets`,
`secret-default`, `forbidden-calls`, `tsc`, `typing-strictness`,
`test-coverage`, `critical-tests` and `audit` findings, every errored gate and
every skip. Only the metric, structure and test-quality gates (`lint`,
`complexity`, `maintainability`, `halstead`, `type-complexity`, `boundaries`,
`structure`, `nullable-default`, `test-quality`, `critical-coverage`) are
eligible; `--update-baseline` names what it refused, and a hand-edited entry
for any other gate is a config error. A baseline never loosens a threshold or
widens an exclusion — the gates run exactly as configured and the subtraction
happens afterwards, one recorded finding at a time.

An entry is identified by gate, file, code, message and a fingerprint of the
flagged line's text — no line number — so it survives edits above it and goes
**stale** when the line, the message (a metric that grew) or the file name
changes. A stale entry is reported as an advisory on its gate, never dropped
and never re-matched: a renamed file is a re-review, with the old entries
stale and the findings at the new path failing as new. `kragg brief` lists
the entries a change set added, removed or left stale under `## Baseline`.

## Configuration

Config is **data, not code.** There is no `kragg.config.ts` and there will not
be one: a config file that executes arbitrary TypeScript at load time means the
tool meant to guard your project runs untrusted project code before any gate
has looked at it.

Settings go in `kragg.json`, or under a `"kragg"` key in `package.json`. A
standalone `kragg.json` wins outright; the two are never merged. Keys are
snake_case, matching the Python implementation.

Because a `kragg.json` wins outright, `kragg init` will not create one in a
project that already states a policy — in either place. Writing one would not
add to that policy, it would replace it, silently retiring every threshold the
project had tightened. For the same reason `init` never adds `type`,
`engines`, `packageManager` or `private` to a `package.json` that already
exists: each answers a question the project has already answered, and adding
`"type": "module"` to a CommonJS project breaks it outright. Run
`kragg init --dry-run` to see the exact set of files and keys before anything
is written.

```json
{
  "$schema": "./node_modules/kragg/kragg.schema.json",
  "source_paths": ["src"],
  "test_paths": ["test"],
  "layers": ["src/cli", "src/commands", "src/gates", "src/engine"],
  "max_file_lines": 500,
  "max_public_symbols": 20,
  "structure_exclude": ["src/index.ts"],
  "coverage_fail_under": 80,
  "lint_tool": "auto",
  "test_runner": "auto",
  "secret_scanner": "auto",
  "forbidden_calls": {
    "node:child_process": "use runCommand in src/engine/runner.ts"
  }
}
```

**Editor validation.** The package ships `kragg.schema.json`, a JSON Schema
that mirrors exactly the keys, types and ranges the loader enforces (a test
keeps the two in lockstep; nothing is validated by a dependency). Point your
editor at it with the `"$schema"` line above — `$schema` is the one key that
is not a setting — and typos, wrong types and out-of-range values are flagged
as you type, before kragg ever runs.

**Malformed config is rejected, never defaulted.** Every setting is in one of
three states:

| | |
| --- | --- |
| **absent** | the default applies |
| **configured** | honoured exactly — including deliberate opt-outs such as `"layers": []`, `"forbidden_calls": {}`, `"coverage_fail_under": 0`, `"max_violations_per_gate": 0` (no cap), `"secret_baseline": null` and `"lint_tool": "off"` |
| **invalid** | exit **2**, no report, and a message naming the file and the setting: `kragg.json#forbidden_calls[1] must be a string (got 7)` |

Invalid means a wrong type (`"max_file_lines": "100"`), an out-of-range value
(a negative count, a coverage floor above 100), a wrong shape (a
`package.json#kragg` that is not an object), an element of the wrong type
inside a list (`"layers": ["src/cli", 3]`), a `forbidden_calls` hint that is
not a string, or a key kragg does not know (`forbiden_calls is not a kragg
setting (did you mean forbidden_calls?)`). None of these ever falls back to a
default: a ban list that silently reads as *no bans*, or a misspelled key that
silently configures nothing, is a project that believes it is protected and
is not. A malformed hint is rejected rather than repaired for the same reason
— the ban is never dropped, and the project learns about the mistake at the
one moment it can fix it.

## Differences from the Python sibling

Deliberate, and documented at each site:

| | |
| --- | --- |
| `forbidden-calls` | Built on `ts.TypeChecker`. Resolves subclasses, unannotated receivers and re-export chains — closes most of Python's documented limitations for this gate. |
| `nullable-default` | A redesign, not a port. `.get(k, default)` has no JS analogue; it targets `\|\|` mis-coalescing instead. |
| `complexity` | A `switch` scores **+1 total, not +1 per `case`** — measured evidence, see [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md). |
| `structure` | Counts real `export` declarations, and enumerates `export *`, rather than Python's leading-underscore convention. |
| `detect-secrets` | Bundles no scanner. Under `secret_scanner: "auto"`: gitleaks, else secretlint, else a visible skip. A scanner named in the policy is *required* — unavailable, or installed and crashing, is `error: true` and exit 3, never a skip. |
| `audit` | knip, which covers both vulture (dead code) and deptry (dependency hygiene). |
| criticality | Fingerprinted by a sidecar stamp — a content hash of the analyzed sources plus `kragg.json`, `package.json#kragg`, `tsconfig.json` and the resolved compiler — so stale call-graph data is re-derived rather than trusted. `criticality.json` itself stays byte-compatible with Python's reader. |
| criticality (top-20) | Python's `top_n=20` truncates the analysis, so its `criticality.json` — the input the criticality gates enforce on — never names more than twenty functions. Here twenty is a *display* limit on `CRITICALITY.md` and the terminal table only; the sidecar carries every ranked function, so the gates enforce on the whole eligible population. Same record shape, same ranking, more rows. |
| `criticality --path` | Scopes the printed table only. Combined with `--write` it is a usage error, where Python persists the scoped result — a partial `criticality.json` reads downstream as "everything else is uncritical". |
| `check --file` with `--changed`/`--since` | A usage error. Python silently prefers git's file set and discards the explicit list. |
| `check --file <missing>` | A usage error naming the path. Python runs the pipeline over a selection that matches nothing, which reads as a clean pass. |
| `--changed` after a config-only edit | Runs a **full** check and reports `mode: "full"`. Python resolves an empty Python-file selection and exits 0 without running a gate, even though the edit changed what every gate would conclude. |
| `--changed` when the only source change is a deletion | Runs a **full** check for the same reason. Python drops deletions from the selection and exits 0 with nothing checked. |
| `--changed` in a repository with no commit | Exit 3 with git's message. Both implementations ask `git diff HEAD`; Python (and kragg-ts before this) took the failure as an empty diff and silently checked only untracked files. |
| non-ASCII changed paths | Every git plumbing call is `-z`, so a path like `src/café.ts` survives. Python's `core.quotePath` output escapes it, the escaped name matches nothing on disk, and the file leaves the selection silently. |
| `secret_name_suffixes` | Includes `ServiceKey`, which Python's default list lacks. |
| pipeline halting | A **skip never halts** the slow tier or `--fail-fast`; only a gate that ran and did not pass does. Python branches on `not result.passed`, which counts a visible skip as a failure. |
| a gate that throws | Reported as that gate's `error: true` — the rest of the pipeline still runs and the consolidated report survives. Python lets the exception kill the process. |
| config validation | Python degrades a mismatched value to its default and ignores unknown keys; kragg-ts rejects both with exit 2, naming the setting. Strictly narrower: every config Python accepts *and reads as written* loads identically here. |
| criticality-dependent gates | Derived on demand when the data is missing or stale, so `critical-tests` and `test-quality` run; Python skips them visibly instead. |
| SessionStart hook | Emits the `hookSpecificOutput` envelope, which is what injects `additionalContext`; Python prints plain-text context lines. |
| hook output | Capped at 9000 characters with an in-band marker, because the harness spills longer output to a file the model never sees. Python does not cap. |
| test evidence | Python reads `.kragg/coverage.json` from a fixed path. kragg-ts gives every invocation its own `.kragg/runs/` directory, refuses anything incomplete, and hands `critical-coverage` the coverage in memory. Same gates, same wire format; only the provenance rule differs. |
| unmeasured critical functions | Python's `critical-coverage` passes a critical function the report never mentions (`measured=False`), reasoning that a missing entry is a measurement-key mismatch. kragg-ts hands the gate the document its own run wrote, so a missing file was never loaded: the function fails under the additive code `critical-unmeasured`, with the cause in the message. |
| coverage denominator | Python's `pytest --cov=src` instruments every file under `src`, loaded or not. The JavaScript runners report only what the run loaded, so kragg-ts reconciles the number against `source_paths` itself: unloaded files count as uncovered by their statement lines, and files outside the source paths do not count. |
| `// kragg: ignore` | Requires a reason: `// kragg: ignore -- <reason>`. A bare marker is not honoured and is reported on the finding it tried to hide. Python's `# kragg: ignore` needs none. |
| legacy-debt baseline | `kragg.json#baseline` plus `check --update-baseline` records accepted findings of the metric, structure and test-quality gates; they become `baselined:` advisories and new findings still fail. Python has no equivalent; no wire key is added. `brief` gains `## Suppressions` and `## Baseline`. |

Each row is pinned by a fixture or a unit test, and the full list — with the
`spec/SPEC.md` row it corresponds to — is in
[docs/spec-conformance.md](docs/spec-conformance.md).

## Supply chain

**One runtime dependency** (`typescript` — you cannot parse TypeScript without
the TypeScript compiler) and **one dev dependency** (`@types/node`), both
pinned to exact versions. No bundler, no test framework: `tsc` emits and
`node:test` runs.

Installs run with dependency lifecycle scripts disabled, no package may run a
build script, and a **30-day minimum release age** is enforced mechanically —
so a compromised version caught and unpublished within the usual window is
never installable here.

> pnpm v11 reads **only** auth and registry settings from `.npmrc`. Every
> behavioural setting must live in `pnpm-workspace.yaml` or it is silently
> ignored — which is worse than absent, because it creates false confidence.

The standing policy, and the list of deliberately-deferred candidate
dependencies, is in [docs/dependency-policy.md](docs/dependency-policy.md).
Read it before touching `package.json`.

## Honest scope

[KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md) states what each gate does **not**
catch, in detail. It is worth reading before trusting a green run.

The metric gates' thresholds are radon's and Python kragg's, ported onto a
language they were not drawn against.
[docs/calibration.md](docs/calibration.md) records what they actually do on
real TypeScript — violation rates, distributions, a per-finding precision
assessment and remediation cost, for a CLI, a Next.js app, a pnpm workspace and
the three scaffolds — and `scripts/calibrate.ts` re-derives the numbers on your
own projects. Nothing in that document changes a threshold; the proposals it
makes are marked as not applied, because moving one of these numbers is a
policy decision shared with the Python implementation.

The short version: kragg checks the properties a machine can check cheaply and
deterministically. It says nothing about whether the code does the right thing,
whether the architecture suits the problem, or whether the tests test the
behaviour that matters. A green `kragg check` means the floor held. It is not a
review.

## Development

Requires **Node 24** (see `.node-version`) and pnpm, pinned via corepack from
`package.json#packageManager`. The published package targets Node 20+; the dev
loop needs 24 because tests import `.ts` sources directly through Node's native
type stripping, with no build step.

```sh
pnpm install --ignore-scripts
pnpm run typecheck
pnpm run build
pnpm run test
pnpm run conformance             # the cross-language contract fixtures
node dist/cli.js check --all     # kragg checks itself

# measure the metric gates against real projects (see docs/calibration.md)
node scripts/calibrate.ts kragg-ts=. 'app=../some-app:src,lib'
```

`pnpm run conformance` is also part of `pnpm test`. The other half of the
contract — this repository's `dist/cli.js` run against the Python sibling's own
fixtures at a pinned commit — is in
[docs/spec-conformance.md](docs/spec-conformance.md#running-the-two-suites) and
in CI.

kragg-ts passes its own `check`. That is the point: a guardrails framework
whose own gates are red has no claim on anyone else's code.

`AGENTS.md` is the contract for agents working in this repository, including
the hard rules that are not open to interpretation.

## License

MIT © Torta Studios, LLC
