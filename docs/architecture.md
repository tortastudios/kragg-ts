# Architecture

165 modules and roughly 32,000 lines under `src/`. This document is the map of
the *ideas*; `AGENTS.md`'s Project Map is the map of the files. Read this one
first — most of the layout only makes sense once you know why the analysis is
split in two.

Five things explain nearly all of it:

1. [Two analysis tiers, because a type checker is expensive](#1-two-analysis-tiers)
2. [A linear layering the tool enforces on itself](#2-the-layering)
3. [The gate contract, and the three outcomes a gate may have](#3-the-gate-contract)
4. [How an external tool becomes a gate](#4-how-an-external-tool-becomes-a-gate)
5. [The cross-language contract, and its one translation point](#5-the-cross-language-contract)

---

## 1. Two analysis tiers

**This is the single biggest structural difference between kragg-ts and the
Python sibling, and it exists for one reason: in Python, `ast.parse` is free.**

In `crag`, twelve gates each doing their own walk costs nothing;
`gates/sources.py` shares the walk for consistency, not for speed. TypeScript
has no equivalent bargain. "Parse" is cheap, but "understand" — a `ts.Program`
with a type checker — reads the whole transitive file graph, every
`lib.*.d.ts`, and every `.d.ts` in `node_modules` the project touches, then
builds a checker. On a real repo that is **seconds**. Twelve gates each
building their own program is not a slow tool, it is an unusable one.

So the analysis is split, and the split propagates upward into the pipeline.

### The syntax tier — `src/analysis/sourceFile.ts`

`ts.createSourceFile` per file, no type information, no cross-file resolution.
One walk over the policy's source paths yields each file with what a
name-resolving gate needs: the module name, the local-binding→target import
table, and the raw lines (for `// kragg: ignore` and line-length checks). Built
from `walk.ts` (which files exist), `modulePath.ts` (path↔module arithmetic)
and `imports.ts` (the import table), all re-exported so no importer needs to
know which.

Gates on this tier: `complexity`, `maintainability`, `halstead`,
`type-complexity`, `structure`, `boundaries`, `typing-strictness`,
`secret-default`, and the test-depth gates' file walks.

One asymmetry worth knowing before you read `catalog/check.ts`: not every
syntax-tier gate accepts the `--changed` narrowing. `typing-strictness`,
`type-complexity` and `secret-default` take `ctx.paths`; `complexity`,
`maintainability`, `halstead`, `boundaries` and `structure` take
`policy.sourcePaths` and walk the whole tree regardless. `boundaries` has to —
a layering contract is a property of the import graph, not of a file — and the
metric gates simply have not been given the parameter.

A deliberate asymmetry with Python lives here too: `ast.parse` *raises* on bad
syntax, while `ts.createSourceFile` recovers and hands back a partial tree.
Analyzing that partial tree would produce violations pointing at code nobody
wrote, so `parseSourceFile` detects the parse diagnostics and skips the file —
matching Python's behaviour rather than the compiler's.

### The program tier — `src/analysis/program.ts`

One `ts.Program`, one `ts.TypeChecker`, for the whole run. Two properties, both
structural rather than optimizations to add later:

- **One per run.** The handle is memoized per tsconfig path, and
  `catalog/context.ts` additionally creates it once and hands the same object
  to every gate — so the sharing is a property of the pipeline, not an accident
  of a cache.
- **Lazy.** Construction happens on the first `load()`, never at handle
  creation. `kragg check --changed` over three files where no type-aware gate
  fires must not pay a millisecond of program cost, and does not.
  `handle.loaded()` exists so tests can assert exactly that.

Gates on this tier: `forbidden-calls` and `nullable-default` (which take the
handle directly), and `criticality`, which builds the call graph from it.

`load()` returns a discriminated union, not a throw. Every caller is a gate that
has to turn "I could not run" into a `GateResult` with `error: true` — an
exception would make the *normal* path the one needing a `try`/`catch`, and the
tempting wrong fix would be to swallow it and report a pass.

### Which compiler — `src/analysis/compiler.ts`

Both tiers get their compiler from `resolveTypeScript(root)`, which resolves
`typescript` from the **target project's** root the way the project's own code
would, and falls back to kragg's bundled copy only with a `note` that every
report surfaces. Analyzing a TypeScript 5 project with a TypeScript 6 compiler
produces confident results about a language the project is not written in.

This creates the rule that governs every gate in the repo:

> `ts.SyntaxKind` values, flag bitmasks and node shapes are internal to a
> compiler build and are **not stable across versions**. A node produced by the
> project's compiler must only ever be inspected by that same compiler's
> predicates. Gates call `resolution.api.isCallExpression(node)`, never
> `ts.isCallExpression(node)` from an import of their own.

`compiler.ts` holds the only value import of `typescript` in the codebase — for
the types and for the fallback instance. Everywhere else it is `import type`.

Two consequences that are easy to miss: loading the project's `typescript`
executes code from the project under check (a real trust boundary, and the same
one kragg already crosses by running the project's `tsc`); and a mixed run —
syntax tier on one compiler, program tier on another — would mean two
`SyntaxKind` numberings over one file set, which is why `catalog/context.ts`
takes `api` from the *same* resolution the program uses.

---

## 2. The layering

`src/` is a linear layering, declared in this repo's own `kragg.json` and
enforced on this repo by the `boundaries` gate. A module may import its own
layer or a **lower** one, never a higher one. Top to bottom:

```
src/index      src/cli        src/commands   src/hooks      src/catalog
src/gates      src/adapters   src/scaffold   src/coverage   src/analysis
src/environment  src/git      src/policy     src/util       src/engine
```

Reading it as a dependency direction: the CLI depends on commands, commands on
the catalog, the catalog on gates and adapters, gates on analysis, everything
on `engine`. `engine` — models, the gate runner, the report, the journal, the
one command runner — depends on nothing above it, which is what makes it
importable from the public API surface without dragging in a pipeline.

Three notes on the mechanics, all in `src/gates/architecture/`:

- **`import type` is still reported**, under its own code
  `layer-breach-type`. A type-only import emits no runtime edge, but a layering
  contract is about knowledge and coupling: a low-layer module that names a
  high-layer type has learned its shape, and the refactor that breaks one
  breaks the other. A project that weighs the two differently can, because the
  code differs.
- **Path aliases and barrels are followed**, not waved through. When an alias
  substitution cannot be confirmed against disk, candidates are compared by
  layer and genuine disagreement emits `layer-unresolved` — which says the
  contract was *not* checked. "Not checked" is not "checked".
- **A layering must be linear.** A genuine dependency cycle between two groups
  cannot be expressed, and the honest response is to leave the gate
  unconfigured rather than manufacture a green pass over a real cycle.

The catalog sits at the middle of this on purpose: it is the only place that
knows which gates exist, in what order, in which tier. Everything below it
answers one question; everything above it renders results. A second assembly
point is how `check` and a hook start enforcing different rules — which is why
`kragg security` is built from the *same* factories as `kragg check`
(`catalog/security.ts`) rather than being a second list that can drift.

---

## 3. The gate contract

### `GateSpec` — `src/engine/gate.ts`

```ts
interface GateSpec {
  readonly name: string;                              // wire-visible
  readonly tier: "fast" | "slow";
  readonly run: () => GateResult | Promise<GateResult>;
  readonly skipReason?: string | undefined;           // skip unconditionally
}
```

That is the whole contract. A gate is a name, a tier, and a thunk. It knows
nothing about reports, exit codes, JSON, or the other gates; `runGates` times
it and collects the result.

### `runGates` semantics

Three rules, ported from `check.py` unchanged, in the order `skipReasonFor`
applies them:

1. **`failFast` halts.** Every remaining gate is reported as skipped with
   reason `fail-fast` — *reported*, not omitted, so the report still accounts
   for the whole pipeline.
2. **A `skipReason` on the spec wins** over the tier rules. This is how an
   unconfigured gate skips.
3. **SLOW gates skip once any FAST gate has failed**, with reason
   `static gates failed`, unless `forceSlow` (`--all`).

And the rule that is not in the code because it is the *absence* of code:
**every FAST gate runs even after one fails.** One invocation reveals every
failure, so an agent never re-runs to discover problem #2. SLOW gates skip
because their results would be invalidated by the fixes anyway.

The pipeline is sequential, deliberately, so it can be diffed against the
Python implementation. `gate.ts` carries a `TODO(concurrency)` explaining that
parallelising within a tier is a behaviour change (it moves `durationMs` and
output interleaving), not a refactor.

### The three-state outcome, and why it cannot become two

Beyond the trivial pass (`passed: true`, nothing found), a gate result is one
of three things, and they are three different facts:

| Outcome | `GateResult` | Exit | Means |
| --- | --- | --- | --- |
| findings | `passed: false` | 1 | it ran, and here is what it found |
| visible skip | `skipped: true`, `skipReason` set | 0 | it deliberately did not run |
| could not run | `error: true` | 3 | it *tried* and could not |

**Collapsing skip into pass would defeat the entire design.** A `boundaries`
gate with no layers declared has checked nothing. Printing `[PASS] boundaries`
for it teaches everyone reading the output that the project's layering is
enforced — and it is not. The Python sibling states the rule in a one-line
docstring that `catalog/context.ts` quotes verbatim: *"Unconfigured
policy-driven gates SKIP visibly, never PASS silently."* Every skip reason also
names the command that un-skips it, because a skip that does not say how to
un-skip itself trains people to ignore skips.

Collapsing "could not run" into either is worse. `error: true` drives exit 3,
which **outranks** exit 1: when a gate could not run, the other findings are
about a project that was only partly checked, and reporting the run as merely
"failing" understates that. A missing test runner must never render identically
to a passing test suite.

There is exactly one place in the codebase that deliberately fails **open**:
`src/hooks/claude.ts` returns 0 on any internal failure, because it runs inside
somebody's editing session on every edit and a broken guardrail must not become
a broken editor. The check it invokes stays fail-closed; only the delivery
fails open, and the module says so in capitals.

### Where the criticality cache fits

`critical-tests`, `test-quality` and `critical-coverage` read
`.kragg/criticality.json`. Python skips them when the file is absent; kragg-ts
**derives** instead — `ctx.criticality.ensure()` is called from inside each
gate's `run` closure, so a run that never reaches those gates never builds a
call graph, and a repo that has never run `kragg criticality --write` still
gets the gates. Staleness is checked before the file is believed, via a sidecar
fingerprint; see `src/gates/criticality/freshness.ts` and
[spec-conformance.md](spec-conformance.md) for why the fingerprint is a
separate file.

---

## 4. How an external tool becomes a gate

kragg bundles no linter, no test runner, no auditor, no secret scanner. The
Python sibling bundles ruff and can assume the linter exists; neither
assumption survives the move to npm, where three linters are in real use and
none is the obvious one to impose.

Four steps, each with a failure mode it exists to prevent.

### Step 1 — resolve the binary from the *project's* tree

`resolveBin` (`src/environment/bin.ts`) looks only in a `node_modules/.bin`
belonging to the project. **Never `PATH`, never a global install, never
kragg's own tree.** A globally-installed `tsc` of a different major silently
type-checks the project against the wrong compiler and reports pass/fail that
does not reproduce in CI.

Three details that are load-bearing:

- The **ancestor walk is bounded**. Node's own resolution walks to the
  filesystem root, which would let a stray `~/node_modules/.bin/tsc` satisfy a
  lookup. The walk stops at the first git root or pnpm workspace root, never
  leaves `$HOME`, and never passes `/`. Walking ancestors at all is necessary
  because pnpm and npm workspaces hoist most binaries to the workspace root.
- **Symlinks are resolved and the real path is contained-checked.** `.bin`
  entries are symlinks under most layouts, so a containment check on the link
  rather than its target checks nothing.
- `null` becomes an `error: true` result with an install command from
  `remediation()` — exit 3, not a false pass.

### Step 2 — decide whether absence is a skip or an error

The rule is in `src/adapters/lint.ts`, and it follows from "an explicit
override outranks inference, and an override we cannot honour is an error":

- `lint_tool: "auto"`, nothing installed → **skip**. The project never asked
  for a linter. Erroring would make kragg unusable in a repo that lints
  elsewhere.
- `lint_tool: "oxlint"`, oxlint not installed → **error, exit 3**. The project
  named a linter. Quietly not running it leaves the project believing it is
  linted when it is not.
- `lint_tool: "off"` → **skip**. A deliberate opt-out.

### Step 3 — parse the tool's own machine-readable output

Each adapter parses the format the tool documents: oxlint's miette-derived
JSON, biome's `--reporter=json`, ESLint's `LintResult[]`, npm/pnpm/yarn/bun
audit shapes, knip's reporter, istanbul's `coverage-final.json`, lcov
tracefiles, TAP from `node --test`, Stryker's `mutation-testing-elements`
report. Schemas were verified against each tool's source, not from memory, and
they are pinned to versions that **will drift** — so an unrecognised envelope
is `error: true`, never a green gate.

Normalization is the point: `src/coverage/model.ts` is the one line-coverage
model that both istanbul JSON and lcov are reduced to, so
`critical-coverage` has one shape to reason about regardless of which runner
the project uses.

### Step 4 — distinguish "the tool crashed" from "the tool found problems"

**For most tools this cannot be done from the exit code alone**, and getting it
backwards reports a crashed scanner as a clean repo.

- **oxlint and biome** map "found lint errors" and "your config is invalid" to
  the same failure code. The exit code is useless as a discriminator, so the
  *envelope in the JSON output* decides, and a missing envelope is a tool
  failure.
- **ESLint** is the exception that is shaped like ruff: it has a distinct fatal
  exit code, so exit-code classification works.
- **gitleaks** defaults to exit 1 for findings *and* exit 1 for a failed scan
  (`cmd/root.go`'s `findingSummaryAndExit`). kragg passes a distinctive
  `--exit-code` so the two become disjoint: that code means findings, `0` means
  clean, anything else means the scanner broke.
- **Absence of the binary itself** is detected textually, not by exit code, in
  `src/environment/missing.ts` — `spawn X ENOENT`, `command not found`,
  `Cannot find module` and the Windows and shell variants — because that
  distinction decides exit 3 versus exit 1.

`src/adapters/support/outcome.ts` is where the four "could not run" kinds live,
and it is worth reading in full: `not-configured` → visible skip,
`missing-tool` → error with an install command, `crashed` → error with the
tool's own output attached, `offline` → error, because a vulnerability scan
that could not reach the advisory database has cleared nothing. Telling someone
to reinstall a tool that is plainly installed wastes the cycle the message was
supposed to save.

One more constraint the adapters carry: **output is a budget.** Violations are
deduplicated and capped per gate (`max_violations_per_gate`, default 25) with
`violation_count` preserving the true total, and the secret scanners copy an
*allowlist* of fields out of their reports — five, for gitleaks — so a field a
future release adds cannot leak a credential value into a report an agent will
paste somewhere.

And one asymmetry between the two external checkers, which is the whole reason
`adapters/tsc.ts` takes `ctx.paths` and `adapters/lint.ts` takes `ctx.targets`:
**a linter is per-file and a type checker is not.** `--changed` hands the
linter a shorter file list and gets the same answer faster. Handing `tsc` one
would be wrong twice over — `tsc a.ts b.ts` ignores `tsconfig.json` entirely,
and a program is a whole-program fact, so the error an edit to `a.ts` causes is
usually in the unchanged `b.ts`. So `tsc` always compiles the whole project
through its own config, and the selected files are only an **order**: file-less
diagnostics first, then the selection, then everything else, with the budget
above deciding what the cap keeps. It used to be a *filter*, which dropped
exactly the caller's error and printed `[PASS] tsc` for a change that broke it.



### Everything spawns through one place

`src/engine/runner.ts` is the only module that may import `node:child_process`.
It passes an argv array with `shell: false`; no string concatenation, no
`exec`. This is enforced, not merely stated: `kragg.json` bans
`node:child_process` via the `forbidden-calls` gate, and `runner.ts` carries
the single `// kragg: ignore` exemption, visible in review rather than hidden
in a config allowlist. kragg dogfooding its own security-contract mechanism is
the point.

---

## 5. The cross-language contract

kragg-ts and kragg-Python share **no code**. They share a wire format, so a CI
job or an agent can consume either without knowing which ran:

- the report JSON at `schema_version: 1`, snake_case keys, `null` rather than
  absent;
- exit codes 0/1/2/3, with 3 outranking 1;
- the fast/slow pipeline semantics described above;
- `.kragg/history.jsonl`, append-only, one entry per run;
- `.kragg/criticality.json`, a list of profile records;
- the `kragg hook claude` stdin/stdout protocol.

Internally, domain types are camelCase plain `interface`s — never classes, so
every value is JSON-serializable and structurally cloneable, with behaviour in
free functions. The wire format is snake_case.

**The translation happens in exactly one module: `src/engine/reportPayload.ts`.**
It holds the four payload interfaces and the one function, `toPayload`, that
fills them. That is deliberate — a reviewer can read the entire contract with
the Python implementation without reading any of the report machinery around
it, and there is exactly one file to diff against `crag/src/kragg/report.py`.
`report.ts` (dedupe, caps, exit codes) and `reportRender.ts` (text and JSON
output) sit beside it and re-export it; `journal.ts` writes its snake_case
entry from the payload rather than from the domain objects, so it cannot drift
either.

If you change a field name there, you have changed both repos. See
[spec-conformance.md](spec-conformance.md).
