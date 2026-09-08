# Known limitations

kragg raises the floor. It does not make any bug class impossible to ship
green, and it is not a substitute for review. These are the honest boundaries
of the gates — read them before trusting a green run to mean more than it does.

This file is the TypeScript sibling of the Python implementation's
[`KNOWN_LIMITATIONS.md`](https://github.com/tortastudios/crag). Where a limit
is shared, it says so; where TypeScript closes one Python has, it says that
too, because the two tools are not interchangeable in either direction.

## The shape of what follows

Every gate here answers a narrow, mechanical question. A gate is useful
because its answer is *reliable*, not because it is *complete*. The failures
worth fearing are the ones where a gate reports green over something it never
looked at, so those are listed first for each gate.

---

## Security contracts match names and types, not behaviour

`forbidden-calls` and `secret-default` enforce contracts a human stated. They
do not discover the contracts, and they cannot reason about intent.

### `forbidden-calls`

TypeScript's `ts.TypeChecker` makes this gate materially stronger than the
Python original, which resolves names heuristically and gives up on
unannotated receivers. **Resolved here, unresolved in Python:** subclass and
`implements` overrides, re-export chains (via `getAliasedSymbol`), receivers
with no annotation (`make().body()`, `this.body()`), optional chains, `new`,
tagged templates, and calls on an awaited dynamic `import()`.

What it still cannot see:

- **`any` and `unknown` receivers.** If a value is typed `any`, the checker
  has nothing to resolve and the call is skipped — never guessed. Strict
  typing (which `typing-strictness` enforces) is what keeps this gate honest;
  the two are load-bearing for each other.
- **Package subpaths collapse into the package namespace.** `foo` and
  `foo/server` resolve to one namespace, so a ban on a specific subpath is
  **not expressible**. Ban the package or a named export within it.
- **Anonymous structural types** have no name to ban a member by.
- **Computed keys** the checker cannot fold, `import("...")` itself, bare
  decorators, and JSX are skipped.
- The suppression marker (`// kragg: ignore`) is per-site and unconditional.
  It is meant to be visible in review; nothing checks that it is still
  warranted.

### `secret-default`

Matches the configuration idiom, not data flow. It covers `process.env.X`
(with `??`, `||`, and bracket access), `Bun.env`, `import.meta.env`,
`Deno.env.get`, destructuring defaults, string-literal fields and class
properties, parameter defaults, object-literal properties, and
`z.string().default("")`.

- **No taint analysis.** `config.apiToken ?? ""` on an arbitrary object is out
  of scope, because kragg cannot tell a config object from any other object.
- **Name-based.** A secret whose name matches no configured suffix is
  invisible; a non-secret that happens to match is a false positive, to be
  suppressed with `// kragg: ignore` rather than by narrowing the policy.
  `secret_name_suffixes` deliberately excludes a bare `Key` (`sortKey`,
  `cacheKey`) and deliberately includes `ServiceKey`, which the Python default
  list still lacks.
- `z.string().catch("")` is **not** recognised. Only `.default`, because
  anything wider would be guessing.

### `detect-secrets` bundles nothing

kragg-ts ships no secret scanner. Under the default `secret_scanner: "auto"`
it uses **gitleaks** if it is on `PATH`, else **secretlint** if the project has
it, else it **skips visibly** with both install commands. Naming one in the
policy instead makes it **required**: unavailable, too old, or installed and
crashing is `error: true` and exit 3, never a skip and never the other tool.

This is deliberate. A scanner is only as good as its rule set, and a
hand-rolled one reporting "clean" produces the same green as a genuinely clean
repo — false confidence is worse than an acknowledged gap. Consequences:

- **A project with neither tool installed gets no secret scanning at all.**
  The skip says so, loudly, but it is a skip.
- Scanning is **worktree-only**, not git history. A committed secret is an
  incident, not a gate you can edit green; history scanning belongs in CI.
- Secret **values are never** put into a violation, by allowlist rather than
  denylist — only rule id, description, file and line survive. A field added
  by a future gitleaks release cannot leak through.

---

## Unmodeled nullability is invisible to static gates

Shared with Python, and unchanged by the port.

`typing-strictness` and `nullable-default` close the common, *modeled* cases.
They do not close the class.

- **A genuinely nullable value modelled as non-null still ships green.** If an
  API field can be `null` but you type it `number`, `tsc` is satisfied and
  nothing here objects. Only a runtime schema that validates the payload
  **plus** a test that feeds `null`/missing actually catches it, and kragg can
  enforce neither. It can only require the typing floor that makes the
  modelling honest.
- **`JSON.parse` returns `any`, and `any` defeats the checker.** This is the
  single largest hole in the TypeScript type story and no static gate closes
  it. Validate at the boundary.

### `nullable-default` is deliberately narrow

Python's gate targets `d.get(k, default)`, an idiom JavaScript does not have.
This is a **redesign, not a port**: it targets `||` mis-coalescing, where a
legitimate `0`, `""` or `false` is silently replaced by a fallback.

It fires only when all of these hold: the operator is `||` (never `??`, which
is the fix); the fallback is a literal; the fallback is truthy and numeric or
boolean; the checker confirms the left type is nullable *and* contains the
matching falsy member; and the site is a value position.

Measured on ~380 real files: **0 hits, 0 false positives.** Relaxing rule 3 to
accept string fallbacks yields **31 hits**, almost all intended
(`accountType || "self_serve"`). That is the noise level at which a gate gets
switched off, and a disabled gate protects nothing. The gate is calibrated
*below* the Python original's hit rate on purpose.

Re-measured 2026-09-08 on a wider corpus (`docs/calibration.md`): **0 findings
across 2,038 candidate sites** — 1,049 `||`/`||=` sites and 989 arithmetic sites
in two real applications, plus kragg-ts itself. Stated plainly: **this gate has
never fired on real code**, so its precision in production is undefined and its
recall is unproven. What is proven is that it *can* fire — `test/fixtures/
knownDefects.ts` holds one site for each rule and `test/knownDefects.test.ts`
fails if either stops being reported.

So: it misses far more than it catches, by design. It is a high-precision
probe, not a safety net.

---

## `typing-strictness` audits configuration, not types

It verifies that the type checker is strict and has not been muzzled. It
performs no inference of its own.

- **Only `<root>/tsconfig.json`.** Per-package configs in a monorepo and
  non-root names (`tsconfig.app.json`) are **not** audited.
- **Solution-style builds are not audited.** When the root config has
  `references`, the `include`/`exclude` audit reports an advisory and stops,
  because auditing a solution config would flag every file in the repo. A
  stated skip, not silence — but a skip.
- **`.d.ts` files are not scanned**, so a hand-authored declaration file full
  of `any` is invisible to both this gate and `type-complexity`.
- `Function` and `object` are matched **by name**, not through the checker.
- The `{}` type is not flagged.
- Advisory findings (`skipLibCheck`, non-null assertions, internal `any`) are
  reported on a **separate channel** from violations: they print under the gate
  in text output, appear as `advisories` / `advisory_count` in JSON, and are
  read by nothing that decides pass/fail or the exit code. An advisory that
  changed the verdict would just be a violation with extra steps. They are
  information, and it is on you to weigh them — nothing forces the issue.

What it *does* close, which Python does not: since the `include`/`exclude`
audit landed, a source file that no tsconfig covers is reported
(`unchecked-source`). Before that, a project could exclude an entire directory
from type checking and this gate still reported green.

---

## Complexity metrics are calibrated for Python, ported to TypeScript

`complexity`, `maintainability` and `halstead` reimplement radon's formulas
over the TypeScript AST, because no radon exists for TypeScript and kragg-ts
takes no dependencies. **The grade bands and thresholds are Python's**, and
they were never tuned for a language that spends more tokens per unit of
logic.

Measured on real code:

- **Maintainability ports cleanly.** TypeScript lands *above* Python here.
- **Cyclomatic complexity needed one adjustment.** A `switch` scores **+1
  total, not +1 per `case`** — a deliberate divergence from McCabe, radon and
  the Python sibling, made on measured evidence (per-case failed 5% of blocks,
  the worst offenders being flat dispatch tables that no reader experiences as
  complex). The cost, stated plainly: **a `switch` can now hide arbitrary
  breadth from this gate.** The `structure` gate's budgets bound that instead.
- **Halstead thresholds are not the same gate in the two languages.** Radon's
  worst effort across the entire Python implementation is 446 against a 50,000
  limit — that gate has never fired and mathematically cannot. Ported
  literally onto TypeScript's wider operator/operand partition it fires on
  roughly 0.3–0.6% of blocks. The numbers are the same; the gates are not
  equivalent, and nobody should read them as such.

`logicalLines` is our definition, not radon's (which infers logical lines from
`:`/`;` tokens). It is exact rather than heuristic, but it is a translation,
and the MI formula is sensitive to it.

### Constructs that inflate a metric

Measured across two real applications and a pnpm workspace (472 application
files, 3,025 blocks, 3,099 annotation sites) in
[`docs/calibration.md`](docs/calibration.md), which carries the full tables,
the per-finding precision assessment and the method. The limits below are the
ones a reader needs before trusting a number.

- **`??` and `?.` have no radon equivalent and supply 12–19% of every
  TypeScript cyclomatic score.** Counting them is defensible — `a?.b` is a real
  edge in the control-flow graph — but it means the *ported* band is
  systematically tighter here than in Python, by roughly one grade step's worth
  of points. A short function full of narrowing idioms (`typeof x ===
  "string" && x`, `?? 0`, ternary fallbacks) can grade C on 15 lines.
- **In React, roughly a third of a cyclomatic score is markup.** 31.5% of the
  decision points in the Next.js sample sit inside JSX: `{cond && <Row/>}` and
  `{a ? <X/> : <Y/>}` are conditional *rendering*, not control flow. 69% of
  that sample's complexity failures depended on JSX-resident operators or on
  `??`/`?.`; in the less React-heavy workspace only 21% did. **The gate's
  firing rate varies with how much of a project is JSX**, which is not a
  property of its complexity.
- **Halstead counts static JSX as operators and operands.** The worst Halstead
  offender in the whole corpus is a 1,175-line marketing page with 472 JSX
  elements and **cyclomatic complexity 1** — effort 12× the ceiling, estimated
  bugs 15× it, and nothing to fix. 90% of the Next.js sample's worst effort and
  bugs findings are in `.tsx` files. Halstead was defined over imperative code;
  markup embedded in the expression grammar is outside anything it was
  validated against.
- **A Halstead block includes its nested closures; its cyclomatic score does
  not.** That asymmetry is radon's and is preserved deliberately, but it bites
  far harder in TypeScript, where closures are the dominant idiom. A React hook
  or component is a thin shell around many `useEffect`/`useCallback` bodies, so
  the shell is charged for all of them at once and reads as difficulty 65 while
  the complexity gate grades it A. **When the two gates disagree loudly about
  the same function, this is usually why**, and the message does not say so.
- **Estimated bugs is the binding Halstead ceiling in TypeScript**, not effort.
  `bugs = volume / 3000` trips at volume > 1,200 — about a screen of JSX — and
  fired 1.9× as often as effort across the corpus. It is a pure size proxy,
  duplicates effort's signal at a lower bar, and carries most of the static-JSX
  false positives.
- **`maintainability` is a size gate in disguise, and its recall is low.** Five
  findings across 472 application files, all five true positives, all five on
  files of 486–1,386 lines. Measured on comment-free code of uniform shape, the
  A/B boundary sits near **180–200 logical lines**; a well-commented file can
  carry twice that and still grade A, because the `+50*sin(...)` comment term is
  worth up to 50 points before normalizing.
- **`type-complexity` is bound by length, not depth, by about an order of
  magnitude.** 210 length-only failures against 18 depth-only ones across both
  applications; 58–70% of all annotations are depth 0. The dominant single class
  is React props declared as an inline object type on a destructured parameter
  (56 of the 60 worst findings in the Next.js sample). Those are true positives
  by the gate's own contract — the fix is a named `Props` interface, and it
  takes a minute — but a React project should expect this gate to talk mostly
  about that one idiom.
- **The type-aware tier sees one tsconfig, so a workspace is partly
  unmeasured.** The pnpm workspace sample has no root `tsconfig.json`: pointed
  at one package's config, the program held **189 files against the 309** the
  syntax tier walked, and `resolveTypeScript` fell back to the **bundled**
  compiler because a workspace root has no hoisted `typescript`. A clean
  `nullable-default` result on a monorepo is clean over the program, not over
  the repository. Run kragg per package there.

Precision, from reading the code behind a sample of findings: `type-complexity`
7 true positives / 0 false positives; `maintainability` 5/0 (its whole output);
`complexity` 6 true / 2 arguable / 0 false; `halstead` 3 true / 3 arguable / 1
false. `nullable-default` produced **no findings at all** across 2,038 candidate
sites, so its precision on real code is undefined — see below.

---

## Architecture gates are name- and path-based

### `boundaries`

- **Path aliases** are resolved from `tsconfig.json` `paths`/`baseUrl`,
  extension-probed against disk. When a substitution cannot be confirmed,
  candidates are compared by layer; genuine disagreement emits
  `layer-unresolved`, which says the contract was **not** checked. Nothing
  alias-shaped is silently waved through — but "not checked" is not "checked".
- Only `<root>/tsconfig.json`. No monorepo walk, no package `exports` maps, no
  bundler aliases.
- **Barrel chains are followed** name-aware and depth-capped, but only
  index-named files count as barrels, and unresolvable re-export targets are
  dropped silently.
- A bare specifier prefixed by a declared layer (`import ... from
  "src/services/x"`) is treated as that module even with nothing on disk
  confirming it. The risk is a published package colliding with a layer
  prefix — unlikely, but it is a heuristic.
- **`import type` is reported** under a distinct code (`layer-breach-type`), on
  the view that a layering contract is about coupling and knowledge, not just
  emitted code. A project that disagrees can weigh that code differently.
- **A layering must be linear.** A genuine dependency *cycle* between two
  groups cannot be expressed, and the honest response is to leave the gate
  unconfigured rather than manufacture a green pass over a real cycle.

### `structure`

- `export *` **is** enumerated, including through chains, so the symbol budget
  cannot be ducked by starring through another module. Unresolvable stars are
  reported (`symbol-budget-unresolved`) and the count is stated as a lower
  bound rather than silently treated as zero.
- The file-line budget counts **total** lines, comments included. Dense
  documentation costs budget. That is intentional — a 900-line file is hard to
  hold in your head regardless of what the lines contain — but it means
  well-documented modules split earlier than terse ones.
- `structure_exclude` exempts a file from **both** budgets and nothing else.
  Each entry should carry a comment earning its place.

---

## Test-depth surfaces are heuristics about tests

### `test-quality`

- A test is recognised by **name** (`it`, `test`, `describe`), not by import,
  because all three supported runners expose them as globals.
- Assertions are recognised by shape: a root `expect`/`assert`, a chain
  segment named `assert`/`expect`, a chain ending in a name starting with
  `assert`, or an identifier imported from `node:assert`. **A helper imported
  from another file is not followed**, so a test whose only assertion lives in
  a shared helper module is a false positive. Local helpers *are* followed,
  transitively.
- `critical-untested` asks only whether a test **references** the function. It
  cannot tell a real test from `assert.equal(typeof f, "function")`. The gate
  is a floor, and a trivially gameable one.

### `critical-coverage` and `kragg coverage`

- Coverage is a **line** model. A never-taken branch sharing a line with a
  taken one is invisible (`if (broken) fix();`) — that is `branchMap` data,
  not line data.
- Under **lcov** (which `node --test` and `bun test` emit), `FN:` records
  state where a function begins but not where it ends. The extent is read from
  the *source* instead — a fact, not an inference. When neither the report nor
  the source can bound a function (an ambiguous simple name bound twice in one
  file), it is reported **unmeasured, never clean**.
- Two same-named functions in one file are treated as unmeasured rather than
  unioned, because unioning would blame `Reader.close` for `Writer.close`'s
  gaps. A real recall gap, chosen over a wrong answer.

### `critical-tests` and criticality data

- The call graph resolves through the checker and **never guesses**. A call
  through an *interface*-typed receiver resolves to the signature, not to any
  implementation, so no edge is drawn. Python has the identical blind spot.
- Classes declared inside a function body do not register their methods.
- **Stale criticality data is now detected**, via a sidecar
  `.kragg/criticality.stamp.json` fingerprint (file count, total bytes, newest
  mtime over the policy's source and test paths), and re-derived rather than
  trusted. Before that, splitting a module changed every qualified name and
  `test-quality` reported 35 findings when the truth was 2.
  - The stamped walk follows the **policy's** paths, not the tsconfig's
    `include`. A file checked by tsc but outside `source_paths` does not
    invalidate the stamp.
  - `kragg map`, the Claude hook's SessionStart, and the check pipeline all
    derive through the same memoized cache, so all three agree by construction
    about what is critical and about when the answer has gone stale. A
    derivation that fails inside the hook costs the criticality section and
    nothing else — the hook's fail-open contract outranks completeness.

---

## Adapters depend on external tools' output formats

Every external tool adapter (`lint`, `tsc`, `test-coverage`, `audit`,
`audit`'s dead-code sweep) parses another project's output.

- **Schemas were verified against each tool's source**, not from memory —
  oxlint's fork of miette, biome's JSON reporter, ESLint's `LintResult[]`,
  npm/pnpm/yarn/bun audit shapes, knip 5 and 6, Stryker's report schema. They
  are pinned to the versions current at the time of writing and **will drift**.
- Drift **fails safe**: an unrecognised envelope produces `error: true` (exit
  3), never a green gate. But an adapter that errors is an adapter that is not
  checking anything.
- **biome's JSON reporter is self-declared experimental** ("may change in
  patch releases"). It is the highest schema risk of the three linters.
- No adapter has been run against a live binary in CI. Parsers are validated
  against recorded fixtures.

### Specific to `mutation`

- **Stryker has never been executed end to end.** Argv construction and report
  parsing are verified against Stryker's source; the handshake is not.
- Stryker's JSON report path is **not settable from the CLI** — only via config
  file — so kragg reads `jsonReporter.fileName` out of the project's own
  config, replicating Stryker's discovery order, and falls back to the default
  with a printed note.
- Stryker already excludes type-only syntax (`isTypeNode` → `path.skip()`), so
  kragg adds no annotation filter. A consequence: expressions inside an `as`
  cast are never mutated.
- `@stryker-mutator/tap-runner` is named as the `node --test` plugin but has
  not been confirmed to drive it cleanly. **Bun has no Stryker plugin at all.**

---

## Scaffolding

- `kragg new` templates for **hono**, **fastmcp** and
  **@modelcontextprotocol/sdk** are **not compile-verified**. Package existence
  and versions were checked against the registry; the API surfaces used
  (`new FastMCP({...})`, `addTool`, `McpServer.registerTool`,
  `StdioServerTransport`, `serve({fetch, hostname, port})`) are the documented
  shapes but were not executed. **The first `pnpm install` in a scaffolded
  project is the verification step.**
- The generated `tsconfig.json` **is** verified: a test scaffolds each kind and
  runs `typing-strictness` against it, asserting zero violations and zero
  advisories.
- The MCP test does not drive an MCP client; it exercises the tool through the
  service the tool delegates to.
- `kragg` is deliberately absent from generated `devDependencies` while this
  package is unpublished, since pinning a nonexistent version would break the
  first install.

---

## Shared with the Python implementation

These are bugs or gaps in **both** tools:

- **git path quoting.** With `core.quotePath` on (the default), a non-ASCII
  filename is returned escaped, fails the existence check, and is dropped, so
  `--changed` under-reports. Fixing it means `-z` + NUL splitting in both
  implementations at once, or they stop being conformant.
- `changedFiles` returns paths relative to the **repo root**, not to the
  analysis root, when the root is a subdirectory of the repository.
- **Windows** is untested. `resolveBin` returns a `.cmd` shim, which
  `execFile` cannot spawn without a shell, and `runCommand` never uses one.

## Found in the Python implementation during this port

Reported here because a polyglot repo will hit them; they are **not** fixed in
kragg-Python as of this writing.

1. `_get_int` accepts booleans (`isinstance(True, int)` is `True`), so
   `coverage_fail_under = true` silently becomes a **1% floor**.
2. The `halstead` gate has never fired and mathematically cannot (see above).
3. `secret_name_suffixes` lacks `_service_key`.
4. A **stale** `.kragg/criticality.json` is consumed as if current; the gate
   skips only when the file is absent.
5. `run_gates` counts a SKIP as a failure (`check.py`: `if not
   result.passed`), because a visible skip is `passed=False, skipped=True` —
   so one gate that steps aside from inside its own run skips the entire slow
   tier with `static gates failed`, and the run still exits 0. kragg-ts
   follows `spec/SPEC.md` §2.3/§4.1 instead: only a gate that ran and did not
   pass halts anything.
6. `run_gates` has no `try` around `spec.runner()`, so an exception inside a
   gate kills the process and the consolidated report is never produced.
   kragg-ts turns it into `error: true` for that gate — §4.3's outcome for a
   gate that could not run — and finishes the pipeline.

---

## What none of this covers

kragg checks the properties a machine can check cheaply and deterministically.
It says nothing about whether the code does the right thing, whether the
architecture suits the problem, whether the tests test the behaviour that
matters, or whether a dependency should be there at all.

A green `kragg check` means the floor held. It is not a review.
